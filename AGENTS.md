# Dao Agent Instructions

This file is the repository-wide instruction context for coding agents.
`npm run sync` may link `GEMINI.md` and `QWEN.md` to this file, so keep it
generic, execution-focused, and short.

## What This Repo Is

Dao is a Node.js + TypeScript monorepo for orchestrating coding agents through a
shared CLI workflow.

Primary workspaces:
- `packages/dao-cli`: CLI entrypoints, evolve loop, planner, sync logic.
- `packages/dao-core`: agent wrappers and shared runtime abstractions.
- `packages/dao-tui`: terminal UI components.

Important entrypoints:
- `packages/dao-cli/src/dao/cli.ts`
- `packages/dao-cli/src/dao/evolve.ts`
- `packages/dao-cli/src/common/sync.ts`
- `sha.sh`

## Hard Rules

### Validation

- After each meaningful change, run at least one validation command.
- Use `npm run test` or `npm run check` for local changes.
- Use `npm run check:all` when changes span packages or shared build behavior.
- Prefer the smallest verifiable change over broad refactors.

### TypeScript And ESM

- The repo uses strict ESM and NodeNext resolution.
- Local imports must keep the `.js` extension.
- Do not use `as any` or `@ts-ignore` without explicit user approval.
- Do not leave placeholder edits such as `TODO`, `...`, or commented-out replacement blocks instead of real code.

### Reference Code

- `.dao/ref/` is read-only reference material for dependency internals.
- Run `npm run sync` when mirrored dependency sources or their index may be stale.
- Dependency mirror index: `.dao/ref/ref.lock.json`.
- Use `ref.lock.json` only when you need dependency internals, then read the mapped source under `.dao/ref/`.
- Never import from `.dao/ref/`.
- Read dependency internals in this order:
  1. Current project code
  2. `.dao/ref/`
  3. `node_modules/`
  4. Online documentation

## Agent Workflow

- Read the closest relevant code before changing anything.
- **When working on a specific package, always read the `AGENTS.md` in that package directory first** - it contains module-specific documentation not repeated here.
- Prefer targeted edits over rewriting whole modules.

## Useful Commands

```bash
npm run test
npm run check
npm run check:all
npm run build
npm run sync
```
