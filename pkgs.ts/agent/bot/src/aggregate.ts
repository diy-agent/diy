// src/aggregate.ts
// 🎯 **Agent 聚合**（`docs/plans/2026-11-07-agent-aggregate.md`）：一个类表达完「一个 Agent 是什么」。
//
// 为什么单独一个文件而不是把现有 BotAgent 改造：先要一个**意图测试能直接对话的对象**——
// `send / post / cancel / compact(strategy)` 是命令（返回回执），`history / snapshot` 是查询，
// `subscribe` 是事实流。内部先做**纯内存**实现：不碰 fs、不碰 RPC、不碰投递装配，
// 用来固定「语义」而不是「实现」；等测试写顺了再逐层替换成真实现。
//
// 三条硬约束（对应文档 §4 的不变量）：
//   1. seq 在任何 `await` 之前同步分配 —— 单线程下就不可能重号；
//   2. 同一 Agent 的状态变更串行（命令进队列），耗时执行在外面跑完再回队列提交；
//   3. 命令必须有回执：`accepted=false` 时带原因，绝不静默成功。

import type { PersistPorts, PersistState } from "./persist.js";
import { estimateTokensOf } from "@diy-agent/compaction/history-limit";
import { retainTokensOf, triggerTokensOf } from "@diy-agent/compaction/select-kept-boundary";

/** 会话标识（diy 里 = taskUri，这里只当不透明字符串） */
export type AgentId = string
export type CommandId = string
export type RunId = string

export interface Receipt {
  commandId: CommandId
  accepted: boolean
  /** 命令被接受时的状态版本（= 当时已分配的最大 seq） */
  seq: number
  error?: { code: string; message: string }
}

/** 压缩策略：只说「留什么」，不说「怎么落盘 / 怎么通知模型」 */
export type CompactStrategy =
  | { kind: 'keepTurns'; turns: number }
  | { kind: 'keepTokens'; tokens: number }
  | { kind: 'keepSince'; marker: string }

export type HistoryKind = 'message' | 'checkpoint' | 'notice' | 'runtime' | 'tool-call' | 'tool-result'

export interface HistoryEntry {
  seq: number
  kind: HistoryKind
  role?: 'user' | 'assistant' | 'tool' | 'system' | 'developer'
  content?: string
  /** 仅 checkpoint：它折掉了哪些 seq（含两端） */
  shadowed?: { fromSeq: number; toSeq: number }
  /** 仅工具类：调用 id / 名字 / 参数（结果条目只有 id 与正文） */
  tool?: { id: string; name: string; input: string }
}

/** Agent 的输入：用户消息 / 外部事件 */
export type AgentInput =
  | { type: 'user.message'; content: string }
  | { type: 'job.completed'; jobId: string; result?: unknown }
  | { type: 'job.failed'; jobId: string; error: string }
  | { type: 'external.event'; source: string; payload: unknown }

export interface AgentEventEnvelope {
  seq: number
  type:
    | 'message.accepted'
    | 'run.started'
    | 'message.delta'
    | 'message.completed'
    | 'run.completed'
    | 'job.updated'
    | 'tool.started'
    | 'tool.completed'
    | 'compact.committed'
    | 'compact.rejected'
  payload: Record<string, unknown>
}

export interface AgentSnapshot {
  id: AgentId
  /** 已分配的最大 seq（等于「事件流的长度」） */
  seq: number
  running: boolean
  runId: RunId | null
  /** 已完成的轮数（用户消息 + 一次完整回答 = 一轮） */
  turns: number
  historyLength: number
  jobs: Record<string, { state: 'running' | 'exited' | 'failed'; result?: unknown; error?: string }>
}

/** 端口产出的一段：文本 / 工具调用 / 工具结果（工具由 port 那侧执行，聚合只负责记账） */
export type AgentChunk =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; name: string; input?: string }
  | { type: 'tool-result'; id: string; content: string }

/** 注入的外部能力（聚合内不 import 任何具体实现） */
export interface AgentPorts {
  /**
   * 一次「回答」：给定消息历史，产出 chunk 流。
   *
   * `tools` 原样透传给 port（实现方决定怎么执行：diy 里交给 ai-sdk 的 streamText 跑循环）。
   * 聚合**不解释**工具语义，只把 tool-call / tool-result 记进历史 —— 这样 UI 能显示、
   * 压缩能按轮算，而聚合本身仍然零依赖。
   */
  complete(
    messages: readonly { role: string; content: string }[],
    opts?: { tools?: unknown; maxSteps?: number },
  ): AsyncIterable<AgentChunk | string>
}

export interface CreateAgentOptions {
  id?: AgentId
  ports: AgentPorts
  /**
   * 持久化：**内存是唯一真源**，这里只做快照（重启恢复）+ 审计日志（append-only）。
   * 缺省 = 纯内存（测试默认）。
   */
  persist?: PersistPorts
  /**
   * 自动压缩（##517 口径，判据来自 `@diy-agent/compaction`）：
   * 触发线 = `W − max(10%W, 16000)`；保留量 = `W × 0.16`。
   * `windowTokens: null` = 窗口未知 ⇒ **永不自动压**（不猜数）。
   */
  autoCompact?: { windowTokens: number | null }
  /**
   * 工具：原样交给 `ports.complete(messages, { tools, maxSteps })`。
   * 聚合不知道工具是什么（零依赖），只把调用/结果记进历史。
   */
  tools?: unknown
  maxSteps?: number
}

export interface Agent {
  readonly id: AgentId
  send(input: { content: string; commandId?: CommandId }): Promise<Receipt>
  post(input: AgentInput): Promise<Receipt>
  cancel(runId?: RunId): Promise<Receipt>
  compact(strategy: CompactStrategy): Promise<Receipt>
  snapshot(): AgentSnapshot
  /**
   * 历史视图。
   *
   * 默认 = **投递视图**（= 模型将看到的）：有 checkpoint 就从它开始，被折掉的原文不再出现。
   * `raw: true` = 原始日志（UI 要画「被压掉的划删除线」时用），此时 checkpoint 也只是一条记录。
   *
   * 这两个视图的区别是聚合的核心语义之一：**日志只追加、视图按 checkpoint 折叠**。
   */
  history(opts?: { sinceSeq?: number; raw?: boolean }): readonly HistoryEntry[]
  /**
   * 取走「上一轮失败的原因」（消费一次即清空）。
   *
   * 为什么不是 `snapshot().error`：失败是**事件**不是状态 —— 放进快照会让它变成一个
   * 永远挂在那儿的字段（UI 可能把旧错误当新错误显示）。真正的状态表达留给事件流。
   */
  takeFailure(): string | undefined
  subscribe(opts?: { afterSeq?: number }): AsyncIterable<AgentEventEnvelope>
}

/** 串行执行器：保证同一 Agent 的状态变更不交错（= Single Writer 的最小实现） */
class SerialExecutor {
  private queue: Array<() => Promise<void>> = []
  private running = false

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await fn())
        } catch (e) {
          reject(e)
        }
      })
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0) await this.queue.shift()!()
    } finally {
      this.running = false
      if (this.queue.length > 0) void this.drain()
    }
  }
}

let seqOfCommand = 0
const nextCommandId = (): CommandId => `cmd_${++seqOfCommand}`

/** 建一个**内存版** Agent（意图测试用；生产实现见文档 §8 的第三步） */
export function createAgent(opts: CreateAgentOptions): Agent {
  const id: AgentId = opts.id ?? 'agent_1'
  const exec = new SerialExecutor()

  let seq = 0
  let running = false
  let runId: RunId | null = null
  let turns = 0
  let lastError: string | undefined
  const jobs: AgentSnapshot['jobs'] = {}
  const entries: HistoryEntry[] = []
  const events: AgentEventEnvelope[] = []
  const listeners = new Set<(e: AgentEventEnvelope) => void>()
  /** 已排队但还没开始的用户消息（严格 FIFO，不注入、不打断） */
  const pending: Array<{ content: string; commandId: CommandId }> = []

  // ── 快照恢复（内存优先：读回来就是内存状态，不涉及任何回放） ──
  const persist = opts.persist
  if (persist) {
    const loaded = persist.load() as (PersistState & { entries?: HistoryEntry[] }) | null
    if (loaded) {
      seq = loaded.seq ?? 0
      turns = loaded.turns ?? 0
      for (const e of (loaded.entries ?? []) as HistoryEntry[]) entries.push(e)
      Object.assign(jobs, (loaded.jobs ?? {}) as AgentSnapshot['jobs'])
    }
  }

  /** 快照 + 审计：改完内存之后调用（异步落盘，不阻塞状态机） */
  const afterChange = (kind: string, extra: Record<string, unknown> = {}): void => {
    if (!persist) return
    persist.audit({ at: new Date().toISOString(), seq, kind, ...extra })
    const snapshot: PersistState = { seq, entries, turns, jobs: { ...jobs } }
    queueMicrotask(() => persist.save(snapshot))
  }

  /** 分配 seq 并发事件（**同步**：任何 await 之前调用） */
  const emit = (type: AgentEventEnvelope['type'], payload: Record<string, unknown>): number => {
    const s = ++seq
    const ev: AgentEventEnvelope = { seq: s, type, payload }
    events.push(ev)
    for (const l of listeners) l(ev)
    return s
  }

  const pushEntry = (e: Omit<HistoryEntry, 'seq'>): HistoryEntry => {
    const entry: HistoryEntry = { seq: ++seq, ...e }
    entries.push(entry)
    return entry
  }

  const ok = (commandId: CommandId): Receipt => ({ commandId, accepted: true, seq })
  const reject = (commandId: CommandId, code: string, message: string): Receipt => {
    // 被拒也留审计行：重启后要能回答「这条命令当时为什么没生效」。
    // **不写快照**（状态没变），所以重启后只会看到审计里的记录，不会凭空多出状态。
    opts.persist?.audit({ at: new Date().toISOString(), seq, kind: "reject", commandId, code, message })
    return { commandId, accepted: false, seq, error: { code, message } }
  }

  /**
   * 当前投递视图 = **checkpoint 取代被它折掉的那一段**。
   *
   * 关键：checkpoint 是**追加**在日志末尾的，但语义位置在 `shadowed.fromSeq` 处 ——
   * 所以不能「从 checkpoint 那条往后切」（那会把本该保留的最近几轮也切掉，实测踩过）。
   * 正确做法：checkpoint 排第一，其余取「seq > shadowed.toSeq」的条目。
   */
  function delivered(): HistoryEntry[] {
    let cp: HistoryEntry | null = null
    for (const e of entries) if (e.kind === 'checkpoint') cp = e
    if (cp === null) return [...entries]
    const cutoff = cp.shadowed?.toSeq ?? 0
    const rest = entries.filter((e) => e.kind !== 'checkpoint' && e.seq > cutoff)
    return [cp, ...rest]
  }

  /** 真正跑一轮：状态提交进队列，耗时的 LLM 执行在队列外 */
  async function runTurn(content: string): Promise<void> {
    const started = await exec.enqueue(async () => {
      running = true
      runId = `run_${seq + 1}`
      pushEntry({ kind: 'message', role: 'user', content })
      emit('message.accepted', { content, runId })
      emit('run.started', { runId })
      afterChange('send', { runId, content })
      return { rid: runId as RunId }
    })

    // checkpoint 也要进投递（它就是模型看到的第一条上下文）
    // 自动压缩：判据与 diy-app 同源（触发线 / 保留量都来自 @diy-agent/compaction）
    const win = opts.autoCompact?.windowTokens ?? null
    if (win !== null && win > 0) {
      const msgs = agent.history().filter((e) => e.kind === 'message' || e.kind === 'checkpoint')
      const used = msgs.reduce((n, e) => n + estimateTokensOf(JSON.stringify(e.content ?? '')), 0)
      if (used >= triggerTokensOf(win)) {
        // 只在「真的能腾出空间」时压：keepTokens 走的是同一条 compact 命令（写 checkpoint）
        void agent.compact({ kind: 'keepTokens', tokens: retainTokensOf(win) })
      }
    }

    const visible = delivered()
      .filter((e) => e.kind === 'message' || e.kind === 'checkpoint')
      .map((e) => ({
        role: e.kind === 'checkpoint' ? 'user' : (e.role ?? 'user'),
        content: e.content ?? '',
      }))

    let text = ''
    // ⚠️ LLM 执行**不占**状态队列：这期间 post() 仍能立即更新状态
    //
    // 异常必须在这里收口：`runTurn` 是 `void` 起的，抛出去就是 unhandled rejection，
    // 而 `running` 会永远停在 true ⇒ 界面永远转圈（实测：上游超时后按钮一直禁用）。
    try {
      for await (const chunk of opts.ports.complete(visible, {
        ...(opts.tools === undefined ? {} : { tools: opts.tools }),
        ...(opts.maxSteps === undefined ? {} : { maxSteps: opts.maxSteps }),
      })) {
        if (typeof chunk === 'string') {
          text += chunk
          continue
        }
        if (chunk.type === 'text') {
          text += chunk.text
          continue
        }
        // 工具进出都记进历史：UI 要显示，压缩要按轮算，审计要能回溯
        await exec.enqueue(async () => {
          if (chunk.type === 'tool-call') {
            pushEntry({
              kind: 'tool-call',
              role: 'assistant',
              content: chunk.name,
              tool: { id: chunk.id, name: chunk.name, input: chunk.input ?? '' },
            })
            emit('tool.started', { id: chunk.id, name: chunk.name })
          } else {
            pushEntry({
              kind: 'tool-result',
              role: 'tool',
              content: chunk.content,
              tool: { id: chunk.id, name: '', input: '' },
            })
            emit('tool.completed', { id: chunk.id })
          }
        })
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await exec.enqueue(async () => {
        running = false
        runId = null
        lastError = message
        emit('run.completed', { failed: true, error: message })
        afterChange('turn.failed', { error: message })
        const next = pending.shift()
        if (next !== undefined) void runTurn(next.content)
      })
      return
    }
    lastError = undefined

    await exec.enqueue(async () => {
      pushEntry({ kind: 'message', role: 'assistant', content: text })
      emit('message.delta', { runId: started.rid, delta: text })
      emit('message.completed', { runId: started.rid, text })
      emit('run.completed', { runId: started.rid })
      running = false
      runId = null
      turns += 1
      afterChange('turn.completed', { text })
      // 队列里还有用户消息 → 继续下一轮（严格串行）
      const next = pending.shift()
      if (next !== undefined) void runTurn(next.content)
    })
  }

  const agent: Agent = {
    id,

    async send({ content, commandId }): Promise<Receipt> {
      const cid = commandId ?? nextCommandId()
      const busy = running || pending.length > 0
      if (busy) {
        // 排队：先给回执（已接受），等当前轮结束再跑
        pending.push({ content, commandId: cid })
        const s = emit('message.accepted', { content, queued: true })
        return { commandId: cid, accepted: true, seq: s }
      }
      void runTurn(content)
      return { commandId: cid, accepted: true, seq }
    },

    async post(input): Promise<Receipt> {
      const cid = nextCommandId()
      // 外部事件**立即**生效（不动消息队列、不打断当前 run）
      await exec.enqueue(async () => {
        if (input.type === 'job.completed') {
          jobs[input.jobId] = { state: 'exited', ...(input.result === undefined ? {} : { result: input.result }) }
          emit('job.updated', { jobId: input.jobId, state: 'exited' })
        } else if (input.type === 'job.failed') {
          jobs[input.jobId] = { state: 'failed', error: input.error }
          emit('job.updated', { jobId: input.jobId, state: 'failed' })
        } else if (input.type === 'external.event') {
          pushEntry({ kind: 'notice', content: `${input.source}: ${JSON.stringify(input.payload)}` })
        } else {
          pushEntry({ kind: 'message', role: 'user', content: input.content })
        }
        afterChange('post', { input: input.type })
      })
      return ok(cid)
    },

    async cancel(target): Promise<Receipt> {
      const cid = nextCommandId()
      // 取消是控制操作：插队（不进 pending 队列）
      if (!running || (target !== undefined && target !== runId)) {
        return reject(cid, 'agent/not-running', '当前没有可取消的运行')
      }
      await exec.enqueue(async () => {
        running = false
        runId = null
        emit('run.completed', { cancelled: true })
      })
      return ok(cid)
    },

    async compact(strategy): Promise<Receipt> {
      const cid = nextCommandId()
      const msgs = entries.filter((e) => e.kind === 'message')
      if (msgs.length === 0) return reject(cid, 'compact/nothing-to-drop', '历史里没有消息')

      const dropCount = ((): number => {
        if (strategy.kind === 'keepTurns') {
          // 一轮 = 1 条 user + 1 条 assistant
          const keepMsgs = Math.max(0, strategy.turns) * 2
          return Math.max(0, msgs.length - keepMsgs)
        }
        if (strategy.kind === 'keepTokens') {
          // 与判据同一个估算器（CJK 感知），不再是字符数 —— 否则同一条策略两处口径不一致
          let keep = 0
          let dropped = 0
          for (let i = msgs.length - 1; i >= 0; i--) {
            keep += estimateTokensOf(JSON.stringify(msgs[i]!.content ?? ''))
            if (keep >= strategy.tokens) return msgs.length - (msgs.length - i)
            dropped += 1
          }
          return Math.max(0, dropped === msgs.length ? msgs.length - 1 : msgs.length - (msgs.length - dropped))
        }
        return 0 // keepSince：本内存版不实现
      })()

      if (dropCount === 0) {
        emit('compact.rejected', { reason: 'nothing-to-drop' })
        return reject(cid, 'compact/nothing-to-drop', '没有可压缩的历史（保留量已覆盖全部）')
      }

      await exec.enqueue(async () => {
        const dropped = msgs.slice(0, dropCount)
        const fromSeq = dropped[0]!.seq
        const toSeq = dropped[dropped.length - 1]!.seq
        // checkpoint 就是压缩后模型看到的第一条：它带 shadowed，声明自己折掉了哪段
        pushEntry({
          kind: 'checkpoint',
          content: `【已压缩】此前 ${dropCount} 条消息已折叠为摘要；从下面继续。`,
          shadowed: { fromSeq, toSeq },
        })
        emit('compact.committed', { droppedSeqs: [fromSeq, toSeq], count: dropCount })
        afterChange('compact', { count: dropCount, fromSeq, toSeq })
      })
      return ok(cid)
    },

    takeFailure(): string | undefined {
      const failure = lastError
      lastError = undefined
      return failure
    },

    snapshot(): AgentSnapshot {
      return {
        id,
        seq,
        running,
        runId,
        turns,
        historyLength: delivered().length,
        jobs: { ...jobs },
      }
    },

    history(opts): readonly HistoryEntry[] {
      const since = opts?.sinceSeq ?? 0
      const src = opts?.raw === true ? entries : delivered()
      return src.filter((e) => e.seq > since)
    },

    async *subscribe(opts): AsyncIterable<AgentEventEnvelope> {
      const after = opts?.afterSeq ?? 0
      // 先补历史事件（重连/断点续订），再转实时
      const backlog = events.filter((e) => e.seq > after)
      let cursor = after
      for (const e of backlog) {
        cursor = e.seq
        yield e
      }
      while (true) {
        const next = await new Promise<AgentEventEnvelope | null>((resolve) => {
          const onEvent = (e: AgentEventEnvelope): void => {
            if (e.seq > cursor) {
              listeners.delete(onEvent)
              resolve(e)
            }
          }
          listeners.add(onEvent)
        })
        if (next === null) return
        cursor = next.seq
        yield next
      }
    },
  }

  return agent
}
