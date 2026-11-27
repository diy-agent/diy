# 为什么不用 xstate

调研日期：2025-11。完整记录（含 113 个范例的统计、可复跑的 spike）在
`diy-research/pkgs.ts/xstate/README.md`。这里只留结论。

## 一句话

**xstate 解决的问题和我们这里的需求只有部分重叠。** 队列、回执、崩溃恢复这三块它都不管。

## 它真省事的六个场景

| 场景                     | 官方范例                    | 它替你做了什么                                           |
| ------------------------ | --------------------------- | -------------------------------------------------------- |
| 竞态取消                 | `search-autocomplete-react` | 离开状态时自动 abort 上一次请求（`signal` 由运行时注入） |
| 流式中断保留已收到的部分 | `agent-streaming-response`  | cleanup 函数 + `final` 状态的 `output` 带着已攒的 text   |
| 长期挂起零成本           | `agent-human-in-the-loop`   | 「等人工审批」不占 pending promise，吃快照持久化         |
| 中断后回原状态           | `video-player-react`        | `buffering → playing`，不用手写 `wasPlaying` 布尔        |
| 临时交互态               | `drag-and-drop-react`       | `pressed / dragging` 结构上互斥，不会同时成立            |
| 模型测试                 | `model-based-testing`       | 从状态图生成测试路径，覆盖率按**转换**算                 |

## 它明显是负担的四个场景

| 场景             | 证据                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 一次调用拿返回值 | `send()` 返回 `undefined`；`toPromise` 等终止；`waitFor` 等快照满足条件。**库里没有 request 这个单位**，所以没有请求身份                                                   |
| 一次性脚本逻辑   | `pattern-retry-policy` 50 行写成状态机，等价代码 5 行                                                                                                                      |
| 变体分发         | `agent-tool-loop` 每个工具一个状态，加第 4 个工具要复制 20 行                                                                                                              |
| 队列             | `elevator` / `rate-limiter` / `queue-worker` / `notifications-react` / `pattern-event-accumulation` —— **无一例外**都是 `context.xxx: T[]`，状态机只管「现在处于哪个模式」 |

## 关键统计

113 个官方范例里，凡涉及「排队」的，队列**全部**是 context 里的普通数组。
也就是说，xstate 官方文档自己承认这件事不归它管。

## v6 在做减法

`v5-to-v6-migration` 的对照表：`assign/sendTo/raise/stopChild/cancel` 全部收敛成 `enq.*`，
`fromPromise/fromCallback/fromObservable/fromTransition` 收敛成 `create*Logic`。
方向全是「砍概念」。v5 的难用是官方自己承认的。

## 什么情况下会改主意

需求里出现下面任意两条以上，就该认真考虑 xstate：

1. 每条回复都要能中途取消，且要正确 abort 底层请求
2. 流程要跨会话 / 跨进程挂起（等审批、等确认）
3. 有 3 个以上互斥阶段，且每个阶段允许的操作不同
4. 要对流程做模型测试（不只是测函数）
5. 出现「中断后恢复原状态」的需求

现在这个内核的 `04-cancel` 覆盖了第 1 条的一小半（取消 + 保留产出），但没有 abort 传播；
`05-persist` 覆盖了第 2 条的一半（进程重启，不是流程挂起）。

## 如果真要用，别一上来就 `createMachine`

| 入口                     | 是什么                                                                    | 什么时候用                   |
| ------------------------ | ------------------------------------------------------------------------- | ---------------------------- |
| `xstate/fsm` `createFSM` | 纯 reducer，`transition(state, event)` 同步返回                           | 只要「状态合法性」           |
| `@xstate/store`          | signals + `createAsyncAtom`（自带 `pending/done/error` 和 `AbortSignal`） | 要响应式 + loading 状态      |
| `xstate` `createMachine` | 全套：invoke / spawn / delay / persist / inspect                          | 需要取消、长期挂起、模型测试 |

中间那层最值得先试。`createAsyncAtom` 返回的形状正是

```ts
{ status: 'pending' } | { status: 'done', data } | { status: 'error', error }
```

这就是「让 Promise 有状态」的标准答案，而且带自动 abort 竞态。
