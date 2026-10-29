# @diy/agent-session — 单会话内核（消息 + 一次 LLM 调用 + 流式增量）

> 全仓契约见**仓库根 `AGENTS.md`**。本包是**零 IO 纯内核**：不碰文件系统 / `electron` / 应用数据根，
> 不认识 task。存储 / 时钟 / 压缩 / LLM 全部走注入端口 ⇒ 现在即可拆成单独项目。
> 需求真源是 `tests/intent.session.test.ts`（S1–S7，S7 静态扫源码）。

## 存储与 seq

每条消息有会话内全局单调的 `seq`（1 起，压缩/恢复都不重置）；`SessionStore` = `append / readFrom(seq) / readRange(at) / latestSeq`。
分桶 jsonl 在 `@diy/agent-session-store-jsonl`，本包不碰文件系统。

## 消息分类（判别键 `type`，6 种）

`human` / `agent-conclusion` / `agent-notice` 进 Room 主线；`agent-trace` / `tool-call` / `tool-result` 只在二级日志。
判据：本轮遇过 `tool-call` ⇒ 之前的文字是 trace，最后一段才是 conclusion（别把过程当结论）。
形状：与 `type` 同级只放公共字段，私有载荷进 `data`（tool-call ⇒ `data.tool`）；`data` 原样透传、不解释 schema。

## 三条最容易破的约束

1. **别把 IO 拉进来**（`SessionStore` 是端口，jsonl/sqlite 由独立适配器实现）；
2. **别把 task 概念写进来**（会话不知道自己在哪个任务里）；
3. **别静默容错**（非法消息 / 非法增量 / 空正文一律抛 `SessionError`，带 code 与点路径）。

## 取法

- `diy facts brief rule` — 全局硬约束
- 设计背景：##456 body「关键设计决策 ②／AgentSession 的边界」
