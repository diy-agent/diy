# diy Agent Instructions

## What This Repo Is

diy 是 diy 生态主 monorepo，编排 agent 工作流的共享 CLI 基础设施。

主要 workspace:
- `pkgs/diy-cli` — CLI 入口、evolve loop、planner、sync
- `pkgs/diy-ui` — Panel 之上的 reactive UI 封装

## 项目特有约束

### 编码
- 优先小步验证，避免大范围重构
- 改代码前先读最近的关联代码
- 从文件读数据，不编造

### GPG
- GPG 签名失败时停下求助，**禁止 `--no-gpg-sign` 绕过**

### 参考代码
- 依赖镜像索引: `.diy/ref.lock.json`
- 读依赖内部实现顺序: `~/.diy/ref` → `.venv/lib/`
