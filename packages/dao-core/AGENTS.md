# dao-core - Core Abstractions for Coding Agent Orchestration

## Overview

`dao-core` provides shared runtime abstractions and interfaces for orchestrating multiple coding agents through a unified CLI workflow.

Key responsibilities:
- `CodingAgent` interface - unified abstraction for any coding agent
- Agent event streaming types
- Configuration and session management
- Adapters for external agent protocols

---

## Current Development Task: ACP Client Adapter

### Task Description

Implement a generic `AcpClientAdapter` that allows **dao** to spawn and communicate with any external ACP-compatible coding agent as a subprocess. ACP (Agent Client Protocol) is an open standard that enables communication between code editors and AI coding agents.

Supported external agents:
- **OpenCode** - `opencode acp`
- **Gemini CLI** - `gemini --acp`
- Any other ACP-compliant agent

### Background & Research References

**All research is already done!** Full analysis available at:
- `research/acp/docs/acp-opencode.gen.md` - OpenCode ACP implementation analysis
- `research/acp/docs/gemini-acp.gen.md` - Gemini CLI ACP implementation analysis
- The research contains complete protocol analysis, capability matrices, usage examples, and design sketches. **Read these before starting implementation.**

### Goals

1. Create a generic, reusable adapter that works with any ACP agent
2. Implement the existing `CodingAgent` interface for consistency
3. Support all core ACP features: initialization, authentication, streaming, permissions
4. Allow dao-cli/dao-tui to handle permissions and file operations via existing UI

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     dao-cli / dao-tui (UI Layer)                 │
│  - User interaction (permission prompts)                        │
│  - File system operations                                       │
│  - Session management                                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    dao-core (Adapter Layer)                     │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │ AcpClientAdapter│  │  Other Adapters │  │  Native Agents  │ │
│  │  (Generic ACP)  │  │                 │  │                 │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 Protocol Layer: @agentclientprotocol/sdk        │
│  - JSON-RPC 2.0 over stdio                                      │
│  - NDJSON framing (newline-delimited)                          │
│  - Type-safe protocol implementation                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Subprocess (External Agent)                  │
│  - opencode acp                                                 │
│  - gemini --acp                                                 │
│  - other ACP agents...                                          │
└─────────────────────────────────────────────────────────────────┘
```

### Required Interface: `AcpClientAdapter`

Must implement the existing `CodingAgent` interface defined in the codebase.

```typescript
// Constructor options sketch:
export interface AcpClientAdapterOptions extends AgentOptions {
  command: string;                    // Path to agent binary, e.g. "opencode"
  args?: string[];                    // Command args, e.g. ["acp"]
  apiKey?: string;                     // API key for authentication (if needed)
  authMethod?: string;                 // Authentication method ID
  cwd?: string;                        // Working directory
  clientCapabilities?: ClientCapabilities;
}

// Key methods to implement:
export class AcpClientAdapter implements CodingAgent {
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private sessionId: string | null = null;

  constructor(private options: AcpClientAdapterOptions) {}

  async initialize(): Promise<void>
  async ask(prompt: string, signal?: AbortSignal): Promise<AgentStreamEvent[]>
  getSessionId(): string
  async cancel(): Promise<void>
  async dispose(): Promise<void>
}
```

### Features to Implement

- [ ] **Spawn subprocess** - Use Node.js `child_process.spawn`
- [ ] **NDJSON streaming** - Use `ndJsonStream` from `@agentclientprotocol/sdk`
- [ ] **Initialize handshake** - `connection.initialize()` with client info
- [ ] **Authentication** - Forward API key if provided
- [ ] **Create new session** - `connection.newSession()` with cwd and MCP config
- [ ] **Convert prompt to ACP content blocks**
- [ ] **Stream response via `sessionUpdate`** - Convert ACP events to `AgentStreamEvent`
- [ ] **Permission request handling** - Map ACP `requestPermission` to dao permission callback
- [ ] **File system operations (fsRead/fsWrite)** - Map to dao file system
- [ ] **MCP server configuration** - Pass through from client options
- [ ] **Cancel support** - `connection.cancel()`
- [ ] **Error handling** - Map ACP error codes to dao errors

### Key Design Decisions from Research

1. **Use official SDK**: Don't implement JSON-RPC manually. Use `@agentclientprotocol/sdk` from npm. This ensures protocol compliance.

2. **Event mapping**: ACP pushes incremental updates via `sessionUpdate` notification. Map these to dao's internal `AgentStreamEvent` type.

3. **Permission flow**: When ACP agent requests permission, forward the request to dao's UI layer (dao-tui), user makes the choice, send the choice back to ACP agent.

4. **File system integration**: If the ACP agent requests file operations via `fsRead`/`fsWrite`, let dao handle them using the local file system. This gives consistent behavior across all agents.

5. **Generic configuration**: The adapter should be configuration-driven - support any ACP agent by configuring command + args, no hardcoding for specific agents.

### Dependencies

Add to `package.json`:
```json
"dependencies": {
  "@agentclientprotocol/sdk": "^1.0.0"
}
```

### File Location

Create new file: `src/acp-client-adapter.ts`

Export from `src/index.ts`:
```typescript
export { AcpClientAdapter } from './acp-client-adapter.js';
export type { AcpClientAdapterOptions } from './acp-client-adapter.js';
```

### Implementation Steps (Phase 1 - Basic Functionality)

- [ ] Add `@agentclientprotocol/sdk` dependency to `package.json`
- [ ] Create `acp-client-adapter.ts` with empty class skeleton
- [ ] Implement `initialize()`: spawn subprocess, setup connection, initialize handshake, authenticate, create session
- [ ] Implement `ask()`: send prompt, collect/converter events, return result
- [ ] Implement `cancel()`, `dispose()`, `getSessionId()`
- [ ] Implement basic permission handling (default to approve for now, or call callback)
- [ ] Implement basic file system operations (read from local disk)
- [ ] Test with simple case

### Implementation Steps (Phase 2 - Advanced Features)

- [ ] Full permission callback integration with dao TUI
- [ ] MCP server configuration support
- [ ] Session loading/resuming support
- [ ] Model/mode switching support
- [ ] Full error handling and recovery

### Protocol Compliance

Based on research, both OpenCode and Gemini CLI implement the full ACP specification. Our client just needs to follow the official SDK types.

Key protocol points:
- JSON-RPC 2.0 over stdio
- NDJSON framing (one JSON per line)
- All core methods are standardized

### Testing

After implementation:
- Manual test with `opencode acp` if available
- Manual test with `gemini --acp` if available
- Add unit tests for connection handling
- Run `npm run check` for TypeScript validation

---

## Existing Code Structure

- `src/agent.ts` - defines `CodingAgent` interface and `AgentStreamEvent` types
- Implement `AcpClientAdapter` to conform to this interface

## Development Rules

Follow the hard rules from the root `CLAUDE.md`:
- Use strict ESM and NodeNext resolution
- Keep `.js` extensions on local imports
- No `as any` without approval
- No TODO placeholders - implement completely
- Read existing code before changing anything
- Run `npm run check` after changes for validation
