---
desc: 本地开发环境与验证：sha.sh check 唯一入口 / 并发禁令 / 实例起停权限 / 新包检查单（worktree 规则的真源在 ~/git/AGENTS.md）
updated: 2026-11-22
---

## check

**类型检查只准 `./sha.sh check`**。各包 `noEmit:true`；一旦 emit，产物落在源码旁会被 `resolve.extensions` 优先命中（症状：改了没反应）

## dev-concurrent

**同一 variant** 的 `lab` 运行中勿并发 `tsc -b` / `vite build` / 全量 vitest（抢同一 `outDir`，watcher 卡死）。跨 variant（lab vs test）各写 `build/<v>`，不抢

## instance-lifecycle

**实例起停权限与数据定性**：`test` / `lab` 由 agent **自由起停**（随便折腾，不用问；`lab` 同时是人机沟通·验证 UI 的入口 —— 原 `preview` 的职责已并入它）。二者数据皆**临时非生产**（`<worktree>/run/<app>/<label>`，坏了就清，必要时可重置）。**唯全局 `diy`（prod / `~/.diy`）是日常实跑的生产 app** —— 不动其数据根、不杀其进程，重启留给用户手动。

## lab-owner

**lab 一律开在「自己任务的 worktree」里**（`~/git/diy/diy.worktrees/t<号>-*/` 内 `./sha.sh lab`；数据根随之隔离在该 worktree 的 `run/diy-app/lab`）。**根 worktree（`~/git/diy/diy`）的 `run/diy-app/lab` 是「无主」的** —— 只与用户联合使用（人在那儿看效果），**agent 不自己去开**：判别不了谁在用，撞 `SingletonLock` 或把种子 / 真配置写进用户正开着的根。要实验先给自己任务开 worktree。

## new-pkg

新增包检查单：`tsconfig.json`（composite + noEmit + include）+ `tsconfig.all.json` references

## worktree

**真源 = `~/git/AGENTS.md` 的 `rule.worktree*` 三条**（`worktree` / `worktree-selfcheck` / `worktree-path`）：改代码前一律先开 worktree；路径是 `<仓库父目录>/<仓库目录名>.worktrees/<标识>`（`~/git/diy/diy` → `~/git/diy/diy.worktrees/<标识>`）。

真源随 AGENTS.md 链每轮常驻，本处只留锚点（`rule/dev#worktree` 被 `~/AGENTS.md` 等处引用），**不再复制正文** —— 2026-11-22 去重前这里的副本已与真源分叉（停在旧口径 `~/git/<项目名>.worktrees/`，2026-11-21 已停用），而 `diy2 facts` 仍在返回它。
