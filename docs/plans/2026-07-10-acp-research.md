# ACP 研究 + 实现设计（2026-07-10）

## 一、权威信息校正

基于 `agentclientprotocol.com` 官方文档（Protocol v1）、GitHub `agentclientprotocol` org 验证：

### 豆包回复的偏差

| 豆包声称 | 官方实际 |
|---------|---------|
| `protocolVersion: "0.1.0"` (string) | `protocolVersion: 1` (integer) |
| `initialize` 参数 `clientCapabilities.fs` 等 | 正确 ✅ |
| `agentCapabilities` 返回完整能力清单 | 正确 ✅ |
| `session.list/load/save/configure` | `loadSession`(顶层), `sessionCapabilities.{resume,close,delete,list}`(嵌套) |
| `session/update` (streaming 通知) | `session/update` — 正确 ✅ |
| 流式事件名 `agent_message_chunk` | 正确 ✅ |
| Registry 有 `acp.json` manifest | 正确 ✅ — `github.com/agentclientprotocol/registry` |
| `_meta` 扩展字段 | 正确 ✅ |

### 官方关键 API 汇总

**传输**：Stdio (NDJSON)、HTTP/SSE、WebSocket（后两者 RFC 阶段）

**生命周期**：
```
initialize
  ↓ (handshake: protocolVersion + capabilities)
session/new (create) / load / resume
  ↓
session/prompt (发送消息)
  ↕ session/update (流式推送: plan / agent_message_chunk / tool_call / tool_call_update / usage_update)
  ↕ session/request_permission (权限申请)
  ↕ session/cancel (取消)
  ↓
session/prompt response (stopReason: end_turn / cancelled / max_tokens / refusal)
```

**Capabilities** (agent 在 initialize response 中声明)：
```json
{
  "agentCapabilities": {
    "loadSession": true,
    "sessionCapabilities": {
      "resume": {},
      "close": {},
      "delete": {},
      "list": {},
      "additionalDirectories": {}
    },
    "promptCapabilities": {
      "image": false,
      "audio": false,
      "embeddedContext": true
    },
    "mcpCapabilities": {
      "http": true,
      "sse": false
    },
    "_meta": {
      "maxConcurrentSessions": 1
    }
  }
}
```

**流式推送** (`session/update` 通知，无 id，单向)：
```json
{
  "sessionUpdate": "agent_message_chunk",
  "messageId": "msg_abc",
  "content": { "type": "text", "text": "我来分析..." }
}
```

- `agent_message_chunk` — 文本 delta
- `agent_thought_chunk` — 推理过程 (RFD 阶段)
- `plan` — 执行计划
- `tool_call` — 工具调用开始
- `tool_call_update` — 工具状态 (in_progress / completed)

**Registry**：
- `github.com/agentclientprotocol/registry` — 每个 agent 提交 `acp.json` manifest
- 包含：`name`、`entrypoint`、`transports`、`capabilities` 静态声明
- 22+ agent 已注册 (Claude Agent, Codex, Cline, Cursor, Devin, Gemini CLI, etc.)

---

## 二、diy-desktop2 的 ACP 接入设计

### 架构原则

ACP 协议本身逻辑独立于 diy-desktop2 主仓库：

```
diy-desktop2 (Electron)
  ├── api.ts (RPC router)
  │     └── agent: router({
  │           chatStream: serverStream  → 已有流管道
  │           listModels: unary
  │           status: unary
  │         })
  │
  └── services/
        └── acp-agent.ts  ← 重写为真正的 ACP 客户端
              ├── spawn 子进程 (hermes acp / gemini --acp / ...)
              ├── initialize 握手 → 读取 capabilities
              ├── session 管理 (new / load / prompt / cancel)
              ├── session/update 回调 → yield to agent.chatStream
              └── session ID 持久化到 task frontmatter
```

### 需要实现的基础设施

| 模块 | 说明 | 行数估计 |
|------|------|---------|
| `AcpClient` | spawn 子进程 + NDJSON 帧解析 + JSON-RPC 收发 | ~150 |
| `AcpSession` | session 生命周期 + prompt + cancel | ~100 |
| `AcpCapabilities` | 从 `initialize` response 解析能力配置 | ~40 |
| `api.ts` 集成 | `agent.chatStream` handler 改为调 ACP | ~30 (修改) |
| Session 持久化 | sessionId → task AGENTS.md frontmatter | ~20 |

**总计 ~340 行**，不依赖 `@agentclientprotocol/sdk` npm 包（自建轻量实现，避免版本漂移）。

### 能力探测与降级

```ts
type AcpCapabilities = {
  loadSession: boolean;    // 默认 false
  resume: boolean;
  list: boolean;
  close: boolean;
  delete: boolean;
  mcpHttp: boolean;
  promptImage: boolean;
  // 自定义扩展
  _meta: Record<string, unknown>;
};
```

```ts
// 从 initialize response 构建
function parseCapabilities(result: InitializeResult): AcpCapabilities {
  const c = result.agentCapabilities;
  return {
    loadSession: c.loadSession ?? false,
    resume: !!c.sessionCapabilities?.resume,
    list: !!c.sessionCapabilities?.list,
    close: !!c.sessionCapabilities?.close,
    delete: !!c.sessionCapabilities?.delete,
    mcpHttp: c.mcpCapabilities?.http ?? false,
    promptImage: c.promptCapabilities?.image ?? false,
    _meta: c._meta ?? {},
  };
}
```

### Session 持久化

```
task AGENTS.md frontmatter:
  ---
  title: "研究 acp"
  state: active
  acp_session: "sess_abc123"    ← 从 session/new 返回
  acp_agent: "hermes"           ← 从 agentInfo.name
  ---
```

启动时：
- 读 frontmatter → 有 `acp_session` → 调 `session/load` 恢复
- 无 → 调 `session/new` 创建

### 流式集成到现有 pipe

当前 `agent.chatStream` 已是 `rpc.serverStream`，handler 中 `yield delta`：
```ts
agentChatStream: rpc.serverStream({
  call: async function* ({ input }) {
    const client = await getAgentClient();
    for await (const delta of client.streamChat(...)) {
      yield delta;  // → renderer 实时渲染
    }
  },
}),
```

重写后 `AcpClient` 的 `session/update` 回调直接 `yield`，不改管道。

---

## 三、实施步骤

### Step 2a: ACP 基础设施（~200 行）

1. `transport-builtin.ts` → 新增 `createStdioAcpTransport()` (spawn + NDJSON parser)
2. `AcpClient` 类：initialize handshake → 返回 capabilities
3. `AcpSession` 类：基于 AcpClient，管理 session 生命周期

### Step 2b: 集成到 diy-desktop2

4. 替换 `acp-agent.ts` 为基于 AcpClient 的实现
5. `api.ts` 的 `agent.chatStream` handler 对接 AcpSession
6. `agent.listModels` → 支持配置多个 agent (config file 或注册表)
7. Session 持久化：写/读 task frontmatter

### Step 2c: 验证

8. 对 Hermes (`hermes acp`) 做端到端测试
9. 支持至少 2 个 ACP agent (Hermes + 一个 Registry 中的免费 agent)

---

## 四、待决策项

1. **Agent 发现**：手动配置路径 vs 读 Registry manifest？
   - 建议：先手动配置（`~/.diy/acp.json`），后续接 Registry
2. **多 agent 同时在线**：一个 diy-desktop2 实例管理多个 ACP 子进程？
   - 建议：先单 agent，多 agent 通过切换实现
3. **`@agentclientprotocol/sdk` npm 包**：用还是不用？
   - 建议：**不用**。自建 ~150 行，避免：
     - SDK 版本跟随 spec 快速迭代导致的 breakage
     - SDK 对 Node.js 版本的最小要求约束
     - SDK 包含 v2 草案代码的干扰
