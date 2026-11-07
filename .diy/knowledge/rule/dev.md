---
desc: 本地开发环境与验证：worktree 位置与自检 / sha.sh check 唯一入口 / 并发禁令 / 实例起停权限 / 新包检查单
updated: 2026-10-24
---

## check

**类型检查只准 `./sha.sh check`**。各包 `noEmit:true`；一旦 emit，产物落在源码旁会被 `resolve.extensions` 优先命中（症状：改了没反应）

## dev-concurrent

**同一 variant** 的 `lab` 运行中勿并发 `tsc -b` / `vite build` / 全量 vitest（抢同一 `outDir`，watcher 卡死）。跨 variant（lab vs test）各写 `build/<v>`，不抢

## instance-lifecycle

**实例起停权限与数据定性**：`test` / `lab` 由 agent **自由起停**（随便折腾，不用问；`lab` 同时是人机沟通·验证 UI 的入口 —— 原 `preview` 的职责已并入它）。二者数据皆**临时非生产**（仓库根 `build/<variant>/home`，坏了就清，必要时可重置）。**唯全局 `diy`（prod / `~/.diy`）是日常实跑的生产 app** —— 不动其数据根、不杀其进程，重启留给用户手动。

## lab-owner

**lab 一律开在「自己任务的 worktree」里**（`~/git/diy.worktrees/t<号>-*/` 内 `./sha.sh lab`；数据根随之隔离在该 worktree 的 `build/lab/home`）。**根 worktree（`~/git/diy/diy`）的 `build/lab/home` 是「无主」的** —— 只与用户联合使用（人在那儿看效果），**agent 不自己去开**：判别不了谁在用，撞 `SingletonLock` 或把种子 / 真配置写进用户正开着的根。要实验先给自己任务开 worktree。

## new-pkg

新增包检查单：`tsconfig.json`（composite + noEmit + include）+ `tsconfig.all.json` references

## worktree

**git 项目上修改代码一律先开 git worktree 做**，不在主仓当前分支直接改；除非用户明确许可或确有特殊需要

## worktree-path

**worktree 放仓外同级 `~/git/<项目名>.worktrees/<标识>`**（`~/git/diy/diy` → `~/git/diy.worktrees/t323-xxx`）。
前提：`~/git` 不是 git 仓 ⇒ 无需 `.gitignore`。**仓内 `<repo>/diy.worktrees/` 已停用**（2026-10-29）：会让 AGENTS.md 链加载两份（worktree 自带 + 父目录主仓）。

## worktree-selfcheck

动手改文件前先 `pwd` + `git rev-parse --show-toplevel`：落在主仓工作树（如 `~/git/diy/diy`）就先建 worktree 再动；**判据 = 这次改动会不会进 git**（纯读不用、写要）。反例：##404 连续 6 次直接在 main 上提交 —— 规则不落成动作就等于没有
