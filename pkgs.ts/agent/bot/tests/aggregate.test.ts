// 意图测试：只通过 Agent 聚合对话（send / post / cancel / compact / history），
// 不穿透到 store / 投递装配 —— 这正是 `docs/plans/2026-11-07-agent-aggregate.md` §6 要的形状。
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgent, type AgentPorts } from '../src/aggregate.js'
import { filePersist } from '../src/persist.js'
import { llmPorts } from '../src/model-ports.js'
import { createAgentHost } from '../src/agent-host.js'
import type { BotConfig, BotStore } from '../src/types.js'
import type { WireMessage } from '../src/protocol.js'

/** 假 LLM：按顺序回话；可配置延迟，用来观察「运行中」的行为 */
function fakePorts(opts: { replies?: string[]; delayMs?: number } = {}): AgentPorts & { calls: string[][] } {
  const replies = [...(opts.replies ?? ['回答'])]
  const calls: string[][] = []
  let n = 0
  return {
    calls,
    async *complete(messages) {
      calls.push(messages.map((m) => m.content))
      if (opts.delayMs !== undefined) await new Promise((r) => setTimeout(r, opts.delayMs))
      yield replies[Math.min(n++, replies.length - 1)]!
    },
  }
}

const waitIdle = async (a: ReturnType<typeof createAgent>, ms = 1000): Promise<void> => {
  const t0 = Date.now()
  while (a.snapshot().running && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5))
}

describe('Agent 聚合：压缩', () => {
  it('压缩后 history 的第一条是 checkpoint，且覆盖被折掉的区间', async () => {
    const a = createAgent({ ports: fakePorts({ replies: ['答1', '答2', '答3'] }) })
    for (let i = 1; i <= 3; i++) {
      await a.send({ content: `问题${i}` })
      await waitIdle(a)
    }
    expect(a.history().filter((e) => e.kind === 'message')).toHaveLength(6)

    const r = await a.compact({ kind: 'keepTurns', turns: 1 })
    expect(r.accepted).toBe(true)

    const raw = a.history({ raw: true }).filter((e) => e.kind === 'message')
    const h = a.history()
    expect(h[0]!.kind).toBe('checkpoint')
    // 条目与事件共用一个 seq 空间（一次顺序），所以区间端点取被丢那几条的真实 seq
    expect(h[0]!.shadowed).toEqual({ fromSeq: raw[0]!.seq, toSeq: raw[3]!.seq })
    // 原始日志仍完整（UI 要画删除线时用 raw）
    expect(raw).toHaveLength(6)
    // 保留最近 1 轮 = 2 条消息
    expect(h.filter((e) => e.kind === 'message')).toHaveLength(2)
  })

  it('压缩后下一轮请求里，第一条不再是被折掉的旧问题', async () => {
    const ports = fakePorts({ replies: ['答1', '答2', '答3', '答4'] })
    const a = createAgent({ ports })
    for (let i = 1; i <= 3; i++) {
      await a.send({ content: `问题${i}` })
      await waitIdle(a)
    }
    await a.compact({ kind: 'keepTurns', turns: 1 })
    await a.send({ content: '问题4' })
    await waitIdle(a)

    const lastCall = ports.calls[ports.calls.length - 1]!
    expect(lastCall).not.toContain('问题1')
    expect(lastCall).not.toContain('问题2')
    expect(lastCall).toContain('问题3')
  })

  it('没有可压的历史 ⇒ accepted=false 且给原因（不静默成功）', async () => {
    const a = createAgent({ ports: fakePorts({ replies: ['答1'] }) })
    await a.send({ content: '只有一轮' })
    await waitIdle(a)

    const r = await a.compact({ kind: 'keepTurns', turns: 1 })
    expect(r.accepted).toBe(false)
    expect(r.error?.code).toBe('compact/nothing-to-drop')
  })
})

describe('Agent 聚合：调度语义', () => {
  it('运行中 post 的 job 完成立即进状态，但不打断当前 run', async () => {
    const ports = fakePorts({ replies: ['长任务答'], delayMs: 60 })
    const a = createAgent({ ports })
    const sending = a.send({ content: '长任务' })
    await new Promise((r) => setTimeout(r, 10))

    expect(a.snapshot().running).toBe(true)
    await a.post({ type: 'job.completed', jobId: 'j1', result: 'ok' })
    expect(a.snapshot().jobs['j1']).toEqual({ state: 'exited', result: 'ok' })
    expect(a.snapshot().running).toBe(true) // 没被打断

    await sending
    await waitIdle(a)
  })

  it('运行中再 send ⇒ 排队（FIFO），当前轮结束后才开始', async () => {
    const ports = fakePorts({ replies: ['答1', '答2'], delayMs: 40 })
    const a = createAgent({ ports })
    const first = a.send({ content: '问题1' })
    const second = a.send({ content: '问题2' })

    // 第二个命令已接受，但此刻还没开始执行
    expect((await second).accepted).toBe(true)
    expect(a.history().filter((e) => e.kind === 'message').map((e) => e.content)).toEqual(['问题1'])

    await first
    await waitIdle(a)
    const contents = a.history().filter((e) => e.kind === 'message').map((e) => e.content)
    expect(contents).toEqual(['问题1', '答1', '问题2', '答2'])
    expect(ports.calls).toHaveLength(2)
  })

  it('seq 单调且订阅可从游标续订', async () => {
    const a = createAgent({ ports: fakePorts({ replies: ['答'] }) })
    await a.send({ content: 'hi' })
    await waitIdle(a)

    const seen: number[] = []
    for await (const e of a.subscribe({ afterSeq: 0 })) {
      seen.push(e.seq)
      if (seen.length >= 5) break
    }
    expect(seen).toEqual([...seen].sort((x, y) => x - y))
    expect(new Set(seen).size).toBe(seen.length)
    // 从中间续订只拿后来的
    const later: number[] = []
    for await (const e of a.subscribe({ afterSeq: seen[0]! })) {
      later.push(e.seq)
      if (later.length >= 1) break
    }
    expect(later[0]).toBeGreaterThan(seen[0]!)
  })
})

describe('Agent 聚合：内存优先的持久化（快照 + 审计）', () => {
  it('重启后历史与 seq 都在（不走回放），且审计日志有记录', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-'))
    try {
      // ① 跑两轮
      const a1 = createAgent({ ports: fakePorts({ replies: ['答1', '答2'] }), persist: filePersist(dir) })
      await a1.send({ content: '问题1' })
      await waitIdle(a1)
      await a1.send({ content: '问题2' })
      await waitIdle(a1)
      const seqBefore = a1.snapshot().seq
      expect(a1.history({ raw: true })).toHaveLength(4)

      // 等异步快照落盘
      await new Promise((r) => setTimeout(r, 20))

      // ② 「重启」：新实例从同一个目录恢复
      const a2 = createAgent({ ports: fakePorts({ replies: ['答3'] }), persist: filePersist(dir) })
      expect(a2.history({ raw: true })).toHaveLength(4)
      expect(a2.snapshot().seq).toBe(seqBefore)
      expect(a2.snapshot().turns).toBe(2)

      // ③ seq 接着涨（不重号）
      await a2.send({ content: '问题3' })
      await waitIdle(a2)
      expect(a2.snapshot().seq).toBeGreaterThan(seqBefore)

      // ④ 审计日志是 append-only 的行，且不参与逻辑
      const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.map((l) => l.kind)).toContain('send')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('快照坏了不阻断启动（当没有历史）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-'))
    try {
      writeFileSync(join(dir, 'state.json'), '{ 坏的', 'utf-8')
      const a = createAgent({ ports: fakePorts({ replies: ['答'] }), persist: filePersist(dir) })
      expect(a.history({ raw: true })).toHaveLength(0)
      await a.send({ content: '还能用' })
      await waitIdle(a)
      expect(a.snapshot().turns).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('model-ports：把 LlmPort 接成 Agent 的端口', () => {
  it('SessionDelta 的文本增量变成 Agent 的回答（不依赖 ai-sdk streamText）', async () => {
    const seen: { role: string; text: string }[][] = []
    const fake = {
      async *chat(messages: readonly { role: string; text: string }[]) {
        seen.push(messages.map((m) => ({ role: m.role, text: m.text })))
        yield { type: 'text', text: '你好，' } as never
        yield { type: 'text', text: '我是 bot。' } as never
        yield { type: 'done', stopReason: 'stop' } as never
      },
    }
    const agent = createAgent({ ports: llmPorts(fake as never) })
    await agent.send({ content: '你是谁' })
    await waitIdle(agent)

    const msgs = agent.history().filter((e) => e.kind === 'message')
    expect(msgs.map((m) => m.content)).toEqual(['你是谁', '你好，我是 bot。'])
    // 送进 provider 的那份也带上了用户原话
    expect(seen[0]).toContainEqual({ role: 'user', text: '你是谁' })
  })
})

describe('agent-host：把 Agent 接到 BotChatHost 契约上', () => {
  /** 内存版 BotStore（只实现适配器用到的几个方法） */
  function memStore() {
    const bots = new Map<string, BotConfig>()
    return {
      load: async (id: string) => bots.get(id) ?? null,
      save: async (c: BotConfig) => void bots.set(c.id, c),
      list: async () => [...bots.values()],
      remove: async (id: string) => void bots.delete(id),
      ownerOf: async () => null,
      assign: async () => undefined,
      sessionsOf: async () => [],
    } as BotStore
  }

  it('建 bot → 发一条 → snapshot 的消息线与指标来自 Agent（不是回放）', async () => {
    const host = createAgentHost({
      home: '/tmp/agent-host-test',
      botStore: memStore(),
      models: () => [],
      portsFor: () => fakePorts({ replies: ['我收到啦'] }),
      dirFor: () => `/tmp/agent-host-test/${Math.random().toString(36).slice(2)}`,
    })

    await host.createFirstBot({ model: 'test/model', name: '测试 bot' })
    let pushed: WireMessage[] = []
    const snap = await host.send('你好', (msgs) => {
      pushed = [...msgs]
    })

    expect(snap.bot?.name).toBe('测试 bot')
    expect(snap.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect((snap.messages[1]!.blocks[0]!.data as { text: string }).text).toBe('我收到啦')
    expect(snap.metrics?.turns).toBe(1)
    expect(pushed.length).toBeGreaterThan(0) // onDelta 推过中间态
  })

  it('没有 bot 时 snapshot 是空壳（UI 走引导页）', async () => {
    const host = createAgentHost({
      home: '/tmp/agent-host-test',
      botStore: memStore(),
      models: () => [],
      portsFor: () => fakePorts(),
      dirFor: () => `/tmp/agent-host-test/${Math.random().toString(36).slice(2)}`,
    })
    const snap = await host.snapshot()
    expect(snap.bot).toBeNull()
    expect(snap.messages).toEqual([])
  })
})

describe('自动压缩（判据来自 @diy-agent/compaction）', () => {
  it('窗口给小 + 内容够大 ⇒ 下一轮开跑前自动压，历史里出现 checkpoint', async () => {
    // 每轮都塞 ~2k token 的内容；窗口 20k ⇒ 触发线 4000，两轮就超
    const long = '这是一段比较长的历史内容，用来把窗口顶过触发线。'.repeat(400)  // ≈ 8000+ token/轮，远超 4000 触发线
    const ports = fakePorts({ replies: ['答1', '答2', '答3'] })
    const a = createAgent({ ports, autoCompact: { windowTokens: 20_000 } })

    await a.send({ content: long })
    await waitIdle(a)
    await a.send({ content: long })
    await waitIdle(a)
    await a.send({ content: '第三问' })   // 这一轮开跑前应当触发自动压缩
    await waitIdle(a)
    await new Promise((r) => setTimeout(r, 30)) // 让排队的 compact 命令跑完

    const kinds = a.history().map((e) => e.kind)
    expect(kinds).toContain('checkpoint')
    // 投递视图里 checkpoint 之后仍有内容（不是把历史清空）
    const cpIdx = kinds.indexOf('checkpoint')
    expect(a.history().length).toBeGreaterThan(cpIdx + 1)
  })

  it('窗口未知（null）⇒ 永不自动压（不猜数）', async () => {
    const long = '把窗口顶爆的内容。'.repeat(200)
    const a = createAgent({ ports: fakePorts({ replies: ['答'] }), autoCompact: { windowTokens: null } })
    await a.send({ content: long })
    await waitIdle(a)
    expect(a.history().some((e) => e.kind === 'checkpoint')).toBe(false)
  })
})

describe('system 段（##530）', () => {
  it('system 每轮拼在 messages 最前，且不进 history', async () => {
    const ports = fakePorts({ replies: ['答'] })
    const a = createAgent({ ports, system: '你是助手。\n\nAGENTS 内容' })
    await a.send({ content: '问题' })
    await waitIdle(a)
    const first = ports.calls[0] ?? []
    expect(first[0]).toContain('AGENTS 内容')
    // 不进 history：history 里只有 user / assistant，没有 system
    expect(a.history().every((e) => e.role !== 'system')).toBe(true)
  })

  it('不传 system ⇒ messages 里没有 system（不影响原有行为）', async () => {
    const ports = fakePorts({ replies: ['答'] })
    const a = createAgent({ ports })
    await a.send({ content: '问题' })
    await waitIdle(a)
    expect((ports.calls[0] ?? []).some((c) => c.includes('AGENTS'))).toBe(false)
  })
})

describe('空回答（##539）', () => {
  // 用户实测：UI 里总会多出一条 assistant 空消息 `blocks:[{kind:"text",data:{text:""}}]`。
  // 根因 = 模型这轮只调工具、一个字都没吐，runTurn 仍无条件 pushEntry 一条空 message。
  it('一轮只调工具、一个字没吐 ⇒ 不写空 assistant 消息，工具痕迹仍保留', async () => {
    const ports: AgentPorts = {
      async *complete() {
        yield { type: 'tool-call', id: 'c1', name: 'noop', input: '{}' }
        yield { type: 'tool-result', id: 'c1', content: 'ok' }
        yield { type: 'usage', inputTokens: 10, outputTokens: 1 }
      },
    }
    const a = createAgent({ ports })
    await a.send({ content: '调个工具' })
    await waitIdle(a)
    const messages = a.history().filter((e) => e.kind === 'message')
    expect(messages.map((e) => [e.role, e.content])).toEqual([['user', '调个工具']])
    // 工具进出还是要在历史里（不能被「没文本」连坐吞掉）
    expect(a.history().some((e) => e.kind === 'tool-call')).toBe(true)
    expect(a.history().some((e) => e.kind === 'tool-result')).toBe(true)
  })

  it('有文本的回答照常量写入（不能为了修空消息把正常回答也吞了）', async () => {
    const a = createAgent({ ports: fakePorts({ replies: ['正常回答'] }) })
    await a.send({ content: '问一句' })
    await waitIdle(a)
    expect(a.history().filter((e) => e.kind === 'message').map((e) => e.content)).toEqual(['问一句', '正常回答'])
  })
})
