# diy — 主 monorepo

> 主线：`pkgs.ts/`（TypeScript + Electron）；`pkgs/` Python 栈仅归档（见末节）。

## 目录

- [目录结构](#目录结构)
- [CLI](#cli)
- [依赖链](#依赖链)
- [入口一览](#入口一览)
- [关键约束](#关键约束)
- [历史归档](#历史归档)

## 目录结构

| 路径 | 说明 | 状态 |
|------|------|------|
| `pkgs.ts/diy-app/` | 管控台 — Electron + Vite 8 + SolidJS（主线，React 版仅参考） | ✅ 主线 |
| `pkgs.ts/diy-rpc/` | RPC 协议与传输层 | ✅ 主线 |
| `pkgs.ts/diy-template/` | 提示词模版引擎 `@diy/template`（零依赖，意图测试为真源） | ✅ 主线 |
| `pkgs.ts/diy-dev/` | dev CLI 辅助包 | ✅ 主线 |
| `diy.sh` | worktree dev CLI（`DIY_HOME=./build/home`） | ✅ |
| `pkgs.ts/diy-app/bin/diy` | 发布后 CLI（`DIY_HOME=~/.diy`） | ✅ |
| `pkgs.ts/diy-app/src/runtime.ts` | 运行时配置统一组装（`DIY_*` 环境变量） | ✅ |
| `scripts/` | 辅助脚本（doctor-env / cdp-colorscheme-demo 等） | — |
| `vendor/` | 外部依赖快照 | — |
| `pkgs/` | Python 栈归档（`diy-core`/`diy-app`/`diy-cli`/…） | ⚠️ 归档 |

## CLI

- **`./diy.sh`** — worktree dev 入口，`tsx src/cli/index.ts`，`DIY_HOME=./build/home`，`DIY_CLI=<仓库根>/diy.sh`。测试直接跑 `./diy.sh task list`。
- **`pkgs.ts/diy-app/bin/diy`** — 发布后入口，`node out/cli/index.js`，`DIY_HOME=~/.diy`。

子命令：`diy task/subject` / `diy ui *` / `diy agent` / `diy template` / `diy doctor`（`./diy.sh --help`）。

## 依赖链

```
diy-rpc (独立)
diy-template (独立，零依赖)
diy-app ─→ diy-rpc + diy-template   (CLI → HTTP → Electron)
```

## 入口一览（改代码前先看）

| 入口 | 何时用 | 实际跑什么 | 关键 env |
|------|--------|-----------|----------|
| `./diy.sh <域> <命令>` | 日常 CLI | `tsx src/cli/index.ts`（源码） | `DIY_HOME=./build/home`、`DIY_CLI`、`DIY_APP_ROOT` |
| `./sha.sh check` | 提交前唯一检查 | `tsc -b` + oxlint + browser + 产物护栏 | — |
| `./sha.sh test` | 全仓测试 | 各包 `vitest`（含意图测试） | — |
| `./sha.sh dev` | 起 GUI（HMR） | `tsx scripts/electron-dev.mts` | `DIY_HOME`、`DIY_CLI`、`DIY_DEV_SERVER_URL` |
| `pkgs.ts/diy-app/sha.sh dev/cli/build/test` | 单包动作 | 同名 | — |
| `pkgs.ts/diy-app/tests/cli.intent.*.test.ts` | 意图测试（需求契约） | `./diy.sh` + 隔离 Electron | 不注入 `DIY_CLI`（测未注入分支） |
| `playwright-cli attach --cdp=…` | 真实 UI 验证 | 附到已运行 app | — |

**易踩前提**：

1. CLI（源码）与 GUI（`out/main` 产物）是两进程；无 GUI 时 CLI 冷启动需先 `sha.sh build`。
2. `DIY_CLI` 只能注入（`diy.sh`/`bin/diy`/`electron-dev.mts` 三处），漏一个会让提示词退化成裸 `diy`。
3. `dev` 运行中勿并发 `tsc -b`/`vite build`/全量 `vitest`（抢 `outDir`，watcher 卡死）。
4. `dev` 排障看 `$DIY_HOME/log/dev.jsonl`：`grep watch-stall-suspect` 判卡死；重启 `dev` 恢复。

## 关键约束

- **GPG 签名** — 失败停下求助，禁 `--no-gpg-sign`
- 注释用中文；对话精简
- **类型检查只准 `./sha.sh check`**（`tsc -b tsconfig.all.json --noEmit` + 产物护栏）。各包 `noEmit:true`，产物落源码旁会被 `resolve.extensions` 优先命中（改了没反应）。
- 新增包检查单：`tsconfig.json`（`composite+noEmit+include`）+ `tsconfig.all.json` references + `.gitignore` 已按 `pkgs.ts/**` 覆盖
- 轮次中勿改 `src/**` 当探针（watch 重启打断）；探针写 `/tmp`
- UI 验证走 CDP（`pkgs.ts/diy-app/AGENTS.md`「UI 验证」节）
- `renderer_solid/` 主线，`renderer/` React 仅参考
- 意图测试为需求定义者：`pkgs.ts/diy-app/tests/cli.intent.*` + `pkgs.ts/diy-template/tests/intent.*`；Python `tests/` 已归档

## 历史归档

- `pkgs/` 下 Python 包（`diy-core`/`diy-app`/`diy-cli`/`diy-clirpc`/`diy-test`/`diy-ui`）仅归档，不演进。
- `sha.sh` 旧 Python 入口已废弃，主线用根 `sha.sh` + `pkgs.ts/*/sha.sh`。
- 意图测试历史：`tests/` + `_diy/AGENTS.md`（归档）。
