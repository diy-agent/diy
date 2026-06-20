# diy — 主 monorepo

diy 生态的核心仓库。用 `uv` 管理的 Python monorepo，含两个正式包（diy-cli、diy-ui）。

## 目录结构

| 路径 | 说明 |
|------|------|
| `pkgs/diy-cli/` | `diy` CLI 工具（`diy sync` / `diy llm`） |
| `pkgs/diy-ui/` | Panel 响应式 UI 框架（Signal/ScopeProxy） |
| `scripts/` | 辅助脚本（doctor-env、lint-env、git-hook） |
| `vendor/` | 外部依赖源码快照 |
| `sha.sh` | 开发入口脚本，`./sha.sh --help` 查看子命令 |

## CLI

**`diy`** — Python 包 `diy-cli` 提供。入口 `diy = "diycli:main"`。
运行 `diy --help` 查看命令。主要子命令：
- `diy sync` — 同步项目依赖源码到 `~/.diy/`
- `diy llm ...` — LLM provider 配置同步（`diy llm --help`）

## 关键约束

- **GPG 签名** — git 操作必须 GPG 签名，失败时停下求助，禁止 `--no-gpg-sign` 绕过
- 代码注释用中文
- 意图测试（Intent Test）是需求的定义者，见 `_diy/AGENTS.md`
