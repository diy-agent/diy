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
| `scripts/` | 辅助脚本（doctor-env、lint-env、git-hook） | — |
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

## 关键约束

- **GPG 签名** — git 操作必须 GPG 签名，失败时停下求助，禁止 `--no-gpg-sign` 绕过
- 代码注释用中文
- **Solid 是重构方向** — renderer_solid/ 是主线，renderer/（React 版）仅作参考和比较代码使用，不追加功能
- 意图测试（Intent Test）是需求的定义者
  - TS 主线：`pkgs.ts/diy-app/tests/cli.intent.*.test.ts`（`./diy.sh` + `ShellTest` + 隔离 Electron；按领域拆文件：ui / doctor / project / task，每条用例自建自删 fixture）
  - Python 历史：`tests/` + `_diy/AGENTS.md`（已废弃，仅归档）
