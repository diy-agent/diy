# diy — 主 monorepo

> ⚠️ Python 栈已废弃：`pkgs/` 下所有 Python 包（`diy-core` / `diy-app` / `diy-cli` / `diy-clirpc` / `diy-test` / `diy-ui`）仅保留作归档/参考，不再维护与演进。当前主线在 `pkgs.ts/`（TypeScript + Electron）。

diy 生态的核心仓库。历史为 `uv` 管理的 Python monorepo，现主线为 `pkgs.ts/` 的 TS 栈。

## 目录结构

| 路径 | 说明 | 状态 |
|------|------|------|
| `pkgs.ts/diy-app/` | 管控台 — Electron + Vite 8 + SolidJS（主线，React 版仅参考比较） | ✅ 主线 |
| `pkgs.ts/diy-rpc/` | RPC 协议与传输层（主线） | ✅ 主线 |
| `pkgs/diy-core/` | 核心逻辑 — state/agent/task/subject 模型 | ⚠️ 已废弃 |
| `pkgs/diy-app/` | PySide6 桌面管控台（MainWindow/GatewayCLI） | ⚠️ 已废弃 |
| `pkgs/diy-cli/` | 统一 `diy` CLI 入口（Python） | ⚠️ 已废弃 |
| `pkgs/diy-clirpc/` | CLI RPC 层（Python） | ⚠️ 已废弃 |
| `pkgs/diy-test/` | Python 意图测试引擎 ShellTest | ⚠️ 已废弃 |
| `pkgs/diy-ui/` | Panel 响应式 UI 框架（Signal/ScopeProxy） | ⚠️ 已废弃 |
| `diy.sh` | 当前 worktree 的 dev CLI 入口（注入 `DIY_HOME=./build/home`，`src/runtime.ts` 读取） | ✅ 主线 |
| `pkgs.ts/diy-app/bin/diy` | 发布后 CLI 入口（注入 `DIY_HOME=~/.diy`，`node out/cli/index.js`） | ✅ 主线 |
| `pkgs.ts/diy-app/src/runtime.ts` | 运行时配置统一组装点（入口只注入 `DIY_*` 环境变量，CLI/main/serve 统一读取） | ✅ 主线 |
| `scripts/` | 辅助脚本（doctor-env、lint-env、git-hook、cdp-colorscheme-demo、repro-epipe-dialog） | — |
| `vendor/` | 外部依赖源码快照 | — |
| `sha.sh` | 旧 Python 栈开发入口（`./sha.sh --help`） | ⚠️ 已废弃 |

## CLI

**`./diy.sh`** — 当前 worktree 的 dev CLI 入口（替代全局 `diy`/`dai`）。跑 `tsx src/cli/index.ts`，注入 `DIY_HOME=./build/home`，每个 worktree 独立，不共享 `~/.diy`。测试直接跑 `./diy.sh task list` 等，无需拦截改写。

**`pkgs.ts/diy-app/bin/diy`** — 发布后的 CLI 入口（npm 全局 / PATH），跑 `node out/cli/index.js`，注入 `DIY_HOME=~/.diy`。开发/发布共用 `src/runtime.ts` 的环境变量契约（`DIY_HOME`/`DIY_PORT`/`DIY_DEV_SERVER_URL`），无 dev/prod 模式字段。

子命令分类（`./diy.sh --help`）：
- `diy task/subject` — 任务/主体管理
- `diy ui *` — 管控台 UI 接口
- `diy agent` — Agent 管理
- `diy doctor` — 健康自检

Python `dai`/`diy` 仅历史归档，不再作为入口。

## 依赖链

```
主线（TS）:
  diy-rpc (独立)
  diy-app ─→ diy-rpc   (CLI → HTTP → Electron main)

历史（Python，已废弃）:
  diy-ui (独立, Panel)
  diy-app ─→ diy-core
    diy-cli ─→ diy-core  (CLI → socket → diy-app)
```

## 入口一览（改代码 / 跑命令前先看这张表）

| 入口 | 什么时候用 | 实际跑什么 | 注入的关键 env |
|------|------------|------------|----------------|
| `./diy.sh <域> <命令>` | 日常调 CLI（task / subject / template / agent / ui / doctor / log…） | `tsx src/cli/index.ts`（**源码**，实时生效） | `DIY_HOME=./build/home`、`DIY_CLI=<仓库根>/diy.sh`、`DIY_APP_ROOT` |
| `./sha.sh check` | 提交前唯一检查入口（类型 + lint + rpc 浏览器安全） | `tsc -b tsconfig.all.json --noEmit` + oxlint | — |
| `./sha.sh test` | 全仓测试（走各包自己的 test） | vitest（单测）；意图测试见下 | — |
| `./sha.sh dev` | 起 GUI 开发（HMR，改代码自动重建/重启） | → `pkgs.ts/diy-app/sha.sh dev` → `tsx scripts/electron-dev.mts` | `DIY_HOME`、**`DIY_CLI=<仓库根>/diy.sh`**、`DIY_DEV_SERVER_URL`、`DIY_MIRROR_DISPLAY` |
| `./sha.sh build` / `ci` / `fix` / `clean` / `sync` / `link` / `vendor` | 构建 / CI / 自动修 / 清理 / 依赖 / 全局 link / 外部快照 | 见 `sha.sh` | — |
| `pkgs.ts/diy-app/sha.sh dev` (或 `cli` / `build` / `test` / `serve` / `typecheck` / `lint` / `fmt` / `icon`) | 只在 app 包上做单件事 | 同名动作 | 同对应入口 |
| `pkgs.ts/diy-app/bin/diy` | **发布 / 全局安装后**的 CLI | `node out/cli/index.js`（产物） | `DIY_HOME=~/.diy`、`DIY_CLI=$0` |
| `pkgs.ts/diy-app/tests/cli.intent.*.test.ts` | 意图测试（= 需求契约） | `./diy.sh` + `ShellTest` + 隔离 Electron（自建自删 fixture） | 由 `tests/electron-test.ts` 决定（**不注入 `DIY_CLI`** → 走「未注入」告警分支，恰好是真实“非 CLI 启动”场景） |
| `playwright-cli attach --cdp=…` | 真实 UI 验证（事件链/手势） | 附到**已运行**的 app | — |

两个容易踩的前提：

1. **CLI（tsx 源码）与 GUI（`out/main` 产物）是两件事**：CLI 要重 RPC 必须有运行中的 GUI；没有时 `./diy.sh` 会尝试拉拉一个（需先 `sha.sh build`，dev 模式除外，见 `diy.sh` 提示）。
2. **`DIY_CLI` 推不出来，只能注入**：发布后 app 可双击启动（无任何 CLI 入口）、用户还可能用自己的 wrapper/别名；所以三个入口都必须显式注入（`./diy.sh`、`bin/diy`、`electron-dev.mts`），缺一个就会告诉模型敲裸 `diy` —— 在 worktree 里会打到 `~/.diy`。
3. **dev 会话运行中不要并发跑 `tsc -b` / `vite build` / 全量 vitest**：会与 watcher 抢同一 `outDir`、并制造海量 FS 事件（尤其批量删产物/改文件），实测可能导致 watcher 卡死（不再重建）。
4. **dev 排障看 `$DIY_HOME/log/dev.jsonl`**（每一步都落盘；终端输出不会被保存）：`dev-start` / `renderer-ready` / `{main,preload}-bundle-{start,end,error}` / `electron-{spawn,restart,exit}` / `cdp-endpoint` / `cleanup` / `uncaught-exception` / `unhandled-rejection`。
   - 卡死结论：`grep watch-stall-suspect` 直接给出「源码比产物新 / 产物缺失，且 60s 未重建」。
   - 无该告警但也不重建时，看日志是否停在 `main-bundle-start` 而没有对应的 `*-bundle-end`/`error` —— 那是「构建启动了没跑完」（进程内部异常），而不是「watcher 不监听」。
   - 两种情况处置相同：重启 `./sha.sh dev`（Vite 没有公开的重挂 API）。

## 关键约束

- **GPG 签名** — git 操作必须 GPG 签名，失败时停下求助，禁止 `--no-gpg-sign` 绕过
- 代码注释用中文
- **类型检查只准 `./sha.sh check`（`tsc -b tsconfig.all.json --noEmit`）** — 各包 tsconfig 均
  `noEmit: true`，禁止裸 `tsc` / IDE emit。一旦 `.js/.jsx/.d.ts` 落在源码目录旁，
  vite/vitest 的扩展名优先序会让 dev/构建/单测**静默跑产物**（改了没反应、单测测的不是源码）。
  `./sha.sh check` 最后一步就是 `scripts/check-no-emit.sh`（扫 `pkgs.ts/*/{src,tests,test,scripts}`，
  发现产物直接 fail）；护栏 = 各包 `noEmit: true` + 根 `.gitignore` 的
  `pkgs.ts/**/*.{js,jsx,mjs,cjs,d.ts}`（新增包自动覆盖，无需逐包配）。
- **新增 TS 包的检查单**（三处，缺一不可）
  1. `pkgs.ts/<new>/tsconfig.json`：`extends "../../tsconfig.base.json"` +
     `compilerOptions: { composite: true, noEmit: true }` + `include: ["src/**/*", "tests/**/*"]`
  2. `tsconfig.all.json` 的 `references` 里加 `{ "path": "pkgs.ts/<new>" }`
  3. `.gitignore` 不用动（根护栏按 `pkgs.ts/**` 自动覆盖）。当前 `pkgs.ts/` 下没有任何手写 `.js/.d.ts`
     （`diy-app/src/env.d.ts` 已删，`vite/client` 类型改由 tsconfig 的 `types` 提供）；若将来确实要手写，
     用 `git add -f` 或在该包 `.gitignore` 里 `!` 反选
- **本机 agent 轮次中不要拿 `src/**` 当探针实验场** — main/preload 是 watch 构建，
  改一次就重启 Electron，正在跑的那一轮会被打断（ops 里 tool 被标 `interrupted`）；
  探针文件写 /tmp，或改完留下的是空文件恢复也不到位（历史事故：`state.js` 首行的
  `console.error` 探针被 dev watch 带进了运行中的产物）
- **UI 验证走 CDP** — CLI 的 RPC 返回成功不等于 renderer 渲染正确；界面行为必须用
  `playwright-cli attach --cdp=...` 驱动真实 Electron 窗口验证
  （流程与陷阱见 `pkgs.ts/diy-app/AGENTS.md` 的「UI 验证」与
  「交互自动化操作 App（agent 自测/演示用，实测经验）」两节）
- **Solid 是重构方向** — `renderer_solid/` 是主线（构建默认入口），`renderer/`（React 版）仅作参考和比较代码使用，不追加功能
- 意图测试（Intent Test）是需求的定义者
  - TS 主线：`pkgs.ts/diy-app/tests/cli.intent.*.test.ts`（`./diy.sh` + `ShellTest` + 隔离 Electron；按领域拆文件：ui / doctor / project / task，每条用例自建自删 fixture）
  - Python 历史：`tests/` + `_diy/AGENTS.md`（已废弃，仅归档）
