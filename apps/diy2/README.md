# @diy-agent/app-diy2

diy2 的新客户端：Vite + React 19 + `@diy-agent/entity-chat`（UI）+ `@diy-agent/entity-runtime`（运行时）。

## 开发（单端口）

```bash
./sha.sh lab          # 开发实例：一个端口，UI（vite + HMR）与 /api 同源
./sha.sh stop         # 停本 worktree 起的实例（--all = 本机全部）
./sha.sh list         # 本机实例表：pid / 端口 / 数据根 / 入口
./sha.sh port|home    # 本 launch 的端口 / 数据根（脚本用）
./sha.sh status       # 一眼看清
```

没有「两个进程 + 代理」了：`server/dev.ts` 把 vite 以 middleware 挂进 diy2 自己的
HTTP server，**dev 与 prod 拓扑一致**（一个进程、一个地址、`/api` 同源、SSE 不穿代理）。
端口不再写死在任何脚本里，缺省 `0` = 内核分配，实际端口落在 `<数据根>/app.port` 并打印出来。

**端口有粘性**：监听成功就把端口写进 `<数据根>/app.port`（**退出不删**），之后每次启动（包括改
服务端代码触发的自动重启、Ctrl-C 再起）都还回同一个端口 —— 书签与已经开着的标签页不会失效。
只有那个端口被别人占了才会换一个（内核分配）并重写记录。

那个文件只记「**上次用过的端口**」，**不是存活证据**（进程崩了它不会变，端口也可能已被别人占住）。
「现在有没有人在跑」只能靠探活：`GET /api/info` 自报的 `home` + 注册表里的 `pid` ——
`./sha.sh port` 走的就是这条路，它不读 `app.port`。

改 `server/**` 或 `entity-runtime` 源码 → 自动重启（`sha.sh lab` 的看护循环）；
改 UI → HMR，不重启。

验证（不用开浏览器）：

```bash
PORT=$(./sha.sh port)                       # 本实例实际端口（探活拿的，不是读 app.port）
curl -s "http://127.0.0.1:$PORT/api/info"   # 身份：app / pid / port / home / env / launch
curl -s "http://127.0.0.1:$PORT/api/rooms"  # 数据面
./sha.sh test                               # 单测（配置裁决 / 端口裁决 / 注册表解析）
./sha.sh check                              # 类型 + lint
```

旧的 `npm run dev` / `scripts/dev.sh` / `scripts/stop.sh` 已删除：全部入口收敛到 `./sha.sh`，
根目录 `./sha.sh lab --app diy2` 起的就是同一条开发路径。

## 运行空间：数据根 / 端口 / 入口名

「入口名（launch）」只决定**运行空间**，不是构建目标（lab / staging / prod 跑同一份产物、同一份代码）：

| 命令                             | launch  | 数据根（本 worktree） | 环境        | 端口                                |
| -------------------------------- | ------- | --------------------- | ----------- | ----------------------------------- |
| `./sha.sh dev` / `lab`           | lab     | `run/diy2/lab`        | development | 0（内核分配，落 `<home>/app.port`） |
| `./sha.sh staging [--build]`     | staging | `run/diy2/staging`    | development | 0                                   |
| `./sha.sh start`（= `diy2 web`） | prod    | `~/.diy2`              | production  | 5192                                |

产物目录**固定** `apps/diy2/build/prod/{web,server,cli}`（一个包目录一份产物）：多份并存靠
worktree（每个 worktree 有自己的 `build/`），不靠 `<variant>/` 子目录。

参数面**只有 argv**（不读 `DIY2_*` 环境变量：谁都能改、看不见、还会继承），裁决只有一处
（`server/config.ts`），声明只有一处（`src/cli/options.ts`，zod + `.cliOption()`，与 CLI
同一个解析器 —— 服务端入口 / dev 入口 / 每个 CLI 命令读的是同一份形状）：

```
数据根   --home          > 缺省（生产 ~/.diy2；**非生产必须显式给** —— 入口脚本传 run/diy2/<launch>）
端口     --port / -p     > <home>/app.port 记录（仅非生产） > 缺省
         （生产 5192，其余 0；生产不拿记录当监听端口，只拿它当**探活候选**）
环境     --mode          （缺省由入口定：生产入口 production、dev 入口 development、测试 test）
入口名   --launch        （缺省由环境推：prod / lab / test）
其它     --name / --tools / --compact-keep / --compact-chars / --web-dir / --model-config
注册表   DIY_INSTANCE_REGISTRY / DIY_DEV_HOME（目录位置，不是运行配置；测试隔离用）
```

两条硬规则：

- **端口不承载身份，也不证明存活**：`app.port` 只是「上次用的端口」，判据是 `GET /api/info`
  自报的 `home`（+ 注册表 `pid`）。
  所以 `diy2 web` 第二次敲会**复用**在跑的实例（`--restart` 才先停再起），不会 EADDRINUSE 崩，
  也不会连到别的数据根/别的 worktree 的实例上。
- **非生产拒绝生产数据根**：`--home ~/.diy2` 在 dev 入口直接报错（`--allow-prod-home` 才放行）。
  非生产也**不吃**记录里的 5192 —— 那会把生产门牌占住。
- **非生产没给 `--home` → 报错退出**：不按 launch 推导（那条回落会把数据根放进产物树，`clean` 一跑就删库）。

实例在启动时**自报**到 `~/.diy/dev/apps/<pid>.json`（与 diy-app / workbench 同一张表，
口径来自 `@diy-agent/dev-paths`）：dev 启动器、remote 发现、`./sha.sh list` 都读它。
`stop` 按注册表停（不按端口 kill —— 那会误杀连着的浏览器与 SSE）。

## 全局命令 `diy2`（一条命令起服务）

```bash
cd apps/diy2 && ./sha.sh build     # → build/prod/{web,server,cli}
npm link                           # 之后 `diy2` 在 PATH 里

diy2 web                # 起服务（前台，Ctrl-C 停）；已有同数据根实例 → 复用。别名 `diy2 start`
diy2 web --open         # 就绪后打开浏览器（缺省不开）
diy2 web -p 6000        # 换端口（0 = 内核分配）
diy2 web --restart      # 先停同数据根实例再起
diy2 web --home /tmp/x  # 换数据根（缺省 ~/.diy2）
diy2 web --detach       # 起在后台（脚本 / 启动器用）
diy2 list               # 本机所有 diy2 实例（`-j` / `--json` = 单行 JSON）
diy2 stop [--all]       # 停本数据根（或本机全部；--worktree <dir> 只停那个 worktree）
diy2 port | diy2 home   # 脚本用：打印端口 / 数据根（裸值）
diy2 --help             # 命令树。裸 `diy2` 同上 —— **不会**起服务（没有隐式子命令）
```

**全部命令**（含 `web` 的进程生命周期）都在 `build/prod/cli/index.mjs` 里：命令树 / help /
`--json` / 退出码由 `@diy-agent/rpc/cli` 从 zod 声明生成，本地命令走 **mem 传输**（进程内，
不起服务、不开端口）。`bin/diy2` 只做三件事：找到 CLI 产物、清掉继承来的 `DIY2_*`、把 argv
原样交过去 —— 它自己不解析一个参数。

### 知识库：`diy2 facts`

真源是 `.diy/knowledge/**/*.md`（项目库优先，设备库 `~/.diy2/knowledge` 兜底），**不是**新的数据模型：

```bash
diy2 facts brief rule              # 列目录（或文件 rule/dev、前缀 app*）下每条知识的小节 + 首句
diy2 facts get rule/dev#worktree   # 取一节正文（路径可省 .md，不带 # 就是整篇）
diy2 facts find worktree,主仓      # 全文检索；多个关键词用逗号 = 全都要命中
diy2 facts status                  # 条目 / 小节 / 字节数 + 问题清单（项目库与设备级库分列）
```

`-j` 对所有命令都是「单行 JSON + `{ok,data}` 包装」；`brief/get/find` 的人类输出是缩进 JSON。

构建产物是三件：`build/prod/web/`（vite build 的 UI）、`build/prod/server/index.mjs`
（vite lib/ssr 打的服务端单文件）与 `build/prod/cli/index.mjs`（CLI 单文件），工作区包都打进去了。
全局命令只依赖这三件，不需要在运行时装 vite / tsx。发布时 `files` 只带 `bin/` + `build/prod/`。

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

UI 有两个可切换的表面（同一份时间线 + 同一个 store，只换渲染器，能力已对齐）：

| 表面           | 用的东西                                                       |
| -------------- | -------------------------------------------------------------- |
| Astryx（默认） | `@astryxdesign/core` 的 Chat 组件族 + lab 的 `ChatVirtualizer` |
| shadcn         | 裸 Tailwind + 自己的 `Markdown` / `BotAvatar`                  |

（第三面 assistant-ui 已于 2026-11-23 删除，理由见
`docs/plans/2026-11-24-surface-parity.md`。）

数据：`<数据根>/diy2.db`（node:sqlite；生产数据根 `~/.diy2`，lab 见上表）。落盘的东西：

- `rooms`：容器元数据（项目/任务的名字、type、data、modelKey）——重启后原样回来
- `room_members`：成员关系（`@` 路由据此生效）
- `bots`：bot 身份
- `entity_items`：消息 / 工具条目（展示用时间线）
- `room_entries`：房间公共日志（进各 bot 上下文的那份）
- `session_state`：每个 bot 的上下文快照 + `log_seq` 回放水位
- `deliveries`：每个 (message, bot) 的投递状态（queued → delivering → delivered/failed）

聊天走真实模型（默认 `chen56@opencode-go/deepseek-v4.1-flash`，可在房间头部 / 设置里改），
工具：`read` / `write` / `edit` / `bash`（`--tools files` 可关掉 bash）+ `ask` 提问卡。

多 agent（容器一个 primary）：

- 没有 @：**只有 primary 回复**
- `@名字`：只让命中的 bot 回复（primary 也可以被 @）
- `@all`：全体回复
- 输入框里打 `@` 会弹出本容器可 @ 的 bot 列表（primary 带标记）
- 同一轮内多个 bot 并行；轮次之间串行；运行中也能插话（发送不变成停止，
  停止在顶部 RoomStatusBar，可按成员停）

接口（`/api`，与 UI 同源同端口）：

```
GET    /api/info                       # 实例身份：app / pid / port / home / env / launch
GET    /api/stream                     # **一个 app 一条** SSE：首帧 {$conn}，之后按话题推
POST   /api/stream/subscribe           { conn, topic }        # topic = `room:<roomId>`
POST   /api/stream/unsubscribe         { conn, topic }
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
POST   /api/rooms/:id/sessions/:botId/compact   { keepTurns? }   # keepTurns = 保留最近几轮（0 = 压到头）
POST   /api/rooms/:id/asks/:askId      { values?, fields?, text? }
POST   /api/rooms/:id/chat             { text, recipients? } → { ok:true }（受理即返）
POST   /api/rooms/:id/cancel           { botId? }             # 不传 = 停整个房间
```

### 事件流：一条连接，多话题（##stream-mux）

**为什么要这样**：浏览器同源 HTTP/1.1 只有 6 条并发连接，且**按 profile 共用**。6 条常驻
SSE 占满后，同 profile 下对这个源的**所有**请求永久排队 —— 连 `/api/rooms/:id/history`、
点「停止」的 POST 都发不出去（不是慢，是不返回）。

之前的接口是「一个房间一条常驻 SSE（`GET /api/rooms/:id/events`）+ 每次发送再挂一条
`/chat` SSE 到整轮结束」，所以多页工作台里 **3 个聊天页**就能把 6 条吃满。现在的纪律：

- 连接数 = 打开的标签页数，**与开多少个房间无关**；
- 房间是连接上的话题（`room:<roomId>`），订阅 / 退订走上面那两条 POST；
- 帧统一为 `data: {topic, event}`；`$conn` 是首帧，身份**由服务端给**（客户端自造 id 会和
  上一个进程 / 上一次连接撞车）；
- `POST /api/rooms/:id/chat` **受理即返**（不再是一条挂到整轮结束的 SSE）。发送失败也走话题
  上的一条 `{kind:'error'}`，因为那时响应早就发完了；
- 一条话题只在**第一个**订阅者出现时接上房间广播，最后一个走了就摘掉 —— 没人看的房间不该
  还占着广播（老实现里它也占着一条连接）。

客户端侧：`chat-transport-rpc` 的 `StreamHub`（`src/hub.ts`），`watch()` = 订话题、
`post()` = 在已订话题上挂一份临时回调 + 一次 JSON POST。断线退避重连（0.5s→30s 封顶）
后按本地话题表重订，并对每个话题补一条 `{kind:'ready'}`，让上层补拉快照。

`GET /api/rooms` 的每行除了 `Room` 本身，还带两个**投影**字段（不属于领域类型 —— 它们
回答的是「侧栏这一行怎么显示」，写不回去）：

- `hasDraft`：有未发送的草稿（侧栏 ✎）
- `lastActivityAt`：该容器**最后一条 item** 的时刻（毫秒；一次 `GROUP BY` 查完，靠
  `entity_items(entity_id, at)` 覆盖索引，6409 条实测 0.7ms）。没聊过的容器**没有这个键**
  —— 侧栏显示「—」，不拿 `created_at` 冒充活动。改名字 / 改状态 / 加成员不产生 item，
  所以不算活动（要算就得给 `rooms` 加 `last_item_at` 并在多个写点都盖章，目前不做）。

约束：

- `type: 'task'` 必须带有效的 `data.projectId`（侧栏按它分组，孤儿任务等于隐身）
- 服务端默认只用于本机实验：没有鉴权，且带 `bash`/`write` 工具
