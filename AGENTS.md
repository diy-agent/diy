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

## entry — 三个入口最常混（改代码前先看）

| | `diy`（全局命令） | `./diy.sh` | `./sha.sh dev` |
|---|---|---|---|
| 本质 | 发布版 CLI **客户端** | worktree 版 CLI **客户端** | **GUI 启动器** |
| 跑什么 | `node out/cli/index.js`（编译产物） | `auto`：`out/cli/index.js` 优先（打包源比产物新→回退 `tsx` 源码，`DIY_CLI_MODE=auto\|compiled\|tsx`） | Vite dev server + watch main/preload + Electron |
| 要构建吗 | 是（`out/` 必须存在） | CLI 可选（auto 无产物/产物旧→tsx 兜底）；拉起的 GUI 要 `out/main` | 不用（HMR 走 `loadURL`） |
| 数据根 | `~/.diy`（**生产**） | `./build/home`（worktree 隔离） | 同 `diy.sh` |
| `DIY_ENV` | `production` | `development` | `development` |
| 连哪个 app | 探测/拉起自己的实例 | 同 worktree 实例 | **它自己拉起的实例** |

- `entry.client` — `diy` 与 `./diy.sh` **都是客户端、都不启动 GUI**：读 `$DIY_HOME/app.port` 探测已运行实例，探不到才 spawn Electron（CLI 与 GUI 是两进程）
- `entry.gui` — 起 GUI 只有两条路：`./sha.sh dev`（HMR，免构建）或先 `pkgs.ts/diy-app/sha.sh build` 再由 CLI 拉起
- `entry.risk` — **worktree 里务必 `./diy.sh`**；裸 `diy` 会打生产 `~/.diy`（`diy.sh` 会拒绝继承来的生产 `DIY_HOME`，需 `DIY_ALLOW_PROD_HOME=1` 显式放行）
- `entry.inject` — `DIY_CLI` 由三个入口注入：`diy.sh` / `bin/diy` / `electron-dev.mts`；漏一处提示词就退化成裸 `diy`（→ 打到生产）

## tool — 命令

- `tool.check` — `./sha.sh check` **提交前唯一检查**：`tsc -b tsconfig.all.json --noEmit` + oxlint + rpc 浏览器安全 + 产物护栏
- `tool.test` — `./sha.sh test` 全仓 · `./sha.sh test-unit` 快测（不起 Electron）
- `tool.cli` — `./diy.sh <域> <命令>`：`task` `project` `agent` `template` `log` `watch` `ui` `doctor`（`./diy.sh --help`）
- `tool.pkg` — `pkgs.ts/diy-app/sha.sh dev|build|test|cli` 单包动作
- `tool.ui` — 真实 UI 验证走 CDP：`playwright-cli attach --cdp=…`

## rule — 硬约束

- `rule.gpg` — GPG 签名失败停下求助，禁 `--no-gpg-sign`
- `rule.check` — **类型检查只准 `./sha.sh check`**。各包 `noEmit:true`；一旦 emit，产物落在源码旁会被 `resolve.extensions` 优先命中（症状：改了没反应）
- `rule.probe` — 轮次中勿改 `src/**` 当探针（watch 重启打断自己的轮次）；探针写 `/tmp`
- `rule.dev-concurrent` — `dev` 运行中勿并发 `tsc -b` / `vite build` / 全量 vitest（抢 `outDir`，watcher 卡死）
- `rule.new-pkg` — 新增包检查单：`tsconfig.json`（composite + noEmit + include）+ `tsconfig.all.json` references
- `rule.renderer` — UI 主线是 `renderer_solid/`（SolidJS）；React 版已删除

## model — 本地 agent 测试用什么模型

- `model.default` — **`mimo-v2.6-flash`**（opencode-go，chat 面）：全表最便宜的带工具模型，$0.14 / $0.28 per 1M tokens
- `model.expensive` — 贵模型（`gpt-5.6-luna` 等）**只准**在必须验证「该模型特有行为」时用，且一次只跑一条用例
- `model.reasoning` — 档位只有 `none/low/medium/high`（上游 400 拒绝 `minimal`/`xhigh`/`max`）
- `model.truth` — 价目真源 `https://models.dev/api.json`（`opencode-go` 的 cost/limit）；可用清单 `$ZEN/v1/models`

## 历史归档

- `pkgs/` 下 Python 包（`diy-core`/`diy-app`/`diy-cli`/`diy-clirpc`/`diy-test`/`diy-ui`）仅归档，不演进
- `sha-py.sh` 旧 Python 入口已废弃；主线用根 `sha.sh` + `pkgs.ts/*/sha.sh`
