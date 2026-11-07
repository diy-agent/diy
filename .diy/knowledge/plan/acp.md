---
desc: ACP（Agent Client Protocol）v1 协议事实与接入要点
updated: 2026-10-22
---

## capabilities

`agentCapabilities` 形状（initialize response）：`loadSession` · `sessionCapabilities.{resume,close,delete,list,additionalDirectories}`（**存在 = 支持**，空对象即开）· `promptCapabilities.{image,audio,embeddedContext}` · `mcpCapabilities.{http,sse}` · `_meta`（如 `maxConcurrentSessions`）。解析时按「字段存在即 true」判，缺省 false。

（见 b0ff9948:docs/plans/2026-07-10-acp-research.md:38）

## protocol-baseline

ACP（Agent Client Protocol）v1 基线：`protocolVersion` 是**整数 `1`**（不是字符串 `"0.1.0"`）；`initialize` 参数带 `clientCapabilities`（fs 等）；agent 在 initialize response 里返回**完整能力清单**；`session/update` 是流式通知、事件名 `agent_message_chunk`。session 能力是**嵌套**的：`loadSession`（顶层）+ `sessionCapabilities.{resume,close,delete,list,additionalDirectories}` —— **没有** `session.list/load/save/configure` 这套顶层方法。

（见 b0ff9948:docs/plans/2026-07-10-acp-research.md:11）

## registry

ACP Registry：`github.com/agentclientprotocol/registry` —— 每个 agent 提交 `acp.json` manifest（`name` / `entrypoint` / `transports` / `capabilities` 静态声明）；22+ agent 已注册（Claude Agent、Codex、Cline、Cursor、Devin、Gemini CLI 等）。

（见 b0ff9948:docs/plans/2026-07-10-acp-research.md:81）

## sdk-decision

**注意演进**：这份 2026-07-10 文档主张「不用 `@agentclientprotocol/sdk`、自建 ~150 行（避免版本漂移）」；后来 acp-opencode 接入时**推翻**了它，改用官方 `@agentclientprotocol/sdk`（现 `diy-app` 依赖 1.4.0）。所以「自建」只是历史决策，**现行看代码** `apps/diy-app/package.json`。

## session-update

`session/update` 通知（**无 id、单向**）：`agent_message_chunk`（文本 delta）/ `agent_thought_chunk`（推理过程，RFD 阶段）/ `plan`（执行计划）/ `tool_call`（工具调用开始）/ `tool_call_update`（工具状态 in_progress / completed）/ `usage_update`。消息体形如 `{sessionUpdate:'agent_message_chunk', messageId, content:{type:'text',text}}`。

（见 b0ff9948:docs/plans/2026-07-10-acp-research.md:66）

## transport-lifecycle

传输：**Stdio (NDJSON)** 为主，HTTP/SSE 与 WebSocket 仍在 RFC 阶段。生命周期：`initialize`（握手 protocolVersion + capabilities）→ `session/new`（创建）/ `load` / `resume` → `session/prompt`（发消息）↔ `session/update`（流式推送）/ `session/request_permission`（权限申请）/ `session/cancel`（取消）→ prompt response 的 `stopReason`（`end_turn` / `cancelled` / `max_tokens` / `refusal`）。

（见 b0ff9948:docs/plans/2026-07-10-acp-research.md:24）
