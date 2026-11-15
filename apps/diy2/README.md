# @diy-agent/app-diy2

diy2 的新客户端：Vite + React 19 + `@diy-agent/entity-chat`（UI）+ `@diy-agent/entity-runtime`（运行时）。

```bash
# 两个进程（nohup 后台，日志 /tmp/diy2.log、/tmp/diy2-api.log）
./scripts/dev.sh

# 或分开起
npm run dev -w @diy-agent/app-diy2        # UI  http://localhost:5190
npm run dev:server -w @diy-agent/app-diy2 # API http://localhost:5191
```

UI 有三个可切换的表面（同一份时间线 + 同一个 store，只换渲染器）：

| 表面 | 用的东西 |
|---|---|
| Astryx（默认） | `@astryxdesign/core` 的 Chat 组件族 + lab 的 `ChatVirtualizer` |
| assistant-ui | 官方模板组件（已复制进 `entity-chat/src/assistant-ui/`） |
| shadcn | 裸 Tailwind + 自己的 `Markdown` / `BotAvatar` |

数据：`~/.diy/diy2/diy2.db`（node:sqlite）。落盘的东西：

- `rooms`：容器元数据（项目/任务的名字、type、data、modelKey）——重启后原样回来
- `room_members`：成员关系（`@` 路由据此生效）
- `bots`：bot 身份
- `entity_items`：消息 / 工具条目（展示用时间线）
- `room_entries`：房间公共日志（进各 bot 上下文的那份）
- `session_state`：每个 bot 的上下文快照 + `log_seq` 回放水位
- `deliveries`：每个 (message, bot) 的投递状态（queued → delivering → delivered/failed）

聊天走真实模型（默认 `chen56@opencode-go/deepseek-v4.1-flash`，可在房间头部 / 设置里改），
工具：`read` / `write` / `edit` / `bash`（`DIY2_TOOLS=files` 可关掉 bash）+ `ask` 提问卡。

多 agent（容器一个 primary）：
- 没有 @：**只有 primary 回复**
- `@名字`：只让命中的 bot 回复（primary 也可以被 @）
- `@all`：全体回复
- 输入框里打 `@` 会弹出本容器可 @ 的 bot 列表（primary 带标记）
- 同一轮内多个 bot 并行；轮次之间串行；运行中也能插话（发送不变成停止，
  停止在顶部 SpeakingBar，可按成员停）

接口（`/api`，Vite 代理到 5191）：

```
GET    /api/rooms
POST   /api/rooms                      { type, name, modelKey?, data?: { dir?, projectId? } }
PATCH  /api/rooms/:id                  { name?, modelKey? }
POST   /api/rooms/:id/bots             { botId }              # 借用已有 bot
GET    /api/bots
POST   /api/bots                       { name, homeRoomId, modelKey? }
GET    /api/rooms/:id/history?afterSeq=
GET    /api/rooms/:id/deliveries
GET    /api/rooms/:id/asks
GET    /api/rooms/:id/sessions
POST   /api/rooms/:id/sessions/:botId/compact   { keepLast?, maxChars? }
POST   /api/rooms/:id/asks/:askId      { values?, fields?, text? }
POST   /api/rooms/:id/chat             { text, recipients? } → SSE { kind:'item'|'delivery'|'running'|'error'|'done' }
POST   /api/rooms/:id/cancel           { botId? }             # 不传 = 停整个房间
GET    /api/rooms/:id/events           # 常驻 SSE（带心跳）：后台 bot 的动静也能收到
```

约束：

- `type: 'task'` 必须带有效的 `data.projectId`（侧栏按它分组，孤儿任务等于隐身）
- 服务端默认只用于本机实验：没有鉴权，且带 `bash`/`write` 工具
