# diy — 主 monorepo

diy 生态的核心仓库。用 `uv` 管理的 Python monorepo，含四个包（diy-core、diy-app、diy-cli、diy-ui）。

## 目录结构

| 路径 | 说明 |
|------|------|
| `pkgs/diy-core/` | 核心逻辑 — state/agent/task/subject 模型 |
| `pkgs/diy-app/` | PySide6 桌面管控台（MainWindow/GatewayCLI） |
| `pkgs/diy-cli/` | 统一 `diy` CLI 入口 |
| `pkgs/diy-ui/` | Panel 响应式 UI 框架（Signal/ScopeProxy） |
| `scripts/` | 辅助脚本（doctor-env、lint-env、git-hook） |
| `vendor/` | 外部依赖源码快照 |
| `sha.sh` | 开发入口脚本，`./sha.sh --help` 查看子命令 |

## CLI

**`diy`** — Python 包 `diy-cli` 提供。入口 `diy = "diy.cli:main"`。
运行 `diy --help` 查看命令。子命令分类：
- `diy task/subject/profile` — 任务管理（走 socket 透传）
- `diy ui *` — 管控台 UI 接口
- `diy agent` — ACP agent 管理（本地执行）
- `diy doctor` — 健康自检
- `diy restart/shutdown` — 管控台生命周期
- `diy llm/ref/scan` — LLM/镜像/仓库扫描

## 依赖链

```
diy-ui (独立, Panel)
diy-app ─→ diy-core
  diy-cli ─→ diy-core  (CLI → socket → diy-app)
```

- `diy-cli` 不依赖 `diy-app`（通过 Unix socket 通信）
- `diy-app` 依赖 `diy-core`
- `diy-core` 无 GUI 依赖

## 关键约束

- **GPG 签名** — git 操作必须 GPG 签名，失败时停下求助，禁止 `--no-gpg-sign` 绕过
- 代码注释用中文
- 意图测试（Intent Test）是需求的定义者，见 `_diy/AGENTS.md`
