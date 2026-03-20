# Dao Project Instructions (System Protocol)

## 🎯 Project Vision

Dao encapsulates existing open-source agent CLI tools (gemini-cli, qwen-code, codex, pi, opencode) and provides:

1. **Core Functionality**: An AI-driven autonomous development tool guided by user goals. It evolves through workflows(can custom): goal understanding -> approach research -> planning -> execution -> review -> upgrading.
2. **Multi-Interface**: Unified CLI & web interface for multi-agent conversations.
3. **Observability**: In-depth explanation tools and tracing for each AI agent.
4. **Evaluation**: Benchmarking tools for various LLM agents.
5. **Anti-Hallucination**: Dependency source code, documentation, and configuration synchronization (`.dao/ref/`).
6. **Framework Agnostic**: Fully customizable workflows without specific framework lock-in.

**Project Status**: Initial development phase.

---

## 💻 Tech Stack

- **Runtime**: Node.js (Strict ESM, `"type": "module"`)
- **Language**: TypeScript (Strict mode, target ES2024, NodeNext)
- **Build/Dev**: `tsc` (dist/) + `tsx` (direct execution)
- **Testing**: `vitest` (`test/**/*.test.ts`)
- **Lint/Format**: `eslint` + `typescript-eslint` + `prettier`
- **Logging/Tracing**: `pino` + `pino-pretty` + `OpenTelemetry` (gRPC/HTTP export)
- **UI**: `@mariozechner/pi-tui` + `yoga-layout` (Declarative Terminal UI)
- **CLI**: `commander` + `@google/gemini-cli-core`
- **Package Management**: `npm workspaces` (Monorepo)
- **VCS**: `git worktree` isolated development workflow

---

## 🛠️ Commands

```bash
# Core Build & Quality
npm run build          # Build current package
npm run build:all      # Build all workspace packages
npm run test           # Run root tests (vitest run)
npm run test:all       # Run all workspace tests
npm run check          # tsc --noEmit + eslint (Local check)
npm run check:all      # Full monorepo type check + lint
npm run format         # Prettier formatting
npm run clean:all      # Clean all dist directories

# Project Specific
npm run evolve         # Start autonomous evolution loop
npm run sync           # Sync dependency source maps and configs to .dao/ref/

# Git Worktree Workflow (CRITICAL)
./sha.sh worktree add <name>    # Create worktree branch (.worktree/<name>)
./sha.sh worktree merge <name>  # Test + merge to main + cleanup
./sha.sh worktree list          # List all active worktrees
./sha.sh worktree remove <name> # Remove worktree without merging
```

---

## 📂 Project Structure

```text
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
│   ├── dao-tui/           # Declarative terminal UI components
│   │   └── src/index.ts
│   └── devtools/          # Dev debugging: HTTP/WS server, network logging
│       └── src/
│           ├── index.ts           # DevTools singleton
│           ├── activity-logger.ts # Request interceptor
│           └── types.ts
├── config/                #  goals, toolchain, guardrails
├── docs/                  # Architecture docs, roadmap
├── bin/dao                # Global CLI entry script
├── sha.sh                 # Bash scaffold: worktree/workspace/submodule management
├── vendor/sha/            # Git submodule: shared bash utilities
├── .dao/ref/              # Dependency source mirror (READ-ONLY, NEVER IMPORT)
├── temp/                  # Experiment/trial directory
├── state/                 # Runtime state (gitignored)
├── logs/                  # Log output (gitignored)
├── todo/                  # Development improvement notes
├── tsconfig.json          # Build config (NodeNext)
├── tsconfig.ide.json      # IDE source navigation (Path mappings to .dao/ref)
└── AGENTS.md              # This file: Shared AI agent instructions
```

---

## 📜 Development Rules

### 1. Evolution Rules
- **Test-Driven**: Run `npm run test` or `npm run check:all` after **every** modification.
- **Minimal Changes**: Each evolution round must contain the smallest verifiable change.
- **Observability First**: Prioritize adding logs, heartbeats, and OpenTelemetry spans.

### 2. Git Worktree Workflow (STRICT)
**NEVER modify the `main` branch directly.**
1. Create worktree: `./sha.sh worktree add <name>`
2. Develop inside: `.worktree/<name>`
3. Merge: `./sha.sh worktree merge <name>` (This auto-runs tests before merging).

### 3. ESM & TypeScript Standards
- **Suffix Rule**: Imports MUST include the `.js` extension (e.g., `import { x } from "./y.js"`).
- **No Hacks**: `as any` or `@ts-ignore` are forbidden without user authorization.
- **Surgical Edits**: Use targeted replace operations. NEVER use `// ... rest of code` placeholders.
- **No .dao/ref Imports**: Code must use standard package names. `.dao/ref` is for reference ONLY.

### 4. Source Accuracy (Anti-Hallucination)
Consult sources in this priority:
1. Current Project Code
2. `.dao/ref/` dependency source code (Verify actual logic/signatures)
3. `node_modules/` (If no mirror exists)
4. Online documentation (Last resort)

### 5. Self-Correction Protocol
When stuck in repeated failures:
1. Search for similar implementations within the project.
2. Consult `.dao/ref/` source definitions for the dependency.
3. Move to `temp/` to re-validate the logic in isolation.

---

## 🔗 Dependency Tree (Context Map)

```text
dao-cli (main entry)
├── dao-core   (@whonb/agents-gemini-cli)  -- Gemini Agent abstraction
├── dao-tui    (@whonb/dao-tui)            -- Terminal UI
└── devtools   (@whonb/devtools)           -- Debug tools
```


## 🔍 AI Context Mapping (Dependency Mirrors)

<!-- DAO_DEPS_START -->

> **IMPORTANT**: This section is auto-generated for AI Source Analysis. 
> Format: `[package] -> [local_source_path]`. 
> When you need to understand the internal logic of a dependency, READ from the mapped `.dao/ref/` path. **DO NOT** attempt to modify these files.

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
