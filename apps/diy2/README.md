# @diy-agent/app-diy2

diy2 的新客户端（切片）：Vite + React 19 + `@diy-agent/entity-chat` + `@diy-agent/entity-runtime`。

```bash
# 两个进程
npm run dev -w @diy-agent/app-diy2        # UI  http://localhost:5190
npm run dev:server -w @diy-agent/app-diy2 # API http://localhost:5191
```

UI 用 assistant-ui 官方模板组件（templates/minimal 的 Thread/Composer/Markdown/ToolFallback，已复制进
`pkgs.ts/ui/entity-chat/src/assistant-ui/` 并在 AssistantMessage 里加了作者行与 notice 渲染）。

数据：`~/.diy/diy2/diy2.db`（node:sqlite）。
- `bots` / `entity_items` 已落盘；项目/任务目前是内存种子（重启重置）
- 聊天走真实模型（默认 `chen56@opencode-go/deepseek-v4.1-flash`），带一个 `get_time` 工具

多 agent：
- `route(entity, bots, text)`：`@all` / `@名字`，没有 @ 时默认全体参与者
- 每个 (message, bot) 一条 outbox 记录（queued → delivering → delivered/failed），落 sqlite
- 同一轮内多个 bot 并行；轮次之间串行；UI 在用户消息下显示投递 chip

接口：

```
GET  /api/entities
POST /api/entities                  { kind, name, dir?, projectId? }
PATCH /api/entities/:id             { name?, modelKey? }
POST /api/entities/:id/bots         { botId }        # 借用已有 bot
POST /api/bots                      { name, homeEntityId, modelKey? }
GET  /api/entities/:id/history?afterSeq=
GET  /api/entities/:id/deliveries
POST /api/entities/:id/chat         { text } → SSE { kind:'item'|'done'|'error' }
```
