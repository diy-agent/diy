# diy Agent Instructions

This file is the repository-wide instruction context for coding agents.
`npm run sync` may link `GEMINI.md`,`CLAUDE.md` and `QWEN.md` to this file, so keep it
generic, execution-focused, and short.

## What This Repo Is

diy is a Python monorepo for orchestrating coding agents through a
shared CLI workflow.

Primary workspaces:
- `packages/diy-cli.py`: CLI entrypoints, evolve loop, planner, sync logic.
- `packages/diyui.py`: reactive UI wrapper over Panel.
- `packages/diydev`: development utilities and skills.

Important entrypoints:
- `packages/diy-cli.py/src/diycli/`
- `packages/diyui.py/src/diyui/`
- `packages/diydev/src/diydev/`
- `sha.sh`

## Hard Rules

### Validation

- After each meaningful change, run at least one validation command.
- Use `uv run pytest` for local changes.
- Use `./sha.sh check` when changes span packages or shared build behavior.
- Prefer the smallest verifiable change over broad refactors.

### Python 包安装

- **禁止直接使用 `pip install`**，因为未激活 venv 时会污染全局 Python 环境
- 必须使用 `uv pip install` 或 `uv run`，确保安装到项目 `.venv` 内
- 示例：`uv pip install -e packages/diydev`、`uv run dev list`

### Scripting and Error Handling

- Do not hide error messages in scripts (e.g., avoid `2>/dev/null`). All errors should be visible for easier debugging.

### Reference Code

- `.diy/ref/` is read-only reference material for dependency internals.
- Run `uv run dev sync` when mirrored dependency sources or their index may be stale.
- Dependency mirror index: `.diy/ref/ref.lock.json`.
- Never import from `.diy/ref/`.
- Read dependency internals in this order:
  1. Current project code
  2. `.diy/ref/`
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
- 提交信息遵循 Conventional Commits（`feat:`、`fix:`、`chore:`、`docs:` 等），格式参考 `docs/dev-flow-commit-publish.md`
- GPG 签名失败时使用 `--no-gpg-sign` 绕过（仅限开发环境），不修改系统 GPG 配置
- **绝对不要自主 push**，必须等用户明确要求后再执行
- 遇到不确定的内容（如 secret 配置、token 值），停下来问用户
- 首次写新文件后提醒用户检查是否应加入 `.gitignore`

## Useful Commands

```bash
uv run pytest
./sha.sh check
./sha.sh test
./sha.sh test-all
uv run dev sync
sha.sh doctor release     # release 流程诊断
```
