# Agent 聚合抽象（意图测试的入口）

> 目标：**一个类表达完「一个 Agent 是什么」**。测试只与它对话（`send / post / compact / history / snapshot`），
> 不再穿透到 ops / turns / compact-state / 投递装配 四五个模块去拼场景。
> 状态里的一切（seq、边界、checkpoint、计数）都由它独家拥有与推进。

## 1. 为什么是「聚合」而不是「服务集合」

现在同一个概念散在五处：消息在 `ops.jsonl`、轮边界在 `turns.jsonl`、投递切片在 `compaction` 条目、
原始请求在 `traffic`、UI 投影在 renderer store。任何一条意图（“压缩后模型该看到什么”）都要跨四个文件拼。

聚合的意思只有三条：**唯一的根标识 + 唯一的写入口 + 唯一的不变量集**。
外部可以观察、可以命令，但不能绕过它改状态。

## 2. 边界：什么在 Agent 里，什么在 Agent 外

| 在 Agent 里（聚合内） | 在 Agent 外（协作对象） |
|---|---|
| 历史消息与它们的顺序（`seq`） | LLM 调用（注入的 port） |
| 轮 / 步的边界与计数 | 工具执行（注入的 port） |
| 压缩边界 + checkpoint 文本 | 持久化介质（注入的 store） |
| 待处理的输入队列（用户消息 / 外部事件） | 会话锁、进程、实例身份 |
| 运行状态（idle / running / cancelling） | UI 投影与订阅 |

判据：**删掉它，Agent 的意图测试就不可表达** → 在里面；否则在外面注入。

## 3. 接口（意图测试看到的就是这些）

```ts
/** 聚合根。一个实例 = 一个会话（diy 里 = 一个 taskUri 的会话）。 */
export interface Agent {
  readonly id: AgentId

  // ── 命令：表达意图，返回回执（不返回结果流） ──
  /** 用户输入。排队；当前有运行时按调度策略处理（见 §5） */
  send(input: { content: string; commandId?: CommandId }): Promise<Receipt>
  /** 外部事件（job 完成 / 通知 / 别的 agent 发言）。是否影响上下文由 Agent 决定 */
  post(input: AgentInput): Promise<Receipt>
  /** 取消当前运行 */
  cancel(runId?: RunId): Promise<Receipt>
  /** 压缩：策略对象描述「留什么」，流程与落盘由 Agent 内部完成 */
  compact(strategy: CompactStrategy): Promise<Receipt>

  // ── 查询：读，不改状态 ──
  snapshot(): AgentSnapshot          // 当前完整状态（含 seq / 运行状态 / 压缩点）
  history(opts?: { sinceSeq?: number }): readonly HistoryEntry[]
  getRun(runId: RunId): RunSnapshot | null

  // ── 订阅：事实流（含 seq，可断点续订） ──
  subscribe(opts?: { afterSeq?: number }): AsyncIterable<AgentEvent>
}

export interface Receipt {
  commandId: CommandId
  accepted: boolean
  /** 命令被接受时的状态版本；UI 据此判断自己是否落后 */
  seq: number
  error?: { code: string; message: string }
}

/** 压缩策略：只管「留什么」，不管「怎么落盘 / 怎么通知模型」 */
export type CompactStrategy =
  | { kind: "keepTurns"; turns: number }
  | { kind: "keepTokens"; tokens: number }
  | { kind: "keepSince"; marker: string }     // 例如某个 checkpoint

export interface HistoryEntry {
  seq: number
  kind: "message" | "checkpoint" | "notice" | "runtime"
  role?: "user" | "assistant" | "tool" | "system"
  content?: string
  /** checkpoint 才有：它代表了哪些 seq 区间（被折掉的历史） */
  shadowed?: { fromSeq: number; toSeq: number }
}
```

## 4. 不变量（意图测试的断言就落在这五条上）

1. **seq 单调**：每次接受一条输入/产生一条事件都 +1，从不在 `await` 之后分配。
2. **单一写者**：同一 Agent 的状态变更串行；外部并发命令只会排队，不会交错改状态。
3. **命令有回执**：`accepted=false` 必带原因；`accepted=true` 后 `seq` 之内的状态对调用方可见。
4. **压缩产出 checkpoint**：压缩后 `history()` 的第一条必须是 `kind: "checkpoint"`，
   且它的 `shadowed` 覆盖被折掉的区间 —— 这就是「模型知道自己被压过」的唯一依据。
5. **可恢复**：`snapshot()` 能完整重建；重启后用 `subscribe({ afterSeq })` 续订不丢事件。

## 5. 调度语义（显式定死，不给实现留白）

| 场景 | 行为 |
|---|---|
| 运行中再 `send` | 排队（FIFO），当前 run 结束后启动下一轮；不注入、不打断 |
| 运行中 `post`（job 完成等） | **立即**更新状态（改的是 Job/通知，不动消息队列），是否触发新 run 由 Agent 决定 |
| 运行中 `cancel` | 高优先级，插队执行，不排在当前 run 之后 |
| `compact` 运行中 | 排到队列里但要等当前 run 的**边界安全点**（步结束）才落盘 |

## 6. 意图测试长什么样（这就是要达成的可读性）

```ts
it("压缩后模型看到的第一条是 checkpoint，而不是半轮的答案", async () => {
  const a = createAgent({ llm: fakeLlm(["回答1", "回答2", "回答3"]) })
  await a.send({ content: "问题1" })
  await a.send({ content: "问题2" })
  await a.send({ content: "问题3" })

  const r = await a.compact({ kind: "keepTurns", turns: 1 })
  expect(r.accepted).toBe(true)

  // ① 历史被折成 checkpoint + 最近一轮
  const h = a.history()
  expect(h[0].kind).toBe("checkpoint")
  expect(h.filter((e) => e.kind === "message" && e.role === "user")).toHaveLength(1)

  // ② 下一次真发的请求，第一条非 system 就是这个 checkpoint 里的文本
  await a.send({ content: "问题4" })
  const req = fakeLlm.lastRequest()
  const body = req.messages.filter((m) => m.role !== "system")
  expect(body[0].content).toContain("checkpoint")
  expect(body.filter((m) => m.content === "问题1")).toHaveLength(0)
})

it("压缩拒绝要给出原因（不静默成功）", async () => {
  const a = createAgent({ llm: fakeLlm(["x"]) })
  await a.send({ content: "只有一轮" })
  const r = await a.compact({ kind: "keepTurns", turns: 1 })
  expect(r.accepted).toBe(false)
  expect(r.error?.code).toBe("compact/nothing-to-drop")
})

it("运行中 post 的 job 通知立即进状态，但不打断当前 run", async () => {
  const a = createAgent({ llm: slowLlm(), })
  const run = a.send({ content: "长任务" })
  await a.post({ type: "job.completed", jobId: "j1", result: "ok" })
  expect(a.snapshot().jobs.j1.state).toBe("exited")   // 已更新
  expect(a.snapshot().running).toBe(true)             // 没被打断
  await run
})
```

## 7. 与 diy 现状的映射

| 聚合概念 | diy 现在在哪 | 要补什么 |
|---|---|---|
| `Agent.id` | `taskUri` | — |
| `history()` | `ops.jsonl` + 边界切片（`resolveOpsReplay`） | 回放结果直接暴露成 `HistoryEntry[]` |
| `seq` | 无（用 ops 行号 + turnId 拼） | Agent 内单调计数器，启动时从账本取 max |
| `send` | `agent local chat` / RPC | 加回执（当前直接返回流） |
| `post` | 无（通知只进投递信封的 `notify` 段） | 新增入口 + 状态 |
| `compact(strategy)` | `compactToKeepRounds(taskUri, n)` | 参数换成策略对象；`0 轮`/越界返回 `accepted:false` 而非 `null` |
| checkpoint | **无**（压缩只挪切点，历史里没有特殊消息） | 压缩时写一条 `kind:"checkpoint"` 的历史条目，投递时作为第一条 |
| `subscribe` | 各面板各自 `serverStream` | 统一信封 + 按 `(domain,resource)` 合并 |

## 8. 落地建议

1. **先做接口与假实现**（`createAgent` 内存版，不碰 fs）：只满足 §4 五条不变量 + §6 三个测试能跑。
   这一步不需要动 diy 任何现有代码，纯新建文件，用来把「意图测试怎么写」钉死。
2. 再把内存版换成真实现：`history()` 读 ops、`send` 走 RPC、`compact` 走现有边界机制。
3. 最后才把 checkpoint 变成真消息（这是唯一需要动投递装配的改动，也是当前那个 bug 的根）。

这条顺序的好处：接口先稳定，测试先可读，再逐步替换内部实现，避免又一次「改一层发现三层都要改」。
