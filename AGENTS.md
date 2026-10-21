# diy — 主 monorepo

> 主线 `pkgs.ts/`（TypeScript + Electron）。`pkgs/` Python 已归档 —— 代码在，**能力已放弃**，一切以 TS 为准。

## find — 去哪找

- `find.app` — `pkgs.ts/diy-app/` Electron 管控台：`src/main` 主进程 · `src/cli` CLI · `src/preload` · `src/renderer_solid` UI（Solid，主线）· `src/serve` Web 模式 · `src/shared` 跨层契约。包内细节见 `pkgs.ts/diy-app/AGENTS.md`
- `find.rpc` — `pkgs.ts/diy-rpc/` RPC 协议 + 传输（纯内核，零 Node/Electron 依赖）；**npm 发布名 `@diy-agent/rpc`**（见 `tool.publish`）
- `find.template` — `pkgs.ts/diy-template/` 提示词模版引擎（零依赖）
- `find.talk` — `pkgs.ts/diy-talk/` 对话容器内核（事件 / 锚点 / 反应原语 + role 铁律，零依赖；消费者 `@diy/flow`（`Event` 原语）；接 ##319 存储/装配）
- `find.flow` — `pkgs.ts/diy-flow/` 工作流内核（定义 DSL + 泳道容器 + 插件槽 + 参数层 L2 + guard 求值 + 转移执行器 + 轨迹投影；零 IDE 依赖，唯一依赖 `@diy/talk` 的 `Event` 原语；接 ##319）
- `find.dev` — `pkgs.ts/diy-dev/` 独立的 `dev` 命令（ref 仓库引用 / vendor 镜像，cwd 即作用域）；细节见其 `AGENTS.md`
- `find.cfg` — `pkgs.ts/diy-app/src/runtime.ts` —— **`DIY_*` 环境变量契约的唯一源**
- `find.prompt` — 内置提示词 `pkgs.ts/diy-app/src/main/prompts/defaults.ts`（唯一真源）· 装配 `pkgs.ts/diy-app/src/main/services/prompt-registry.ts`
- `find.intent` — **需求契约 = 意图测试**：`pkgs.ts/diy-app/tests/cli.intent.*.test.ts` + `pkgs.ts/diy-template/tests/intent.*` + `pkgs.ts/diy-talk/tests/intent.*` + `pkgs.ts/diy-flow/tests/intent.*`
- `find.ui` — `pkgs.ts/diy-ui/`（包名 `diyui`）纯 TS / 零框架的**声明式 DOM 层**（原语 `Signal`/`Scope`/`Component`/`Cell`/`Scheduler` + provider `pi-tui`）；`web/`（Vite）是它的 demo 站
- `find.facts` — 事实库真源 `knowledge/facts/*.yaml`（subject 词表 `knowledge/subjects.yaml`）· 护栏 `scripts/facts-index.mts`（已并入 `./sha.sh check`）· 内核 `pkgs.ts/diy-facts/`
- `find.docs` — `docs/` 架构与方案 + **本文件细节的二次披露**（`instance-modes` · `toolchain` · `task-write-contract` · `model-testing`）· `scripts/` 辅助脚本与冒烟脚本 · `pkgs/` Python 归档（不演进）

## entry — 实例三态（**先问：操作谁的数据 / 谁看 UI**）

> 入口矩阵、端口与身份、home guard、seed → `docs/instance-modes.md`

- `entry.choose` — **先问「操作谁的数据」**：真实任务/项目/agent → 全局 `diy`；worktree 改码·跑测试 → `./diy.sh`；人看 UI 效果 / agent 实验 → `./sha.sh lab`。**别拿 `./diy.sh` 查生产任务**（数据根不同 → 报「任务 N 不存在」）
- `entry.variant` — `DIY_VARIANT`（`prod|test|lab`）是产物 / 数据分根的唯一轴，缺省 `prod`（`./diy.sh` 缺省 `lab`）；`preview` 已删除（##381），遇之显式报错 → `pkgs.ts/diy-app/AGENTS.md::env.variant`
- `entry.client` — `diy` / `./diy.sh` **都是客户端**（不启 GUI）：探 `$DIY_HOME/app.port` + 验身份，连不上才 spawn；**起 GUI 的是启动器 `./sha.sh lab`，只 spawn、从不连已跑实例**
- `entry.variant-match` — **客户端与服务端变体必须配对**，不配对 = 对着另一个数据根敲命令（症状：任务不存在 / 改完没反应）
- `entry.risk` — worktree 改码跑测一律 `./diy.sh`（隔离数据根）；**查/改真实数据才用全局 `diy`**。继承来的生产 `DIY_HOME` 一律拒（放行 `DIY_ALLOW_PROD_HOME=1`）

## tool — 命令

> 各步细节与坑（check 六道闸 / fmt / sync / electron / publish）→ `docs/toolchain.md`

- `tool.check` — `./sha.sh check` 是**提交前唯一检查**（tsc `--noEmit` + oxlint + 产物 / 可执行位 / 规范索引护栏）；改一行只跑受影响测试，全量收工前一次
- `tool.fmt` — 格式真源 = 各包 `.oxfmtrc.json`（oxfmt **不读** `package.json` 的 `oxfmt` 块）；**fmt 未纳入 `check`**（##323(oxfmt 配置腐坏)）
- `tool.test` — `./sha.sh test` 全仓 · `test-unit` 不起 Electron · `pkgs.ts/diy-app/sha.sh test-intent [片段…]`（位置参数过滤文件，带 `/` 或 `.test.ts` 原样传，无参全量）
- `tool.cli` — 查/改数据：生产 `diy <域> <命令>` · worktree `./diy.sh <域> <命令>`；**域名清单真源 = `diy --help`**，别抄清单
- `tool.pkg-action` — `pkgs.ts/diy-app/sha.sh lab|build|test|cli` 单包动作
- `tool.publish` — npm 发布（`@diy-agent`）：根 `./sha.sh publish [--dry-run]`，认证 `NPM_PUBLISH_TOKEN`；仓内 `package.json` 恒指 `src/*.ts` 且留 `private:true`（护栏）
- `tool.sync` — **新开 worktree 先 `./sha.sh sync`**（漏 `--include-workspace-root` 必现 build 解析失败）；末尾把 `~/.diy` 真配置投影进 `build/<variant>/home/`（`DIY_SYNC_HOME=0` 关）
- `tool.sync-gate` — build/check/test/lab 入口先过 `ensure-sync`，命中即自动 `sync-deps`；`DIY_AUTO_SYNC=0` 关掉改报错，`./sha.sh sync-status` 只看状态
- `tool.electron` — electron 43 **无 postinstall**：缺二进制会在进程内**无超时**下载（症状＝静默卡死）；布局与校验收口 `scripts/ensure-electron.mjs` + `ensure-electron-if-needed.sh`
- `tool.ui` — 真实 UI 验证走 CDP：`playwright-cli attach --cdp=…`
- `tool.confirm` — 破坏性操作的应用内二次确认走 `ConfirmDialog.tsx`；**禁用原生 `window.confirm`**（窗口级模态，且自动化点不到）
- `tool.model-import` — 环境变量 → provider 导入候选（只列不写）→ `pkgs.ts/diy-app/src/main/core/model-import.ts`

## rule — 硬约束

- `rule.check` — **类型检查只准 `./sha.sh check`**。各包 `noEmit:true`；一旦 emit，产物落在源码旁会被 `resolve.extensions` 优先命中（症状：改了没反应）
- `rule.probe` — 轮次中勿改 `src/**` 当探针（watch 重启打断自己的轮次）；探针写 `/tmp`
- `rule.dev-concurrent` — **同一 variant** 的 `lab` 运行中勿并发 `tsc -b` / `vite build` / 全量 vitest（抢同一 `outDir`，watcher 卡死）。跨 variant（lab vs test）各写 `build/<v>`，不抢
- `rule.instance-lifecycle` — **实例起停权限与数据定性**：`test` / `lab` 由 agent **自由起停**（随便折腾，不用问；`lab` 同时是人机沟通·验证 UI 的入口 —— 原 `preview` 的职责已并入它）；二者数据皆**临时非生产**（仓库根 `build/<variant>/home`，坏了就清，必要时可重置）。**唯全局 `diy`（prod / `~/.diy`）是日常实跑的生产 app** —— 不动其数据根、不杀其进程，重启留给用户手动
- `rule.lab-owner` — **lab 一律开在「自己任务的 worktree」里**（`~/git/diy.worktrees/t<号>-*/` 内 `./sha.sh lab`；数据根随之隔离在该 worktree 的 `build/lab/home`）。**根 worktree（`~/git/diy/diy`）的 `build/lab/home` 是「无主」的** —— 只与用户联合使用（人在那儿看效果），**agent 不自己去开**：判别不了谁在用，撞 `SingletonLock` 或把种子 / 真配置写进用户正开着的根。要实验先给自己任务开 worktree
- `rule.new-pkg` — 新增包检查单：`tsconfig.json`（composite + noEmit + include）+ `tsconfig.all.json` references
- `rule.renderer` — UI 主线是 `renderer_solid/`（SolidJS）；React 版已删除
- `rule.task-write` — **任务文件头是权威**（##322）：读侧 `task show` / `getTask` / 上下文 `task.*` 就是 frontmatter 同一份（不必 `cat`）；写侧收到「整份文件」一律**剥头**，`--body` 只收内联正文（见路径样值即拒，##338）→ `docs/task-write-contract.md`（`--body-text` / `--body-file` / `--append-body*` 三选一、create 不剥头、##376 同族护栏）

## model — 本地 agent 测试用什么模型

> 核对流程、失败处置、价目真源 → `docs/model-testing.md`；名单真源 = `pkgs.ts/diy-app/src/shared/model-default.ts`（本层不抄名单）

- `model.allowed` — 测试只准三类：**带 `free` 后缀**（优先）· `mimo-v2.5` · `deepseek-v4.1-flash`；其余太贵不用。确需验某模型特有行为：先取得用户许可，一次一条用例
- `model.free` — free 模型上架/下架频繁，用前必须列 `https://opencode.ai/zen/go/v1/models` 筛 `free` + 各实测一条（**流式 + 工具**齐备才算可用）→ 写回真源并标核对日期
- `model.default` — 缺省先挑 free 可用项，都不可用退 `mimo-v2.5`；`mimo-v2.6-flash` 自 2026-10-17 起**不作缺省**（上游 `[model_coming_soon]`）
- `model.reasoning` — 档位只有 `none/low/medium/high`（上游 400 拒绝 `minimal`/`xhigh`/`max`）
- `model.truth` — 价目真源 `https://models.dev/api.json`（`opencode-go` 的 cost/limit）

## 历史归档

- `pkgs/` 下 Python 包（`diy-core`/`diy-app`/`diy-cli`/`diy-clirpc`/`diy-test`/`diy-ui`）仅归档，不演进
- `sha-py.sh` 旧 Python 入口已废弃；主线用根 `sha.sh` + `pkgs.ts/*/sha.sh`
