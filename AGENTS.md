# diy Agent Instructions

## What This Repo Is

diy 是 diy 生态主 monorepo，编排 agent 工作流的共享 CLI 基础设施。

主要 workspace:
- `pkgs/diy-cli` — CLI 入口、evolve loop、planner、sync
- `pkgs/diy-ui` — Panel 之上的 reactive UI 封装

## 项目特有约束

### GPG
- GPG 签名失败时停下求助，**禁止 `--no-gpg-sign` 绕过**


