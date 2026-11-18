# @diy-agent/app-diy2

diy2 的新客户端：Vite + React 19 + `@diy-agent/entity-chat`（UI）+ `@diy-agent/entity-runtime`（运行时）。

## 开发（单端口）

```bash
./sha.sh lab          # 开发实例：一个端口，UI（vite + HMR）与 /api 同源
./sha.sh stop         # 停本 worktree 起的实例（--all = 本机全部）
./sha.sh list         # 本机实例表：pid / 端口 / 数据根 / 变体 / 入口
./sha.sh port|home    # 本变体的端口 / 数据根（脚本用）
./sha.sh status       # 一眼看清
```

没有「两个进程 + 代理」了：`server/dev.ts` 把 vite 以 middleware 挂进 diy2 自己的
HTTP server，**dev 与 prod 拓扑一致**（一个进程、一个地址、`/api` 同源、SSE 不穿代理）。
端口不再写死在任何脚本里，缺省 `0` = 内核分配，实际端口落在 `<数据根>/app.port` 并打印出来。

改 `server/**` 或 `entity-runtime` 源码 → 自动重启（`sha.sh lab` 的看护循环）；
改 UI → HMR，不重启。

验证（不用开浏览器）：

```bash
PORT=$(./sha.sh port)                       # 本实例实际端口（app.port）
curl -s "http://127.0.0.1:$PORT/api/info"   # 身份：app / pid / port / home / env / variant
curl -s "http://127.0.0.1:$PORT/api/rooms"  # 数据面
./sha.sh test                               # 单测（配置裁决 / 端口裁决 / 注册表解析）
./sha.sh check                              # 类型 + lint
```

旧的 `npm run dev` / `scripts/dev.sh` / `scripts/stop.sh` 已删除：全部入口收敛到 `./sha.sh`，
根目录 `./sha.sh lab --app diy2` 起的就是同一条开发路径。

## 运行空间：变体 / 数据根 / 端口

变体只决定**运行空间**，不是构建目标（lab / staging 与 prod 跑同一份代码）：

| 命令 | 变体 | 数据根 | 环境 | 端口 |
|---|---|---|---|---|
| `./sha.sh lab` | lab | `apps/diy2/build/lab/home` | development | 0（内核分配） |
| `./sha.sh staging [--build]` | staging | `apps/diy2/build/staging/home` | development | 0 |
| `./sha.sh start`（= 全局 `diy2`） | prod | `~/.diy/diy2` | production | 5192 |

全部可覆盖，优先级与仓库其它 app 同一套裁决（实现只有一处：`server/config.ts`）：

```
数据根  DIY2_HOME  > 变体缺省
端口    --port / -p > DIY2_PORT > <home>/app.port 记录 > 缺省（生产 5192，其余 0）
环境    DIY2_ENV = production|development|test（无法识别按 production）
变体    DIY2_VARIANT（缺省：产物类命令 prod，开发类命令 lab）
其它    DIY2_MODEL_CONFIG / DIY2_COMPACT_KEEP / DIY2_COMPACT_CHARS / DIY2_TOOLS=files
        DIY2_NAME（多实例的名字）/ DIY2_REGISTRY（注册表目录，测试隔离用）
```

两条硬规则：

- **端口不承载身份**：`app.port` 只是缓存，真正的判据是 `GET /api/info` 自报的 `home`。
  所以 `diy2` 第二次敲会**复用**在跑的实例（`--restart` 才先停再起），不会 EADDRINUSE 崩，
  也不会连到别的数据根/别的 worktree 的实例上。
- **dev / test 拒绝生产数据根**：`DIY2_ENV` 泄漏成 production 时 `./sha.sh lab` 直接拒起
  （`DIY2_ALLOW_PROD_HOME=1` 才放行）。dev/test 也**不吃** 5192（无论来自 `app.port` 记录
  还是继承的 `DIY2_PORT`）—— 那会把生产门牌占住。

实例在启动时**自报**到 `~/.diy/dev/apps/<pid>.json`（与 diy-app / workbench 同一张表，
口径来自 `@diy-agent/dev-paths`）：dev 启动器、remote 发现、`./sha.sh list` 都读它。
`stop` 按注册表停（不按端口 kill —— 那会误杀连着的浏览器与 SSE）。

## 全局命令 `diy2`（一条命令起服务）

```bash
cd apps/diy2 && ./sha.sh build     # → build/prod/{web,server}
npm link                           # 之后 `diy2` 在 PATH 里

diy2                    # 已有同数据根实例 → 复用；否则起服务（前台，Ctrl-C 停）
diy2 -p 6000            # 换端口（0 = 内核分配）
diy2 --no-open          # 不自动打开浏览器
diy2 --restart          # 先停同数据根实例再起
diy2 --home /tmp/x      # 换数据根（缺省 ~/.diy/diy2；--data-dir 是旧名）
diy2 --detach           # 起在后台（脚本 / 启动器用）
diy2 list               # 本机所有 diy2 实例
diy2 stop [--all]       # 停本数据根（或本机全部）
diy2 port | diy2 home   # 脚本用：打印端口 / 数据根
```

构建产物是两件：`build/prod/web/`（vite build 的 UI）和 `build/prod/server/index.mjs`
（vite lib/ssr 打的服务端单文件，工作区包都打进去了）。全局命令只依赖这两件，
不需要在运行时装 vite / tsx。发布时 `files` 只带 `bin/` + `build/prod/`。

一键试跑构建产物（不装全局）：`./sha.sh start`；沙箱验收：`./sha.sh staging`。

### 老机器上的 `diy2` 冲突

如果之前装过旧的 `@diy-agent/app-chat`（##478 已删除），全局会留一条**悬空**软链，
`npm link` / `npm i -g` 会报 `EEXIST: file already exists`：

```bash
rm -f "$(npm prefix -g)/bin/diy2"   # 目标已不存在，删掉无副作用
cd apps/diy2 && npm link
```

### 发包

`files` 只带 `bin/` + `build/prod/`，`prepublishOnly` 会先 `./sha.sh build`；服务端产物已经把
工作区包和第三方依赖都内联了，所以装上就能跑，不需要额外装依赖。发布前记得去掉
`"private": true`（现在是防手滑）。

UI 有三个可切换的表面（同一份时间线 + 同一个 store，只换渲染器）：

| 表面 | 用的东西 |
|---|---|
| Astryx（默认） | `@astryxdesign/core` 的 Chat 组件族 + lab 的 `ChatVirtualizer` |
| assistant-ui | 官方模板组件（已复制进 `entity-chat/src/assistant-ui/`） |
| shadcn | 裸 Tailwind + 自己的 `Markdown` / `BotAvatar` |

数据：`<数据根>/diy2.db`（node:sqlite；生产数据根 `~/.diy/diy2`，lab 见上表）。落盘的东西：

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

接口（`/api`，与 UI 同源同端口）：

```
GET    /api/info                       # 实例身份：app / pid / port / home / env / variant
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
