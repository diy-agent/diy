// 意图测试：只通过 Agent 聚合对话（send / post / cancel / compact / history），
// 不穿透到 store / 投递装配 —— 这正是 `docs/plans/2026-11-07-agent-aggregate.md` §6 要的形状。
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgent, type AgentPorts } from '../src/aggregate.js'
import { filePersist } from '../src/persist.js'
import { llmPorts } from '../src/model-ports.js'

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
