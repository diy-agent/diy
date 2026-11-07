---
desc: 去哪找
updated: 2026-11-02
---

## app

`apps/diy-app/` Electron 管控台：`src/main` 主进程 · `src/cli` CLI · `src/preload` · `src/renderer_solid` UI（Solid，主线）· `src/serve` Web 模式 · `src/shared` 跨层契约。包内细节见 `apps/diy-app/AGENTS.md`

## archived

`diy/pkgs/` **Python 包已归档**：代码保留，能力已放弃。不要参考、不要迁移其行为；一切以 TS 实现为准

## cfg

`apps/diy-app/src/runtime.ts` —— **`DIY_*` 环境变量契约的唯一源**

## dev

`~/git/diy/_diy/pkgs/dev/` —— 独立仓 `_diy` 里的 `dev` 命令（ref 仓库引用 / vendor 镜像，cwd 即作用域）；细节见其 `AGENTS.md`

## docs

`docs/` 架构与方案 + **本文件细节的二次披露**（`instance-modes` · `toolchain` · `task-write-contract` · `model-testing`）· `scripts/` 辅助脚本与冒烟脚本 · `pkgs/` Python 归档（不演进）

## facts

事实库真源 `knowledge/facts/*.yaml`（subject 词表 `knowledge/subjects.yaml`）· 护栏 `scripts/facts-index.mts`（已并入 `./sha.sh check`）· 内核 `pkgs.ts/core/facts/`

## flow

`pkgs.ts/flow/` 工作流内核（定义 DSL + 泳道容器 + 插件槽 + 参数层 L2 + guard 求值 + 转移执行器 + 轨迹投影；零 IDE 依赖，唯一依赖 `@diy-agent/talk` 的 `Event` 原语；接 ##319）

## intent

**需求契约 = 意图测试**：`apps/diy-app/tests/cli.intent.*.test.ts` + `pkgs.ts/core/template/tests/intent.*` + `pkgs.ts/agent/talk/tests/intent.*` + `pkgs.ts/flow/tests/intent.*`

## main

`diy/` **主 monorepo**（TypeScript + Electron 主线）→ 细节见 `diy/AGENTS.md`

## prompt

内置提示词 `apps/diy-app/src/main/prompts/defaults.ts`（唯一真源）· 装配 `apps/diy-app/src/main/services/prompt-registry.ts`

## quant

`diyq/` 金融预测（xtquant）

## research

`diy-research/` 研究仓（子目录混乱，不承诺准确）

## rpc

`pkgs.ts/core/rpc/` RPC 协议 + 传输（纯内核，零 Node/Electron 依赖）；**npm 发布名 `@diy-agent/rpc`**（见 `tool.publish`）

## sandbox

`_dev-testbed/` 实验沙箱（无约束）

## talk

`pkgs.ts/agent/talk/` 对话容器内核（事件 / 锚点 / 反应原语 + role 铁律，零依赖；消费者 `@diy-agent/flow`（`Event` 原语）；接 ##319 存储/装配）

## template

`pkgs.ts/core/template/` 提示词模版引擎（零依赖）

## test

`_diy/` 开发测试项目

## ui

`pkgs.ts/ui/core/`（包名 `diyui`）纯 TS / 零框架的**声明式 DOM 层**（原语 `Signal`/`Scope`/`Component`/`Cell`/`Scheduler` + provider `pi-tui`）；`web/`（Vite）是它的 demo 站

## work

`_diy-work/` 临时工作区（Hermes agent 用，gitignore 排除）
