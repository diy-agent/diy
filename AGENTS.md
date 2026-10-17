# diy — 主 monorepo

> 主线 `pkgs.ts/`（TypeScript + Electron）。`pkgs/` Python 已归档 —— 代码在，**能力已放弃**，一切以 TS 为准。

## find — 去哪找

- `find.app` — `pkgs.ts/diy-app/` Electron 管控台：`src/main` 主进程 · `src/cli` CLI · `src/preload` · `src/renderer_solid` UI（Solid，主线）· `src/serve` Web 模式 · `src/shared` 跨层契约。包内细节见 `pkgs.ts/diy-app/AGENTS.md`
- `find.rpc` — `pkgs.ts/diy-rpc/` RPC 协议 + 传输（纯内核，零 Node/Electron 依赖）
- `find.template` — `pkgs.ts/diy-template/` 提示词模版引擎（零依赖）
- `find.talk` — `pkgs.ts/diy-talk/` 对话容器内核（事件 / 锚点 / 反应原语 + role 铁律，零依赖；消费者 `@diy/flow`（`Event` 原语）；接 ##319 存储/装配）
- `find.flow` — `pkgs.ts/diy-flow/` 工作流内核（定义 DSL + 泳道容器 + 插件槽 + 参数层 L2 + guard 求值 + 转移执行器 + 轨迹投影；零 IDE 依赖，唯一依赖 `@diy/talk` 的 `Event` 原语；接 ##319）
- `find.dev` — `pkgs.ts/diy-dev/` 独立的 `dev` 命令（ref 仓库引用 / vendor 镜像，cwd 即作用域）；细节见其 `AGENTS.md`
- `find.cfg` — `pkgs.ts/diy-app/src/runtime.ts` —— **`DIY_*` 环境变量契约的唯一源**
- `find.prompt` — 内置提示词 `pkgs.ts/diy-app/src/main/prompts/defaults.ts`（唯一真源）· 装配 `pkgs.ts/diy-app/src/main/services/prompt-registry.ts`
- `find.intent` — **需求契约 = 意图测试**：`pkgs.ts/diy-app/tests/cli.intent.*.test.ts` + `pkgs.ts/diy-template/tests/intent.*` + `pkgs.ts/diy-talk/tests/intent.*` + `pkgs.ts/diy-flow/tests/intent.*`
- `find.ui` — `pkgs.ts/diy-ui/`（包名 `diyui`）纯 TS / 零框架的**声明式 DOM 层**（原语 `Signal`/`Scope`/`Component`/`Cell`/`Scheduler` + provider `pi-tui`）；`web/`（Vite）是它的 demo 站
- `find.docs` — `docs/` 架构与方案 · `scripts/` 辅助脚本与冒烟脚本 · `pkgs/` Python 归档（不演进）

## entry — 实例四态（**先问：操作谁的数据 / 谁看 UI**）

> 一次构建 = 一个 **variant**（`DIY_VARIANT` = `prod|test|preview|lab`）：产物落 `pkgs.ts/diy-app/build/<variant>/**`，
> 数据落仓库根 `build/<instance>/home`。变体分根 ⇒ 预览 / 实验 / 测试**互不抢 outDir**，可并行。

| | `diy`（全局命令） | `./diy.sh` | `./sha.sh preview` | `./sha.sh lab` |
|---|---|---|---|---|
| 本质 | 发布版 CLI **客户端** | worktree 通用 CLI **客户端** | **GUI 启动器**（人看 HMR） | **GUI 启动器**（agent 实验/debug） |
| 用途 | 操作**生产**数据（真实任务·项目·agent·日志） | 连/起本 worktree 实例（按 `DIY_VARIANT`） | 用户确认 UI 效果 | agent 快速验证 / 临时实验 |
| variant | `prod` | `preview`（缺省，可 `DIY_VARIANT=lab` 覆盖） | `preview` | `lab` |
| 跑什么 | `node build/prod/cli/index.js` | `auto`：`build/<v>/cli/index.js` 优先（打包源更新则回退 `tsx`，`DIY_CLI_MODE=auto\|compiled\|tsx`） | Vite dev server + watch main/preload + Electron（HMR） | 同 preview |
| 要构建吗 | **要**（`sha.sh build` 出 `build/prod`） | **要**（否则 `build/<v>/main` 不存在 → CLI 报错退出） | **不用**（HMR 走 `loadURL`） | **不用** |
| 数据根 | `~/.diy`（**生产**） | `./build/<variant>/home` | `./build/preview/home` | `./build/lab/home` |
| `DIY_ENV` | `production` | `development` | `development` | `development` |

> 测试 = 第四态，不是 CLI：`pkgs.ts/diy-app/sha.sh test-intent` 起隔离 Electron（`DIY_VARIANT=test` + `DIY_HOME=mkdtemp` + `DIY_ENV=test`），产物在 `build/test/**`。

- `entry.choose` — **先问「操作谁的数据」**：真实任务/项目/agent → 全局 `diy`；worktree 改码·跑测试 → `./diy.sh`；看效果热更新 → `./sha.sh preview`；agent 实验 → `./sha.sh lab`。**别拿 `./diy.sh` 查生产任务**（它的 `./build/<variant>/home` 里没有 → 报「任务 N 不存在」）
- `entry.variant` — **`DIY_VARIANT` 是产物/数据分根的唯一轴**。vite 配置据此定 `outDir=build/<v>/*`；运行时据此选 `build/<v>/main`。缺省 `prod`（`./diy.sh` 缺省 `preview`）
- `entry.prod` — 全局 `diy` 一般由 main 上 `npm link` 而来 → 跑的是 **main 的 `build/prod` 编译产物**；worktree 里改的码它看不到
- `entry.client` — `diy` 与 `./diy.sh` **都是客户端、都不启动 GUI**：读 `$DIY_HOME/app.port` 探活并**验身份**（连上去问 `getAppInfo.diyHome` 比对，不是本数据根就拒绝复用、另起自己的，##328(实例身份只靠端口)），探不到才 spawn Electron（CLI 与 GUI 是两进程）。连哪个实例由 `DIY_HOME`（数据根）决定
- `entry.port` — 端口**不承载身份**：`DIY_PORT` > `app.port` 文件 > `runtime.ts::defaultPort(env)`（production=`18888` 门牌；development/test=`0` 随机）；裁决在 `runtime.ts::resolvePort`（纯函数、可单测），**非生产不沿用记录里的 `18888`**（旧版遗留的生产门牌，沿用＝dev 又占生产门牌）。`serve` 例外（浏览器地址，仍兜 18888）
- `entry.gui` — 起 GUI 两条路：`./sha.sh preview`（HMR，免构建）或 `sha.sh build` 后由 CLI 拉起
- `entry.launch-vs-client` — **起 GUI 的入口是启动器，不是客户端**：`./sha.sh preview|lab` 只 **spawn 新实例**，从不连已跑的那个（不读 `app.port`）—— 重复运行 = 开第二个实例 → 撞本数据根的 `SingletonLock` 并退出（`core/single-instance.ts::lockAdvice` 会打印「直接用它：`./diy.sh <命令>`」）。**要访问实例一律用客户端**，别指望再敲一次启动器
- `entry.variant-match` — **客户端与服务端变体必须配对**：`./sha.sh preview` 起的实例配 `./diy.sh`（缺省 `DIY_VARIANT=preview`）；`./sha.sh lab` 起的配 `DIY_VARIANT=lab ./diy.sh`。不配对 = 对着**另一个数据根**敲命令（症状：任务不存在 / 改完没反应）。`./diy.sh` 能连上 HMR 实例，是因为 `electron-dev.mts` 的 watch 已把 `build/<v>/main` 产出来了
- `entry.verify` — preview/lab 起来后用 `diy getAppInfo` 看 `diyHome` / `env` / `branch`，确认数据目录与启动参数（验证没起错数据根/变体）
- `entry.risk` — worktree 改码跑测一律 `./diy.sh`（隔离 `./build/<variant>/home`；会拒绝继承来的生产 `DIY_HOME`，需 `DIY_ALLOW_PROD_HOME=1` 放行）；**查/改真实数据才用全局 `diy`**
- `entry.home-guard` — 「继承来的生产 `DIY_HOME` 一律拒绝」的唯一决策点 `pkgs.ts/diy-app/src/main/core/dev-home.ts`（`./diy.sh` 与 `./sha.sh preview|lab` 共用；宿主 shell 常导出 `DIY_HOME=~/.diy`，不拦则 preview 开着生产数据根跑、还会把种子写进去）
- `entry.seed` — 空数据根的初始种入（`pkgs.ts/diy-app/src/main/core/seed.ts`）：**自动只跑一次**（`.seed-done` 标记，删掉的 provider 不会被种回来）、`preview`/`lab` 缺省自动、`DIY_SEED` 三态覆盖、`diy seed run` 手动补缺项；**生产根永不种入**
- `entry.inject` — `DIY_CLI` 由三个入口注入：`diy.sh` / `bin/diy` / `electron-dev.mts`；漏一处提示词就退化成裸 `diy`（→ 打到生产）

## tool — 命令

- `tool.check` — `./sha.sh check` **提交前唯一检查**：`tsc -b tsconfig.all.json --noEmit` + oxlint + rpc 浏览器安全 + 产物护栏 + 可执行位护栏（shell 脚本索引 mode 必须 100755，见 `scripts/check-exec-bit.sh`）
- `tool.fmt` — 格式化配置真源 = **各包 `.oxfmtrc.json`**（根 `.oxfmtrc.json` 兜底）：oxfmt **不读** `package.json` 里的 `oxfmt` 块，真实键名是 `tabWidth`/`printWidth`/`singleQuote`；根 `fix()` 扫 `pkgs.ts/` **全量（含 .md/.json）**；**fmt 未纳入 `check`**（存量 ~400 文件待规范化，见 ##323(oxfmt 配置腐坏)）
- `tool.test` — `./sha.sh test` 全仓 · `./sha.sh test-unit` 快测（不起 Electron）· 意图测试 `pkgs.ts/diy-app/sha.sh test-intent [片段...]`：位置参数**过滤文件**（短名补 `tests/cli.intent.` 前缀，如 `test-intent ui-find`；带 `/` 或 `.test.ts` 原样传），无参才全量
- `tool.model-import` — 环境变量 → provider 导入候选（只列不写；UI 模型页提示条 / `diy llmConfig scanEnv|importEnv`）→ `pkgs.ts/diy-app/src/main/core/model-import.ts`
- `tool.confirm` — 破坏性操作的应用内二次确认走 `renderer_solid/components/ConfirmDialog.tsx`；**禁用原生 `window.confirm`**（窗口级模态：卡住整个渲染进程，且非 DOM 节点 —— 自动化点不到）
- `tool.cli` — 查/改数据：全局 `diy <域> <命令>`（生产）· worktree 里 `./diy.sh <域> <命令>`（隔离）。**域名清单真源 = `diy --help`**（`task` `project` `agent` `tool` `context` `template` `llmConfig` `seed` `traffic` `flow` `log` `ref` `watch` `ui` `doctor`…；本行曾只列 8 个、后又漏 `traffic`/`flow` —— 别抄本行，去跑 `diy --help`）
- `tool.pkg` — `pkgs.ts/diy-app/sha.sh preview|lab|build|test|cli` 单包动作
- `tool.sync` — **新开 worktree 先 `./sha.sh sync`**（`npm i --workspaces --include-workspace-root` + 子模块 + 各包 sync）；不跑则包没装、`node_modules` 缺。`--include-workspace-root` 不能省：光 `npm i --workspaces` 只装 workspace、漏装根 package.json 依赖（`remark-gfm` 等），干净 worktree 上必现 build 解析失败。**末尾顺带把 `~/.diy` 的真配置（`model.yaml` / `context.yaml` / `personas.yaml` / `providers.custom.yaml`）投影进 `build/<variant>/home/`**（`sync-dev-home` 一步；变体随 `DIY_VARIANT`，缺省 preview，`DIY_SYNC_HOME=0` 关）—— seed 只种示例数据，真配置归它
- `tool.electron` — electron 43 **无 postinstall**，二进制改**惰性下载**：`require('electron')` / `npx electron` 时若 `node_modules/electron/dist` 缺，就在**当时那个进程里**同步下载，**且无超时** → 症状是静默卡死（与 npm 的 fetch 超时无关）。zip 缓存在 `~/Library/Caches/electron/`（实测 cache hit：5.5s 解压完、零网络）—— 所以每个 worktree 的真实代价是**解压 ~295MB 占磁盘**，不是下载。省法（本仓实测在用）：`ln -sfn <主仓>/node_modules/electron/dist <worktree>/node_modules/electron/dist`
- `tool.ui` — 真实 UI 验证走 CDP：`playwright-cli attach --cdp=…`

## rule — 硬约束

- `rule.gpg` — GPG 签名失败停下求助，禁 `--no-gpg-sign`
- `rule.check` — **类型检查只准 `./sha.sh check`**。各包 `noEmit:true`；一旦 emit，产物落在源码旁会被 `resolve.extensions` 优先命中（症状：改了没反应）
- `rule.probe` — 轮次中勿改 `src/**` 当探针（watch 重启打断自己的轮次）；探针写 `/tmp`
- `rule.dev-concurrent` — **同一 variant** 的 `preview`/`lab` 运行中勿并发 `tsc -b` / `vite build` / 全量 vitest（抢同一 `outDir`，watcher 卡死）。跨 variant（preview vs test）各写 `build/<v>`，不抢
- `rule.instance-lifecycle` — **实例起停权限与数据定性**：`test` / `lab` 由 agent **自由起停**（随便折腾，不用问）；`preview` 供**人机沟通·验证 UI**，亦可随便起停（给正当理由即可）；三者数据皆**临时非生产**（仓库根 `build/<variant>/home`，坏了就清，必要时可重置）。**唯全局 `diy`（prod / `~/.diy`）是日常实跑的生产 app** —— 不动其数据根、不杀其进程，重启留给用户手动
- `rule.new-pkg` — 新增包检查单：`tsconfig.json`（composite + noEmit + include）+ `tsconfig.all.json` references
- `rule.renderer` — UI 主线是 `renderer_solid/`（SolidJS）；React 版已删除
- `rule.task-write` — **任务文件头是权威**（##322）：读侧 `task show` / `getTask` / 上下文 `task.*` 给的就是文件头 frontmatter **同一份**（确认任务不必 `cat` 任务文件）；写侧 `task edit --body`（整篇覆盖）与 `--append-body <file|->`（追加，不必先读文件）收到「整份文件」一律**剥头**（追加侧判据更严：须含 `state`/`created`/`updated`，故追加一份自带 front matter 的普通文档时其文档头**保留**），返回值回报剥掉的键与原文

## model — 本地 agent 测试用什么模型

- `model.allowed` — 测试只准用三类：**① 任何带 `free` 后缀的模型**（套餐内免费，优先）· ② `mimo-v2.5` · ③ `deepseek-v4.1-flash`；其余一律不用（太贵）。确需验证某模型特有行为时，先取得用户许可再跑，且一次只跑一条用例
- `model.free` — **模型 id 带 `free` 后缀 = 套餐内免费（cost 全 0）→ 优先选它**。free 模型**上架 / 下架频繁**，用前必须：① 列 `https://opencode.ai/zen/go/v1/models` 筛 `free` ② **各实测一条**（真发必须带 `x-opencode-session` 头，否则 400 `MissingSessionID`；测法要覆盖**流式 + 工具**，二者齐备才算可用）③ 把可用清单连同**核对日期**写回本行，供其他 agent 直接复用。**最近核对 2026-10-17**：`beam-free` · `longcat-2.5-preview-free`（均流式 + 工具 OK）
- `model.default` — 缺省**先挑 `model.free` 里的可用项**；没有则用 `mimo-v2.5`（opencode-go，chat 面，$0.14 / $0.28 per 1M）。**`mimo-v2.6-flash` 自 2026-10-17 起不作缺省** —— 上游不稳，实测会返回 `[model_coming_soon] This model is coming soon.`（preview 真跑命中过）。⚠️ **`seed.ts` 的 `SEED_MODEL` 仍写死 `mimo-v2.6-flash`**（`diy seed --help` 也这么写）—— 与本行口径不符，待修（规则先行、代码未跟）
- `model.reasoning` — 档位只有 `none/low/medium/high`（上游 400 拒绝 `minimal`/`xhigh`/`max`）
- `model.truth` — 价目真源 `https://models.dev/api.json`（`opencode-go` 的 cost/limit）；**可用清单** `https://opencode.ai/zen/go/v1/models`（真发需带 `x-opencode-session` 头）

## 历史归档

- `pkgs/` 下 Python 包（`diy-core`/`diy-app`/`diy-cli`/`diy-clirpc`/`diy-test`/`diy-ui`）仅归档，不演进
- `sha-py.sh` 旧 Python 入口已废弃；主线用根 `sha.sh` + `pkgs.ts/*/sha.sh`
