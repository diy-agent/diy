> ⚠️ **2026-11-23 起部分被取代**：产物固定 `build/prod`（一份），数据根不再按 launch/variant 推导，
> 改为显式 `--home`（非生产缺失即报错）、落在 `run/<app>/<label>`。见
> `docs/plans/2026-11-23-build-run-layout.md`。下文保留当时的推理与决策过程。

# diy2 的 dev / build 架构对齐：DIY2_HOME、端口、dev 工具整体控制

> 2026-11-18 · 落地记录（方案 + 已实现的改动）。**不考虑兼容性**：旧入口（`npm run dev` /
> `scripts/dev.sh` / 按端口 kill）直接删除，不保留双轨。
> 前置：`2026-11-12-diy2-alignment.md`（领域侧拍板）、`.diy/knowledge/rule/dev.md`（worktree / 实例规则）。

---

## 0. 结论先行

1. **配置唯一真源** `apps/diy2/server/config.ts`：数据根 / 端口 / 环境 / 变体 / 产物目录只在这里裁决。
   改造前同一件事散在 5 处（npm script 的 `--port 5190`、`scripts/dev.sh` 的 5190+5191、
   `vite.config.ts` 的 proxy 5191、`server/index.ts` 的 `DIY2_PORT ?? 5191`、`bin/diy2` 的 5192），
   改一个端口要改五处且必然漏。
2. **dev = 单端口、单进程**：`server/dev.ts` 把 vite 以 middleware 挂进 diy2 自己的 HTTP server，
   dev 与 prod 拓扑一致（同源、无代理、SSE 不穿代理）。端口缺省 `0` = 内核分配。
3. **端口不承载身份**：`app.port` 只是缓存；判据是 `GET /api/info` 自报的 `home`。
   `diy2` 第二次敲 → 复用（`--restart` 才先停再起），不再 EADDRINUSE 崩、也不会连到别人的实例。
4. **入口只剩 `./sha.sh`**（与 `apps/diy-app` 同构）：`dev` / `lab` / `staging` / `start` /
   `build` / `list` / `stop` / `port` / `home` / `status` / `check` / `test` / `fix` / `clean`。
   `package.json` 只管 `bin` 与 `prepublishOnly`（`./sha.sh build`）。
5. **实例自报**到 `~/.diy/dev/apps/<pid>.json`（与 diy-app / workbench 同一张表），
   dev 启动器 / remote / `./sha.sh list` 因此能看见 diy2。

---

## 1. 改造前的现场（证据）

| # | 问题 | 证据（改造前） |
|---|---|---|
| 1 | 端口 5 处硬编码 | `package.json` `dev: vite --port 5190`；`scripts/dev.sh` 5190+5191；`vite.config.ts` proxy→5191；`server/index.ts` `DIY2_PORT ?? 5191`；`bin/diy2` 5192 |
| 2 | 无端口记录 / 无身份 | `server/index.ts` 模块顶层 `server.listen`，`EADDRINUSE` 直接抛 |
| 3 | dev 污染生产数据根 | `DIY2_DATA_DIR ?? ~/.diy/diy2`；dev 与全局命令共用同一个 `diy2.db` |
| 4 | 隔离不彻底 | `entity-runtime/src/providers.ts` 写死 `~/.diy/model.yaml`（换 home 也换不掉配置） |
| 5 | 无实例控制面 | 日志 `/tmp/diy2*.log`（多实例互相覆盖）；`scripts/stop.sh` **漏了** `-sTCP:LISTEN`（会误杀 SSE 客户端），与 `dev.sh` 不一致 |
| 6 | 入口三套并存 | `package.json` scripts + `scripts/*.sh` + `sha.sh`；`sha.sh` 没有 `dev`/`lab` → 根 `./sha.sh lab --app diy2` 起不来 |
| 7 | 架构债：import 即 listen | 装配在模块顶层 → 三个入口各写一份，没法在 vite middleware 里复用 handler |

实测补一条：**`vite --port 0` 不生效**（v8 落到 5173），所以「随机端口」必须由我们自己裁决
（用 node 的 `listen(0)`），不能指望 vite 传 0。

---

## 2. 沿用的裁决（来自 `~/git/diy/_diy` 与主仓 `apps/diy-app`）

- **变体只决定运行空间**：产物一份，数据根 `build/<variant>/home`、`DIY_ENV` 跟变体走
  （`_diy/apps/dev/sha.sh` 头注：lab / staging 不是构建目标）。
- **端口裁决纯函数**：`cliPort` > `env` > `app.port` 记录 > 缺省；生产固定，dev/test 用 0
  （`apps/diy-app/src/runtime.ts::resolvePort`）。
- **端口不承载身份**：探活后必须验 `diyHome`（`apps/diy-app/src/cli/probe-instance.ts`，##328）。
- **实例自报注册表** + 读侧按 pid 存活过滤、顺手删死条目（`core/instance-registry.ts`）。
- **CLI 语义 = 探活 → 验身份 → 复用或拉起**，不是「起不来就崩」。
- **dev 拒绝继承来的生产根**（`core/dev-home.ts`）—— diy2 侧对应 `server/dev.ts` 的 `isProdHome` 闸门。
- **`DIY_ENV` 三态，非法值按 production**（宁可少开能力）。

差异（用户裁）：diy2 **全域 `DIY2_*` 前缀**，不借用 `DIY_HOME` / `DIY_PORT`
（代价与收益见 `README` 的「运行空间」表；共享的只有注册表位置口径 `~/.diy/dev/apps`）。

---

## 3. 已实现的改动

### 3.1 配置真源 `server/config.ts`

- `resolveConfig()`：唯一入口（server / dev / bin 都问它）。纯函数拆开便于单测：
  `parseEnv` / `defaultVariant` / `resolveHome` / `resolvePort` / `isProdHome` / `samePath`。
- 裁决表：

  | 项 | 来源（高 → 低） |
  |---|---|
  | 数据根 | `DIY2_HOME` > 变体缺省（生产 `~/.diy/diy2`；非生产 `<appRoot>/build/<variant>/home`） |
  | 端口 | `--port/-p` > `DIY2_PORT` > `<home>/app.port` > 缺省（生产 5192 / 其余 0） |
  | 环境 | `DIY2_ENV`（production / development / test；非法 → production） |
  | 变体 | `DIY2_VARIANT`（产物类命令缺省 prod，开发类缺省 lab） |
  | model.yaml | `DIY2_MODEL_CONFIG` > `<home>/model.yaml` > `<repo>/build/<variant>/home/model.yaml` |
  | UI 产物 | `DIY2_WEB_DIR` > `<appRoot>/build/<variant>/web`（不存在 = 不提供静态服务） |

- **两条反向规则**（都是「错了不报错、只会静默用错数据」的类型）：
  1. 非生产**拒绝**继承来的生产数据根（`DIY2_ALLOW_PROD_HOME=1` 才放行）；
  2. 非生产**不吃** 5192 —— 无论来自 `app.port` 记录还是继承的 `DIY2_PORT`
     （实测：dev 会话里 `DIY2_PORT=5192` 是宿主进程导出的，照单全收就撞 EADDRINUSE）。

### 3.2 装配与入口分离

- `server/app.ts`：`createDiy2App({config, webDir, port})` → `{handle, info, close}`，**不 listen**。
  路由 / SSE / seed 一行没动（只把顶层 `const` 改成装配期赋值），711 行闭包化的收益不值那个风险。
- `server/index.ts`：生产入口（也是 `bin/diy2` 拉起的那件产物）：装配 → 监听 127.0.0.1 →
  写 `app.port` + 注册表 → SIGINT/SIGTERM 清理。EADDRINUSE / 「同 home 已有实例」都有明确话术。
- `server/dev.ts`：单端口开发入口。vite `middlewareMode` + `server.ws.server = httpServer`
  （HMR 复用同一端口，**不再另开 24678**）；`/api` 走 app.handle，其余走 `vite.middlewares`。
  服务端代码变更 → 退出码 **75**（`EX_TEMPFAIL`）= 「请重起我」，`sha.sh dev` 的看护循环据此重启；
  UI 变更走 HMR 不重启。信号转发给子进程（否则 kill supervisor 会把 tsx 留成孤儿）。

### 3.3 `bin/diy2`（全局命令）

- 子命令：`start`（缺省）/ `list` / `stop [--all|--worktree <dir>]` / `port` / `home`。
- 语义：探活 → 验身份 → **复用**（打印 + 开浏览器）或拉起；`--restart` 先停；`--detach` 后台。
- 发布形态（发布产物里没有源码）→ 只把命令行参数翻译成 `DIY2_*`，**不自己算端口**；
  身份判据与 `server/probe.ts` 一致（`app` + `home`），bin 里那份是等价实现（纯 JS，不能 import TS 源）。

### 3.4 `sha.sh`（唯一入口）

| 命令 | 作用 |
|---|---|
| `dev` / `lab` | 单端口开发 + 看护循环（退出码 75 → 重启）；`lab` = 根 `./sha.sh lab --app diy2` |
| `staging [--build]` | 跑本变体产物 + 沙箱数据根 `build/staging/home`（改码不波及） |
| `start` | 真生产语义（= 全局 `diy2`，`~/.diy/diy2`） |
| `build` / `build-web` / `build-server` | 产物 → `build/<variant>/{web,server}` |
| `list` / `stop [--all]` / `port` / `home` / `status` | 实例控制面（读注册表，不按端口猜） |
| `check` / `test` / `fix` / `clean` / `typecheck` / `lint` / `fmt` | mono 入口组装用的标准件 |

`stop` 缺省按 **worktree** 收口（这个 worktree 里 lab + staging 一起停），`--all` 才动全机。

### 3.5 剥离的旧东西

- `apps/diy2/scripts/dev.sh`、`scripts/stop.sh`：删除（按端口 kill、日志写 /tmp、pid 文件不清理）。
- `package.json` scripts：只剩 `prepublishOnly: ./sha.sh build`（仓库口径：package.json 不管脚本）。
- `vite.config.ts` 的 `server.proxy`：删除（单端口同源，没有代理可配）。

### 3.6 隔离补洞（entity-runtime）

`providers.ts` 的 `~/.diy/model.yaml` 参数化：`DIY_MODEL_CONFIG` > `DIY_HOME/model.yaml` >
`~/.diy/model.yaml`（导出 `modelConfigPath()` 便于单测）。原先「换数据根」只隔离了 sqlite，
配置仍读生产真账号 —— lab 里的实验会用生产 key，而人以为在沙箱里。

---

## 4. 验证（都已实跑）

| 验证 | 结果 |
|---|---|
| `./sha.sh lab` | 单端口起，`/`(200, vite HTML) + `/api/info`(200) + `/api/rooms`(200) 同一端口；**无 24678** 额外监听 |
| 注册表 | `~/.diy/dev/apps/<pid>.json` 出现，含 app/launch/port/diyHome/variant/env/worktree/parents；`parent` 链能看到 `bash ./sha.sh lab` |
| 改动服务端代码 | `touch server/app.ts` → 打印「服务端代码变了 → 重启」→ 新端口 + 注册表回填 |
| `./sha.sh stop` | 按 worktree 停掉，`app.port` 删除，`lsof` 无监听，注册表清理 |
| `./sha.sh build` + `./sha.sh staging` | `build/staging/server/index.mjs` 单文件（关掉 code splitting），UI 静态服 200 |
| `bin/diy2` 复用 | 同 home 第二次敲 → `diy2 已在运行：http://…（pid=… home=…）`，退出码 0 |
| `bin/diy2 stop` | 停实例 + 删 `app.port` |
| `./sha.sh test` | 22 例（配置 / 端口 / 数据根 / 注册表解析）全绿 |
| `./sha.sh check` | tsc + oxlint 0 warning 0 error |

---

## 5. 已知取舍 / 后续

1. **`vite --port 0` 不可用** → 端口由 diy2 自己 `listen(0)`。dev 因此每次重启端口会变
   （记在 `app.port`，`./sha.sh port` 读它）；要稳定端口给 `DIY2_PORT=<n>`。
2. **注册表路径逻辑在 diy2 里有一份本地实现**（`server/registry.ts`）：`@diy-agent/dev-paths`
   的 `main` 指 `dist/`，干净 worktree 里没有构建产物 → dev 会连带起不来。
   覆盖变量沿用同一组名字（`DIY2_REGISTRY` > `DIY_INSTANCE_REGISTRY` > `DIY_DEV_HOME`），
   并且写的是**同一张表**（读侧互通）。若以后 dev-paths 改成 `exports` 指 src，这里可收编。
3. **`bin/diy2` 的身份判据有一份等价的纯 JS 实现**：发布形态不能 import TS 源，
   两处判据都是「`app === 'diy2'` 且 `home` 同路径」，改动要同改（注释互相指认）。
4. **diy2 的 lab 数据根在 `apps/diy2/build/<variant>/home`**（不是仓库根 `build/<variant>/home`）：
   避免与 diy-app 的 `app.port` 抢同一份文件。代价：`model.yaml` 真配置由根 `./sha.sh sync`
   投影到**仓库根**的变体数据根，diy2 读不到本地的就会去读那里（配置里已实现这条链）。
5. `server/app.ts` 仍是 800 行单文件（路由 + SSE + seed 装配）。本次只做了「装配与监听分离」，
   按域拆路由是下一件事（见 `2026-11-12-diy2-alignment.md` 的 RPC 面）。
