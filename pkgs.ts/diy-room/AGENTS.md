# @diy/room — 协作空间内核（成员表 + `@` 投递 + 忙闲）

> 全仓契约见**仓库根 `AGENTS.md`**。本包**不认识任务**：没有任务 URI / 任务标识 / `@diy/task`。
> 依赖 `@diy/session` 的 `SessionPeer`（只要求 `id` / `busy` / `send()` 三样）。
> 需求真源是 `tests/intent.room.test.ts`（R1–R7，R7 静态扫源码）。

## 主线日志（publicLog）

只收 `human` + `agent-conclusion` 两种；agent 的过程（trace / tool-call / tool-result）永不进。
**`text` 是正文副本，不是引用**：二级会话日志会被清理，主线要长期可读（##456 数据分层修订）。

## 三条最容易破的约束

1. **别让 room 反向依赖 task**（是 task 持有 roomId，不是 room 去查 task）；
2. **别把过程写进主线**（trace/tool-call 不是结论；一轮以工具调用收尾时没有结论）；
3. **别把投递归并 / 丢弃**：同一成员串行排队，不同成员并行，回复事件可查投递状态；
4. **别静默忽略点名**：`@不存在的人` 报 `room/unknown-recipient`，否则发言者以为送到了。

## 取法

- `diy facts brief rule` — 全局硬约束
- 设计背景：##456 body「关键设计决策 ①／③」与第 3~4 步（task 侧适配器留给后续任务）
