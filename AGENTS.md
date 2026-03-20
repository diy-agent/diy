# Dao Project Instructions

## Project Vision


Dao encapsulates existing open-source agent CLI tools (gemini-cli, qwen-code, codex, pi, opencode) and provides the following features:

1. **Core Functionality**: An AI-driven autonomous development tool that is guided by user goals and vision. It continuously evolves autonomously through workflows including goal understanding, approach research, planning, execution, review, and upgrading, to better achieve user objectives.
2. Unified CLI & web interface for multi-agent conversations.
3. In-depth observability and explanation tools for each AI agent.
4. Evaluation tools for various AI agents.
5. Dependency source code, documentation, and configuration synchronization tools to reduce AI hallucinations.
6. Fully customizable workflows without being bound to any specific framework or paradigm.

Project Status: Initial development phase.

## Tech Stack

- **Runtime**: Node.js (ESM, `"type": "module"`)
- **Language**: TypeScript (strict mode, target ES2024)
- **Build**: tsc (tsconfig.json -> dist/)
- **Dev runner**: tsx (executes .ts directly without compilation)
- **Test**: vitest (`test/**/*.test.ts`)
- **Lint**: eslint + typescript-eslint
- **Logging**: pino + pino-pretty
- **Tracing**: OpenTelemetry (gRPC/HTTP export)
- **Terminal UI**: @mariozechner/pi-tui + yoga-layout
- **CLI framework**: commander
- **AI SDK**: @google/gemini-cli-core
- **Package management**: npm workspaces (monorepo)
- **Version control**: git worktree isolated development

## Commands

```bash
npm run build          # Build current package
npm run build:all      # Build all workspace packages
npm run test           # Run root tests (vitest run)
npm run test:all       # Run all workspace tests
npm run check          # tsc --noEmit + eslint (type check + lint)
npm run check:all      # check for all workspaces
npm run evolve         # Start autonomous evolution loop
npm run sync           # Sync dependency source maps and configs
npm run format         # Prettier formatting
npm run clean:all      # Clean dist directories

# Git Worktree Workflow
./sha.sh worktree add <name>    # Create worktree branch (.worktree/<name>)
./sha.sh worktree merge <name>  # Test + merge to main + cleanup
./sha.sh worktree list          # List all worktrees
./sha.sh worktree remove <name> # Remove worktree without merging
```

## Project Structure

```
dao/
├── packages/
│   ├── dao-cli/           # Main entry: CLI interface, evolution loop, planner
│   │   └── src/
│   │       ├── dao/       # Core: cli.ts(entry) evolve.ts(engine) planner.ts tracing.ts
│   │       ├── common/    # Utilities: logger.ts fs.ts sync.ts
│   │       └── tools/     # Helper tool scripts
│   ├── dao-core/          # Gemini Agent wrapper: SimpleGeminiAgent class
│   │   └── src/
│   │       ├── index.ts
│   │       └── simple-agent.ts
│   ├── dao-tui/           # Declarative terminal UI: App/Label/Header/Horizontal/Vertical
│   │   └── src/index.ts
│   └── devtools/          # Dev debugging: HTTP/WS server, network logging, frontend UI
│       └── src/
│           ├── index.ts           # DevTools singleton
│           ├── activity-logger.ts # Request interceptor
│           └── types.ts
├── config/
│   └── evolution.json     # Evolution config: goals, toolchain, guardrails, timeouts
├── docs/                  # Architecture docs, roadmap
├── bin/dao                # Global CLI entry script
├── sha.sh                 # Bash scaffold: worktree/workspace/submodule management
├── vendor/sha/            # Git submodule: shared bash utilities
├── .dao/ref/              # Dependency source mirror (gitignored, IDE navigation only, never import directly)
├── temp/                  # Experiment/trial directory
├── state/                 # Runtime state (gitignored)
├── logs/                  # Log output (gitignored)
├── todo/                  # Development improvement notes
├── tsconfig.json          # Build config (NodeNext)
├── tsconfig.base.json     # Shared base config (ES2024, strict)
├── tsconfig.ide.json      # IDE source navigation (contains .dao/ref path mappings)
├── vitest.config.ts
├── eslint.config.mjs
└── AGENTS.md              # This file: shared AI agent instructions
```

### Package Dependencies

```
dao-cli (main entry)
├── dao-core   (@whonb/agents-gemini-cli)  -- Gemini Agent abstraction
├── dao-tui    (@whonb/dao-tui)            -- Terminal UI
└── devtools   (@whonb/devtools)           -- Debug tools
```

## Development Rules

### Evolution Rules

1. **Test-Driven**: Run tests after every code change to verify modifications. Use `npm run check:all` or `npm run test:all`.
2. **Minimal Changes**: Each evolution round must only contain the smallest verifiable change. Avoid large-scale refactoring.
3. **Observability First**: Prioritize adding logs, heartbeats, and OpenTelemetry tracing.

### Git Worktree Workflow (CRITICAL)

NEVER modify the `main` branch directly. All development must use worktree isolation.

1. Create worktree: `./sha.sh worktree add dao-feature-<name>`
2. Develop inside: `.worktree/dao-feature-<name>`
3. Merge when done: `./sha.sh worktree merge dao-feature-<name>` (auto-tests + merge + cleanup)

### ESM & TypeScript Standards

- **ESM environment**: All code is ESM. Import paths MUST include `.js` extension.
- **No `as any` or `@ts-ignore`**: Forbidden without explicit user authorization.
- **Mandatory validation**: Run `npm run check` or `npx tsc --noEmit` after ANY `.ts`/`.tsx` change. Fix all errors before delivery.
- **Surgical edits**: Use standard diff format or explicit search/replace blocks. DO NOT rewrite the entire file unless it's under 50 lines..
- **Trial first**: Test complex logic in the `temp/` directory before applying to the main codebase.
- **No .dao/ref imports**: Code MUST use standard package names (e.g., `import chalk from "chalk"`). The `.dao/ref` directory is ONLY for IDE source navigation via `tsconfig.ide.json` path mappings.

### Source Accuracy (Use Retrieval-Augmented Generation)

Consult sources in this order:
1. Project code (for project-specific questions)
2. `.dao/ref/` dependency source code (for dependency questions)
3. `node_modules/` (if no source mirror available)
4. Online documentation (last search, verify version alignment)

### Self-Correction Protocol

When stuck in repeated failures, DO NOT blindly retry. Instead:
1. Search for similar implementations within this project
2. Consult relevant dependency source definitions in `.dao/ref/`
3. Return to `temp/` trial directory to re-validate approach

### Delivery Checklist

Before delivering any change, verify:
- No hardcoded paths that would fail on other machines
- No local file references that are machine-specific
- No temporary hacks introduced just to make things pass
- All type checks pass (`npm run check`)

### Commit Convention

Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0).

### Protected Paths

- **DO NOT modify**: `dist/`, `node_modules/`, `state/`, `logs/`
- **Edits allowed in**: `src/`, `config/`

## Key Configuration Files

- `tsconfig.ide.json`: IDE path mappings (standard package names -> .dao/ref local source)
- `.gitmodules`: vendor/sha submodule (bash utility library)
- `.eslintignore` / `eslint.config.mjs`: Lint rules, prohibits imports from .dao/ref

## Current Roadmap Focus

- Implement Planner Agent module: LLM-based reflection on recent execution history to auto-generate new objectives
- Improve ROADMAP.md auto read/write mechanism
- Introduce exploration mode: periodically discover refactoring opportunities
- Generalize `dao init` to support initializing evolution environment in any directory

## Direct Dependencies

<!-- DAO_DEPS_START -->
<!-- Auto-generated, do not edit manually -->
<!-- Dependency tree format: `[package@version] -> [source directory]`. Top level = workspace modules; indented = direct dependencies; `->` suffix points to local source mirror path for AI source analysis. -->
- @whonb/dao@0.1.0 -> .
  - @eslint/js@^9.21.0 -> .dao/ref/github.com/eslint/eslint/v9.21.0/packages/js
  - @types/node@^22.0.0 -> .dao/ref/github.com/DefinitelyTyped/DefinitelyTyped/22.0.0/types/node
  - eslint@^9.21.0 -> .dao/ref/github.com/eslint/eslint/v9.21.0
  - tsx@^4.7.0 -> .dao/ref/github.com/privatenumber/tsx/v4.7.0
  - typescript@^5.6.3 -> .dao/ref/github.com/microsoft/TypeScript/5.0.0
  - typescript-eslint@^8.25.0 -> .dao/ref/github.com/typescript-eslint/typescript-eslint/v8.25.0/packages/typescript-eslint
  - vitest@^3.0.0 -> .dao/ref/github.com/vitest-dev/vitest/v3.0.0/packages/vitest
- @whonb/agents-gemini-cli@0.1.0 -> packages/dao-core
  - @google/gemini-cli-core@^0.34.0-preview.0 -> .dao/ref/github.com/google-gemini/gemini-cli/v0.34.0-preview.0
- @whonb/dao-cli@0.1.0 -> packages/dao-cli
  - @google/gemini-cli-core@^0.34.0-preview.0 -> .dao/ref/github.com/google-gemini/gemini-cli/v0.34.0-preview.0
  - @mariozechner/pi-tui@^0.57.1 -> .dao/ref/github.com/badlogic/pi-mono/v0.57.1/packages/tui
  - @opentelemetry/api@^1.9.0 -> .dao/ref/github.com/open-telemetry/opentelemetry-js/v1.9.0
  - @opentelemetry/exporter-trace-otlp-grpc@^0.213.0 -> .dao/ref/github.com/open-telemetry/opentelemetry-js/0.213.0
  - @opentelemetry/exporter-trace-otlp-http@^0.213.0 -> .dao/ref/github.com/open-telemetry/opentelemetry-js/0.213.0
  - @opentelemetry/resources@^2.6.0 -> .dao/ref/github.com/open-telemetry/opentelemetry-js/v2.6.0
  - @opentelemetry/sdk-trace-base@^2.6.0 -> .dao/ref/github.com/open-telemetry/opentelemetry-js/v2.6.0
  - @opentelemetry/semantic-conventions@^1.40.0 -> .dao/ref/github.com/open-telemetry/opentelemetry-js/1.40.0
  - @types/marked@^5.0.2 -> .dao/ref/github.com/DefinitelyTyped/DefinitelyTyped/5.0.2/types/marked
  - @types/node@^22.0.0 -> .dao/ref/github.com/DefinitelyTyped/DefinitelyTyped/22.0.0/types/node
  - @types/ws@^8.18.1 -> .dao/ref/github.com/DefinitelyTyped/DefinitelyTyped/8.5.10/types/ws
  - @whonb/agents-gemini-cli@*
  - @whonb/devtools@*
  - chalk@^5.6.2 -> .dao/ref/github.com/chalk/chalk/v5.6.2
  - commander@^14.0.1 -> .dao/ref/github.com/tj/commander.js/v14.0.1
  - get-east-asian-width@^1.5.0 -> .dao/ref/github.com/sindresorhus/get-east-asian-width/v1.5.0
  - jsonc-parser@^3.3.1 -> .dao/ref/github.com/microsoft/node-jsonc-parser/v3.3.1
  - marked@^17.0.4 -> .dao/ref/github.com/markedjs/marked/v17.0.4
  - pino@^10.3.1 -> .dao/ref/github.com/pinojs/pino/v10.3.1
  - pino-pretty@^13.1.3 -> .dao/ref/github.com/pinojs/pino-pretty/v13.1.3
  - ws@^8.19.0 -> .dao/ref/github.com/websockets/ws/8.16.0
- @whonb/dao-tui@0.1.0 -> packages/dao-tui
  - @mariozechner/pi-tui@^0.57.1 -> .dao/ref/github.com/badlogic/pi-mono/v0.57.1/packages/tui
  - @types/node@^22.0.0 -> .dao/ref/github.com/DefinitelyTyped/DefinitelyTyped/22.0.0/types/node
  - @types/yoga-layout@^1.9.2 -> .dao/ref/github.com/DefinitelyTyped/DefinitelyTyped/1.9.2/types/yoga-layout
  - chalk@^5.6.2 -> .dao/ref/github.com/chalk/chalk/v5.6.2
  - typescript@^5.0.0 -> .dao/ref/github.com/microsoft/TypeScript/5.0.0
  - yoga-layout@^3.2.1 -> .dao/ref/github.com/facebook/yoga/v3.2.1
  - yoga-layout-prebuilt@^1.10.0 -> .dao/ref/github.com/vadimdemedes/yoga-layout-prebuilt/v1.10.0
- @whonb/devtools@0.1.0 -> packages/devtools
  - @types/ws@^8.5.10 -> .dao/ref/github.com/DefinitelyTyped/DefinitelyTyped/8.5.10/types/ws
  - ws@^8.16.0 -> .dao/ref/github.com/websockets/ws/8.16.0
<!-- DAO_DEPS_END -->
