# ACP Protocol Implementation in OpenCode

## Overview

[OpenCode](https://github.com/anomalyco/opencode) provides a complete implementation of the **Agent Client Protocol (ACP)** that allows OpenCode AI agent to be used as a subprocess within any ACP-compatible editor/IDE such as Zed, JetBrains IDEs, Neovim (Avante.nvim, CodeCompanion.nvim).

**Source:** https://github.com/anomalyco/opencode/tree/dev/packages/opencode/src/acp

## What is ACP?

ACP (Agent Client Protocol) is an open standard that standardizes communication between **code editors (clients)** and **AI coding agents (servers)**, enabling any ACP-compatible agent to work with any ACP-compatible editor.

Key points:
- JSON-RPC 2.0 protocol over stdio transport
- Standardized message formats for agent-client interaction
- Enables cross-platform interoperability
- Backed by Zed Industries and growing community adoption

## OpenCode ACP Architecture

OpenCode implements ACP with a clean separation of concerns:

```
packages/opencode/src/acp/
├── agent.ts       # Main ACP Agent implementation (implements ACP Agent interface)
├── session.ts     # Session state management
├── types.ts       # Internal type definitions
└── README.md      # Implementation documentation
```

### Core Components

#### 1. Agent (`agent.ts`)
- Implements the `Agent` interface from the official `@agentclientprotocol/sdk`
- Handles initialization and capability negotiation
- Implements all ACP protocol methods:
  - `initialize` - Protocol version negotiation, capability advertisement
  - `authenticate` - Authentication handshake (stub for OpenCode auth flow)
  - `newSession` - Create new conversation session
  - `loadSession` - Resume existing session with history replay
  - `prompt` - Process user prompt and generate response
  - `cancel` - Cancel ongoing generation
  - `unstable_listSessions` - List existing sessions
  - `unstable_forkSession` - Fork an existing session
  - `unstable_resumeSession` - Resume a session from history
  - `unstable_setSessionModel` - Change model for a session
  - `setSessionMode` - Change agent mode for a session

- Implements real-time updates via event subscription:
  - `permission.asked` → Forward permission requests to client
  - `message.part.updated` → Forward tool updates to client
  - `message.part.delta` → Stream text/reasoning chunks to client

#### 2. Session Manager (`session.ts`)
- Creates and tracks ACP sessions in-memory
- Maps ACP session IDs to internal OpenCode session IDs
- Maintains per-session context: `cwd`, MCP servers, model, mode, variant
- Provides CRUD operations for sessions

#### 3. Types (`types.ts`)
- `ACPSessionState` - Internal session state
- `ACPConfig` - Configuration for the ACP server

## Protocol Compliance Status

OpenCode's ACP implementation supports:

| Feature | Status | Notes |
|---------|--------|-------|
| Initialization & version negotiation | ✅ Full | Correct `initialize` handshake |
| Authentication | ✅ Partial | Stub with terminal-auth support |
| Session creation (`session/new`) | ✅ Full | |
| Session loading (`session/load`) | ✅ Full | Replays entire conversation history |
| Session listing | ✅ Full | Unstable |
| Session forking | ✅ Full | Unstable |
| Session resume | ✅ Full | Unstable |
| Set model | ✅ Full | Unstable |
| Set mode | ✅ Full | |
| Prompt processing | ✅ Full | All content block types |
| Streaming responses | ✅ Full | Via `session/update` notifications |
| Tool call progress reporting | ✅ Full | Real-time updates for pending/running/completed/failed |
| Permission requests | ✅ Full | Supports once/always/reject options |
| MCP server configuration | ✅ Full | HTTP and SSE supported |
| Image content | ✅ Full | |
| Resource links/embedding | ✅ Full | |
| Working directory context | ✅ Full | |
| Usage tracking/cost reporting | ✅ Full | Sends `usage_update` to client |
| Plan/todo reporting | ✅ Full | Converts todos to ACP plan entries |
| Terminal execution | ⚠️ Partial | Client handles terminal, OpenCode reports output |

## Key Features

### 1. Real-time Streaming
OpenCode pushes incremental updates to the client via ACP `session/update` notifications:
- **Agent message chunks** - Streaming text responses from the AI
- **Agent thought chunks** - Streaming reasoning content
- **Tool call updates** - Progress updates for tool execution (pending → in_progress → completed/failed)
- **Usage updates** - Token usage and cost information
- **Plan updates** - Current plan/todo list
- **Available commands update** - Available slash commands

### 2. Permission Handling
When OpenCode needs user approval for a tool execution, it forwards the request to the ACP client:
```json
{
  "sessionId": "...",
  "toolCall": {
    "toolCallId": "...",
    "status": "pending",
    "title": "...",
    "kind": "edit|read|execute|search|fetch|other",
    "locations": [{ "path": "..." }],
    "rawInput": {...}
  },
  "options": [
    { "optionId": "once", "kind": "allow_once", "name": "Allow once" },
    { "optionId": "always", "kind": "allow_always", "name": "Always allow" },
    { "optionId": "reject", "kind": "reject_once", "name": "Reject" }
  ]
}
```
For edit operations, OpenCode can directly apply the diff to the file via the client if approved.

### 3. Tool Mapping to ACP Kinds

OpenCode tools map to ACP standard tool kinds:

| OpenCode Tool | ACP ToolKind |
|---------------|--------------|
| bash | `execute` |
| webfetch | `fetch` |
| edit/patch/write | `edit` |
| grep/glob | `search` |
| read/list | `read` |
| other | `other` |

### 4. MCP Integration
ACP clients can pass MCP server configurations to OpenCode:
- HTTP MCP servers
- SSE MCP servers
- OpenCode automatically adds them to the session

### 5. Model & Mode Negotiation
- Advertises available models from OpenCode configuration
- Supports model variants
- Allows client to switch models at runtime
- Advertises available agent modes
- Allows client to switch modes at runtime

### 6. Command Discovery
- Advertises available slash commands to the client
- Client can invoke commands directly

## Startup Flow

When you run `opencode acp`:

1. Bootstrap OpenCode environment
2. Create internal HTTP server for SDK communication
3. Wrap stdin/stdout in a streaming interface
5. Initialize ACP agent with OpenCode SDK
6. Start ACP connection using `AgentSideConnection` from official SDK
7. Wait for JSON-RPC requests from client over stdio

JSON-RPC messages are framed using newline delimited JSON (NDJSON).

## Configuration Examples

### Zed
```json
{
  "agent_servers": {
    "OpenCode": {
      "command": "opencode",
      "args": ["acp"]
    }
  }
}
```

### JetBrains IDEs
```json
{
  "agent_servers": {
    "OpenCode": {
      "command": "/absolute/path/bin/opencode",
      "args": ["acp"]
    }
  }
}
```

### Avante.nvim
```lua
{
  acp_providers = {
    ["opencode"] = {
      command = "opencode",
      args = { "acp" }
    }
  }
}
```

## How OpenCode Maps ACP → OpenCode

| ACP Concept | OpenCode Concept |
|-------------|------------------|
| ACP Session | OpenCode Session |
| ACP Prompt → Content Blocks | OpenCode Message Parts |
| ACP Tool Calls | OpenCode Tool Execution |
| ACP MCP Servers | OpenCode MCP Configuration |
| ACP Mode | OpenCode Agent |
| ACP Model | OpenCode Provider/Model |

## Design Decisions

1. **Uses official SDK**: Uses `@agentclientprotocol/sdk` instead of rolling custom JSON-RPC implementation to ensure protocol compliance and reduce maintenance.

2. **Clean separation**: Agent (protocol) → SessionManager (state) → Client (operations).

3. **Event-driven streaming**: Subscribes to OpenCode internal events and pushes them as ACP `session/update` notifications for real-time streaming.

4. **Full history replay**: When loading/resuming sessions, OpenCode replays the entire conversation history to the client so the client has the full context.

5. **Type-safe**: Full TypeScript with proper imports from the official ACP SDK.

## Supported Editor Integrations

According to OpenCode documentation, the following editors are supported:
- **Zed** - Native ACP support
- **JetBrains IDEs** (IntelliJ, WebStorm, etc.) - ACP support in AI Assistant
- **Neovim** via **Avante.nvim**
- **Neovim** via **CodeCompanion.nvim**

All OpenCode features work over ACP except a few built-in slash commands like `/undo` and `/redo`.

## Environment Variables

- `OPENCODE_ENABLE_QUESTION_TOOL=1` - Enable the Question tool for interactive prompts (disabled by default, only enable if client supports it)

## Current Limitations

According to the OpenCode team, the following are not yet fully implemented:
- None major - most features are complete as of 2025

## References

- [ACP Official Site](https://agentclientprotocol.com/)
- [ACP GitHub Repository](https://github.com/agentclientprotocol/agent-client-protocol)
- [OpenCode ACP Documentation](https://opencode.ai/docs/acp)
- [OpenCode Repository](https://github.com/anomalyco/opencode)
