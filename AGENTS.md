# diy Agent Instructions

## What This Repo Is

diy is a Python monorepo for orchestrating agents through a
shared CLI workflow.

Primary workspaces:
- `pkgs/diy-cli`: CLI entrypoints, evolve loop, planner, sync logic.
- `pkgs/diy-ui`: reactive UI wrapper over Panel.

Important entrypoints:
- `pkgs/diy-cli/src/diycli/`
- `pkgs/diy-ui/src/diy/ui/`
- `sha.sh`

## Hard Rules

### Validation

- After each meaningful change, run at least one validation command.
- Use `uv run pytest` for local changes.
- Use `./sha.sh check` when changes span packages or shared build behavior.
- Prefer the smallest verifiable change over broad refactors.

### Python 包安装

- **禁止直接使用 `pip install`**，因为未激活 venv 时会污染全局 Python 环境
- 必须使用 `uv add install` 或 `uv run`，确保安装到项目 `.venv` 内

### Scripting and Error Handling

- Do not hide error messages in scripts (e.g., avoid `2>/dev/null`). All errors should be visible for easier debugging.

### Reference Code

- Dependency mirror index: `.diy/ref.lock.json`.
- Read dependency internals in this order:
  2. `~/.diy/ref`
  3. `.venv/lib/`

## Data Handling Guidelines

- Always read data from files when explicitly provided; never invent data not present in the source files.

## Code Quality

- Always test code thoroughly before considering it complete, and be meticulous with shell command escaping, especially when handling variables.

## Agent Workflow

- Read the closest relevant code before changing anything.
- Prefer targeted edits over rewriting whole modules.

## Commit & Push Rules

- 提交前先 review: `git diff --stat`，确认不夹带密钥、token、无关文件
- 提交前先 review: 检查代码或命令行中是否错误使用了中文符号作为脚本和代码的语法分隔符
- 提交信息遵循 Conventional Commits（`feat:`、`fix:`、`chore:`、`docs:` 等），格式参考 `docs/dev-flow-commit-publish.md`
- GPG 签名失败时应应停下求助，不应使用 `--no-gpg-sign` 绕过（仅限开发环境），不修改系统 GPG 配置
- **绝对不要自主 push**，必须等用户明确要求后再执行
- 遇到不确定的内容（如 secret 配置、token 值），停下来问用户
- 首次写新文件后提醒用户检查是否应加入 `.gitignore`
- 删除文件前需得到用户同意(ai agent自建的临时文件除外)

## Useful Commands

```bash
./sha.sh check
./sha.sh test
./sha.sh test-all
./sha.sh doctor release     # release 流程诊断
```
