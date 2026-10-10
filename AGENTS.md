# diy — 主 monorepo

> 主线 `pkgs.ts/`（TypeScript + Electron）。`pkgs/` Python 已归档 —— 代码在，**能力已放弃**，一切以 TS 为准。

## find — 去哪找

- `find.app` — `pkgs.ts/diy-app/` Electron 管控台：`src/main` 主进程 · `src/cli` CLI · `src/preload` · `src/renderer_solid` UI（Solid，主线）· `src/serve` Web 模式 · `src/shared` 跨层契约。包内细节见 `pkgs.ts/diy-app/AGENTS.md`
- `find.rpc` — `pkgs.ts/diy-rpc/` RPC 协议 + 传输（纯内核，零 Node/Electron 依赖）
- `find.template` — `pkgs.ts/diy-template/` 提示词模版引擎（零依赖）
- `find.dev` — `pkgs.ts/diy-dev/` 独立的 `dev` 命令（ref 仓库引用 / vendor 镜像，cwd 即作用域）；细节见其 `AGENTS.md`
- `find.cfg` — `pkgs.ts/diy-app/src/runtime.ts` —— **`DIY_*` 环境变量契约的唯一源**
- `find.prompt` — 内置提示词 `pkgs.ts/diy-app/src/main/prompts/defaults.ts`（唯一真源）· 装配 `pkgs.ts/diy-app/src/main/services/prompt-registry.ts`
- `find.intent` — **需求契约 = 意图测试**：`pkgs.ts/diy-app/tests/cli.intent.*.test.ts` + `pkgs.ts/diy-template/tests/intent.*`
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
- `entry.client` — `diy` 与 `./diy.sh` **都是客户端、都不启动 GUI**：读 `$DIY_HOME/app.port` 探测已运行实例，探不到才 spawn Electron（CLI 与 GUI 是两进程）。连哪个实例由 `DIY_HOME`（数据根）决定
- `entry.gui` — 起 GUI 两条路：`./sha.sh preview`（HMR，免构建）或 `sha.sh build` 后由 CLI 拉起
- `entry.verify` — preview/lab 起来后用 `diy getAppInfo` 看 `diyHome` / `env` / `branch`，确认数据目录与启动参数（验证没起错数据根/变体）
- `entry.risk` — worktree 改码跑测一律 `./diy.sh`（隔离 `./build/<variant>/home`；会拒绝继承来的生产 `DIY_HOME`，需 `DIY_ALLOW_PROD_HOME=1` 放行）；**查/改真实数据才用全局 `diy`**
- `entry.home-guard` — 「继承来的生产 `DIY_HOME` 一律拒绝」的唯一决策点 `pkgs.ts/diy-app/src/main/core/dev-home.ts`（`./diy.sh` 与 `./sha.sh preview|lab` 共用；宿主 shell 常导出 `DIY_HOME=~/.diy`，不拦则 preview 开着生产数据根跑、还会把种子写进去）
- `entry.seed` — 空数据根的初始种入（`pkgs.ts/diy-app/src/main/core/seed.ts`）：**自动只跑一次**（`.seed-done` 标记，删掉的 provider 不会被种回来）、`preview`/`lab` 缺省自动、`DIY_SEED` 三态覆盖、`diy seed run` 手动补缺项；**生产根永不种入**
- `entry.inject` — `DIY_CLI` 由三个入口注入：`diy.sh` / `bin/diy` / `electron-dev.mts`；漏一处提示词就退化成裸 `diy`（→ 打到生产）

## tool — 命令

- `tool.check` — `./sha.sh check` **提交前唯一检查**：`tsc -b tsconfig.all.json --noEmit` + oxlint + rpc 浏览器安全 + 产物护栏
- `tool.test` — `./sha.sh test` 全仓 · `./sha.sh test-unit` 快测（不起 Electron）· `pkgs.ts/diy-app/sha.sh test-intent` 意图测试
- `tool.model-import` — 环境变量 → provider 导入候选（只列不写；UI 模型页提示条 / `diy llmConfig scanEnv|importEnv`）→ `pkgs.ts/diy-app/src/main/core/model-import.ts`
- `tool.confirm` — 破坏性操作的应用内二次确认走 `renderer_solid/components/ConfirmDialog.tsx`；**禁用原生 `window.confirm`**（窗口级模态：卡住整个渲染进程，且非 DOM 节点 —— 自动化点不到）
- `tool.cli` — 查/改数据：全局 `diy <域> <命令>`（生产）· worktree 里 `./diy.sh <域> <命令>`（隔离）。**域名清单真源 = `diy --help`**（`task` `project` `agent` `tool` `context` `template` `llmConfig` `seed` `log` `ref` `watch` `ui` `doctor`…；本行曾只列 8 个，早已腐坏）
- `tool.pkg` — `pkgs.ts/diy-app/sha.sh preview|lab|build|test|cli` 单包动作
- `tool.sync` — **新开 worktree 先 `./sha.sh sync`**（`npm i --workspaces` + 子模块 + 各包 sync）；不跑则包没装、`node_modules` 缺
- `tool.ui` — 真实 UI 验证走 CDP：`playwright-cli attach --cdp=…`

## rule — 硬约束

- `rule.gpg` — GPG 签名失败停下求助，禁 `--no-gpg-sign`
- `rule.check` — **类型检查只准 `./sha.sh check`**。各包 `noEmit:true`；一旦 emit，产物落在源码旁会被 `resolve.extensions` 优先命中（症状：改了没反应）
- `rule.probe` — 轮次中勿改 `src/**` 当探针（watch 重启打断自己的轮次）；探针写 `/tmp`
- `rule.dev-concurrent` — **同一 variant** 的 `preview`/`lab` 运行中勿并发 `tsc -b` / `vite build` / 全量 vitest（抢同一 `outDir`，watcher 卡死）。跨 variant（preview vs test）各写 `build/<v>`，不抢
- `rule.instance-lifecycle` — **实例起停权限与数据定性**：`test` / `lab` 由 agent **自由起停**（随便折腾，不用问）；`preview` 供**人机沟通·验证 UI**，亦可随便起停（给正当理由即可）；三者数据皆**临时非生产**（仓库根 `build/<variant>/home`，坏了就清，必要时可重置）。**唯全局 `diy`（prod / `~/.diy`）是日常实跑的生产 app** —— 不动其数据根、不杀其进程，重启留给用户手动
- `rule.new-pkg` — 新增包检查单：`tsconfig.json`（composite + noEmit + include）+ `tsconfig.all.json` references
- `rule.renderer` — UI 主线是 `renderer_solid/`（SolidJS）；React 版已删除

## model — 本地 agent 测试用什么模型

- `model.allowed` — **测试只准用 `mimo-v2.6-flash` 与 `deepseek-v4.1-flash`**；其他模型一律不用（太贵）。确需验证某模型特有行为时，先取得用户许可再跑，且一次只跑一条用例
- `model.default` — 缺省用 **`mimo-v2.6-flash`**（opencode-go，chat 面）：全表最便宜的带工具模型，$0.14 / $0.28 per 1M tokens
- `model.reasoning` — 档位只有 `none/low/medium/high`（上游 400 拒绝 `minimal`/`xhigh`/`max`）
- `model.truth` — 价目真源 `https://models.dev/api.json`（`opencode-go` 的 cost/limit）；可用清单 `$ZEN/v1/models`

## 历史归档

- `pkgs/` 下 Python 包（`diy-core`/`diy-app`/`diy-cli`/`diy-clirpc`/`diy-test`/`diy-ui`）仅归档，不演进
- `sha-py.sh` 旧 Python 入口已废弃；主线用根 `sha.sh` + `pkgs.ts/*/sha.sh`
