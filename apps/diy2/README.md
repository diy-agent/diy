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
| `./sha.sh start`（= `diy2 web`） | prod    | `~/.diy2`             | production  | 5192                                |

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
其它     --name / --tools / --compact-keep / --compact-chars / --web-dir
模型      <home>/model.yaml（**只有这一份**：不读 --model-config、不回落 ~/.diy/model.yaml）
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
diy2 web --detach       # 起在后台（脚本 / 启动器用）；输出落 <home>/log/stdout.log
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

### 日志：都落在 `<home>/log/`

不管前台还是 `--detach`，输出与日志都收在**数据根的 `log/`**（lab 实例 = 自己的
`run/diy2/lab/log/`）—— 不要再 `nohup … >> /tmp/xxx.log 2>&1`：/tmp 会被清、多实例互相
覆盖（实测现场：prod 的输出曾散落在 /tmp/diy2-prod-stdout.log）。

| 落点                                                                            | 谁写                                                              | 是什么                                                                 |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `log/app/YYYY-MM-DD.log`                                                        | 服务端 OTel 装配（`server/log.ts`）                               | **结构化主账**（jsonl；按天切 + 10MB×5 份 + 留 14 天）                 |
| `log/stdout.log`                                                                | `web --detach` 把子进程 fd1/fd2 接到这（`src/cli/detach-log.ts`） | 人读终端行 ⊕ 裸 stderr（未捕获异常 / 第三方 console）；超 10MB 滚 `.1` |
| `log/job/runs/<日期>/<id>/out.log`                                              | 后台作业                                                          | 每条 run 自己的输出（`jobs.tail` RPC 能读尾巴）                        |
| `log/network/` · `log/error/` · `log/main.log` · `log/cli.log` · `log/crashes/` | **diy-app**（Electron 侧，共用数据根时）                          | 不是 diy2 server 写的；排查 Electron 侧才看                            |

前台 `diy2 web` 的输出直接进终端（Ctrl-C 一起退），**不落** `stdout.log` —— 要留档用
`--detach`，或前台自己 `| tee`。日志写盘失败不带崩进程（旁路，只往 stderr 报一行）。

标准重启 / 观察姿势：

```bash
diy2 web --restart --detach          # 先停同数据根实例再后台起；输出自动落 <home>/log/stdout.log
tail -f ~/.diy2/log/stdout.log       # 看人读输出（启动期端口 / UI 路径 / ERROR 都在这）
grep '"level":"error"' ~/.diy2/log/app/$(date +%F).log   # 结构化错误（机器 grep）
```

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

UI 表面只剩 **shadcn** 一份（裸 Tailwind + 自己的 `Markdown` / `BotAvatar`）。历史上的三面
（assistant-ui 2026-11-23 删、Astryx 2026-11-26 删）与删除理由见
`docs/plans/2026-11-24-surface-parity.md` §7；注册表 `ChatSurface[]` 的形状刻意保留多面能力。

数据：`<数据根>/diy2.db`（node:sqlite；生产数据根 `~/.diy2`，lab 见上表）。落盘的东西：

- `rooms`：容器元数据（项目/任务的名字、type、data、modelKey）——重启后原样回来
- `bot_roles`：**角色**（名字 / 颜色 / 人格 / 默认应答 / 模型 / 推理强度），一类房间共享一批
- `room_members`：成员关系的**镜像**（真源是角色表 + 房间 type，启动时按派生结果盖写；
  留着它只为了让「实体级覆盖」有个落点，本期不写）
- `entity_items`：消息 / 工具条目（展示用时间线）
- `room_entries`：房间公共日志（进各角色上下文的那份）
- `session_state`：每个 (房间, 角色) 的上下文快照 + `log_seq` 回放水位
- `deliveries`：每个 (message, 角色) 的投递状态（queued → delivering → delivered/failed）

老库里的 `bots`（每个容器一个同名 bot）由启动时的 `migrateBots` 折成角色，旧表改名 `bots_v0`
留档；会话键跟着改（`session_state.bot_id` → `bot_role_id`）。为什么这么折见
`docs/plans/2026-11-24-bot-role.md`。

聊天走真实模型，模型数据**只来自本数据根**的 `<home>/model.yaml`（+ `<home>/providers.custom.yaml`
+ `<home>/data/models.dev.json` 快照）。缺这份配置是一个**明确状态**：服务端照常起，界面上不出假模型，
顶部挂横幅指向那份路径 —— 不会去别处找一份能用的（曾经的 `--model-config` 与「回落
`~/.diy/model.yaml`」已删：那两条会让人在 `~/.diy/diy2` 用自己的库、发别人的账号）。
工具：`read` / `write` / `edit` / `bash`（`--tools files` 可关掉 bash）+ `ask` 提问卡。

多 agent（**一类房间共享一批角色**，每类一个 primary）：

- 没有 @：**只有 primary 回复**
- `@名字`：只让命中的角色回复（primary 也可以被 @）
- `@all`：全体回复
- 输入框里打 `@` 会弹出本房间可 @ 的列表（primary 带标记）
- 成员是**派生的**：`type` 与该房间相同的角色全部在场，改一个角色 = 该类型所有房间同时变
  （没有「把 bot 拉进房间」这个动作；设置页 `/settings/roles` 是它的编辑入口）
- 同一轮内多个 bot 并行；轮次之间串行；运行中也能插话（发送不变成停止，
  停止在顶部 RoomStatusBar，可按成员停）

接口：**命令面走 RPC**（`/rpc` 的 WebSocket；方法树 = `@diy-agent/protocol` 的 `diy2Api`：
`info` / `rooms` / `roles` / `chat` / `asks` / `drafts` / `journal` / `models` / `links`），
HTTP 只剩探活 `GET /api/info`（`app` + `home` 是判据）。没有 REST、也没有 SSE。

`roles` 就是「谁在这类房间里说话」：一类房间共享同一批角色，成员由
`membersOfType(roles, room.type)` 派生 —— 所以**没有** `rooms.addMember` 这个方法。

### 事件流：一条连接，多话题（##stream-mux）

> 这一节写于 SSE 时代（2026-11-22 迁到 RPC/WS：订阅是 `/rpc` 上的 `room` 流，发送是
> `chat.chat` 这类 unary 方法）。**纪律没变**：连接数 = 标签页数、房间是连接上的话题、
> 受理即返；下面出现的 `POST /api/...` 与 SSE 只是当时的具体载体。

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
