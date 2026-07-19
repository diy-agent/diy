# ACP OpenCode 接入 — 实现路径与清理清单（2026-07-11）

> **2026-07-14 修订** — 修正传输层错误（HTTP → stdio）、采用三层抽象设计、合并评审结论。
> 研究依据：`pkgs.ts/agent-protocol/`（ACP 协议研究）+ `docs/opencode/integration-notes.md`（接入笔记）+ `docs/agent-abstraction-design.md`（封装设计）

**决策**：
- 使用官方 `@agentclientprotocol/sdk` v1.2.1（已安装）。不自建 NDJSON/JSON-RPC 层。
- 对接 opencode 1.17.18，通过 `opencode acp` 的 **stdio** 传输（NDJSON over stdin/stdout）通信。
- `opencode acp` 的 `--port` 是内部 HTTP 后端（opencode 自用），**Client 不需要关心**。
- Hermes 暂不接入。
- `llmProxy`（Ollama 代理）整体移除，由 ACP agent 系统替代。

---

## 一、openCode ACP 关键事实

来源于 `docs/opencode/integration-notes.md`（CI 验证 + 源码确认）：

| 事实 | 值 |
|------|-----|
| **ACP 传输** | stdio（NDJSON），**不是 HTTP** |
| **启动命令** | `opencode acp`（无需 `--port`） |
| **内部 HTTP 后端** | `--port` 控制，opencode 自用，Client 透明 |
| **模型切换** | 不支持 ACP `session/set_model`，通过环境变量 `OPENCODE_CONFIG_CONTENT` 配置 |
| **认证方式** | `terminal` auth method，token 缓存于 `~/.local/share/opencode/auth.json` |
| **内存占用** | 200-500MB（Bun + LLM 上下文） |

| ACP 能力 | 支持 |
|----------|------|
| `initialize` | ✅ |
| `session/new` | ✅ |
| `session/resume` | ✅ |
| `session/fork` | ✅ |
| `session/list` | ✅ |
| `session/close` | ✅ |
| `session/stop` | ❌（需 kill 进程代替） |
| `session/set_model` | ❌（改用 config option 或环境变量） |

---

## 二、架构：三层抽象

设计来源：`docs/agent-abstraction-design.md`

```
┌──────────────────────────────────────────────────────────┐
│  GUI (agentStore) / CLI (diy2 agent chat)                │
│  listAgents() / listModels() / chatStream() / listSessions() │
└──────────────────────┬───────────────────────────────────┘
                       │ diy2 RPC (Electron IPC / HTTP/2)
┌──────────────────────▼───────────────────────────────────┐
│  api.ts — agent router                                    │
│  agent: router({                                          │
│    listAgents:   rpc.unary(...),                           │
│    listModels:   rpc.unary(...),                           │
│    chatStream:   rpc.serverStream(...),                    │
│    listSessions: rpc.unary(...),                           │
│    closeSession: rpc.unary(...),                           │
│  })                                                       │
│  → 全部委托给 AgentManager                                 │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│  AgentManager (src/main/services/agent-manager.ts)        │
│                                                           │
│  职责:                                                    │
│  1. 管理多个 AgentProvider 实例 (opencode, 未来cline...)    │
│  2. 路由请求到正确的 agent + session                       │
│  3. 维护 provider → process → sessions 映射                │
│                                                           │
│  ┌─────────────────────────────────────────────┐         │
│  │ AgentProvider 接口:                          │         │
│  │   id: string                                 │         │
│  │   start(): Promise<void>          // 懒启动   │         │
│  │   stop(): Promise<void>           // 优雅关闭  │         │
│  │   listModels(): Promise<Model[]>  // 模型列表  │         │
│  │   createSession(cwd): Promise<SessionHandle>  │         │
│  │   resumeSession(id): Promise<SessionHandle>   │         │
│  │   listSessions(): Promise<SessionInfo[]>      │         │
│  │   status(): ProviderStatus                    │         │
│  └─────────────────────────────────────────────┘         │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│  OpenCodeProvider implements AgentProvider                 │
│  ├── spawn("opencode", ["acp"], { stdio: "pipe" })        │
│  ├── ndJsonStream(stdin, stdout)                          │
│  ├── acp.client({ name: "diy2" }).connect(stream)         │
│  └── initialize → 多个 session/new (一条连接上)            │
│                                                           │
│  SessionHandle:                                           │
│  ├── prompt(text): AsyncGenerator<string>                 │
│  ├── close(): Promise<void>                               │
│  └── id, cwd                                              │
└──────────────────────────────────────────────────────────┘
```

**为什么需要抽象层：**

| 场景 | 不封装 | 封装后 |
|------|--------|--------|
| opencode 不支持 `session/set_model` | UI 需要知道限制 | 封装层通过 `OPENCODE_CONFIG_CONTENT` 环境变量补丁 |
| 换 agent (opencode → cline) | UI 需大量改动 | 只换 AgentProvider 实现 |
| agent 进程崩溃 | UI 需处理重连 | 封装层自动重启 + session/resume |
| 一条连接多个会话 | UI 管理 sessionId | 封装层透明管理 |

---

## 三、进程生命周期策略

### 状态机

```
[stopped] ──start()──→ [starting] ──ready──→ [running]
    ↑                      │                    │
    │                      ↓ (fail)             ↓ (crash)
    └──stop()── [stopping] ←────── [crashed] ──┘
                     │              auto-restart
                     ↓
                 [stopped]
```

### 策略

| 决策 | 方案 |
|------|------|
| 何时启动 | **懒启动**：首次 chat 请求时 spawn（避免空闲浪费 200-500MB） |
| 空闲回收 | **定时**：N 分钟（10-15min）无活动 → `session/close` 各 session → kill 进程 |
| 崩溃恢复 | **自动重启 + session/resume**：重 spawn → `initialize` → 对所有已知 sessionId 调 `session/resume`。连续 2-3 次失败 → 通知 UI `agent error` |
| 并发 prompt | 同一 session 串行，不同 session 可并发（ACP v1 原生支持） |
| 日志 | stderr pipe 到 `console.warn` 或 `~/.diy/logs/acp-opencode.log` |

### 启动代码

```ts
// ✅ 正确：stdio ACP，零端口管理
const proc = spawn("opencode", ["acp"], {
  stdio: ["pipe", "pipe", "pipe"],  // stdin, stdout, stderr
  env: {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "deepseek/deepseek-chat" }),
  },
});

const stream = ndJsonStream(
  Writable.toWeb(proc.stdin!),
  Readable.toWeb(proc.stdout!)
);

// ❌ 错误：HTTP ACP（`--port` 是内部后端，非 ACP 传输）
// createHttpStream(`http://127.0.0.1:${port}/acp`)
```

---

## 四、Session 策略

### 单连接多会话

ACP v1 原生支持一条 stdio 连接上多个 session。`session/update` 通知自带 `sessionId`，agent 内部自动路由：

```
一条 opencode stdio 连接:
  ├── session A: "sess_abc" → cwd=/projectA
  ├── session B: "sess_def" → cwd=/projectB
  └── session C: "sess_ghi" → cwd=/projectA (同目录不同会话)
```

### 生命周期

```
首次对话:
  session/new → 返回 sessionId → 存入内存 Map<cwd, sessionId>

后续对话（同一 cwd）:
  查 Map → session/resume(sessionId) → 恢复上下文
  若 resume 失败 → fallback session/new

对话结束:
  session/close（优雅关闭）
```

### 持久化到 task frontmatter

对齐 `plan-reevaluation.md` 的 TODO，将 session 绑定到 diy2 任务系统：

```yaml
# task 目录/AGENTS.md
---
acp_session: "sess_abc123"
acp_agent: "opencode"
---
```

- 首次对话 → `session/new` → 写入 frontmatter
- 后续打开该 task → 读取 frontmatter → `session/resume`
- resume 失败 → `session/new` + 更新 frontmatter

### 不需要独立缓存层

sessionId 是轻量字符串，内存 `Map<string, sessionId>` 即可。不涉及磁盘缓存、TTL、过期管理。

---

## 五、Permission 处理

opencode 可能通过 `session/request_permission` 请求权限（执行 shell、写文件等）。

默认策略：**全部自动允许**（开发环境使用）：

```ts
.onRequest("session/request_permission", (ctx) => ({
  outcome: { outcome: "selected", optionId: ctx.params.options[0]!.optionId },
}))
```

后续可改为 GUI 弹窗确认。

---

## 六、模型切换

opencode 不支持 ACP `session/set_model`，通过在 `spawn` 时注入环境变量切换模型：

```ts
// 启动时指定模型
spawn("opencode", ["acp"], {
  env: {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: "deepseek/deepseek-chat",
    }),
  },
});

// 运行时切换模型：重启进程 + 新 env → session/resume 恢复上下文
```

当前已配置的 Provider（`opencode providers list` 确认）：

```
● DeepSeek        (api — deepseek/deepseek-chat)
● OpenCode Go     (api — opencode-go/*)
+ OpenCode free   (内置 — opencode/*)
```

可用模型 20+，包括 `deepseek/deepseek-chat`、`opencode-go/deepseek-v4-pro`、`opencode/big-pickle` 等。

---

## 七、需要清理的代码

### 7.1 删除文件

| 文件 | 原因 |
|------|------|
| `src/main/services/acp-agent.ts` | Ollama HTTP 客户端。ACP 协议走 stdio NDJSON，不是 `/v1/chat/completions` REST API |
| `src/main/services/llm-proxy.ts` | Ollama HTTP 代理。ACP 迁移后不再需要 |
| `src/renderer/components-diy/LLmPage.tsx` | Ollama 代理管理页面，ACP 后无功能 |

### 7.2 修改文件

| 文件 | 改动 |
|------|------|
| `api.ts` | 移除 `llmProxy` router（3 个 procedure: status/start/stop）及 lazy import helper；移除外层 `agent` router 的旧 handler；新建内层 `agent` router（listAgents/listModels/chatStream/listSessions/closeSession） |
| `agentStore.ts` | `listModels` 改为调用 `agent.listModels`；`sendMessage` 适配新的 `chatStream` API |
| `shared/client.ts` | 移除 `LlmProxyStatus` 类型；更新 `ClientApi.llmProxy` 为 `ClientApi.agent` |
| `renderer/lib/rpc.ts` | 移除 `llmProxy` wrapper（3 个方法），新增 `agent` wrapper（5 个方法） |
| `cli/index.ts` | 移除 `llmProxy` CLI 分组，更新 `agent` 分组 |

### 7.3 保留不动的文件

| 文件 | 说明 |
|------|------|
| `AgentChatPanel.tsx` | GUI 不变，只改 store |
| `client.ts` (shared) | 类型定义更新，结构不变 |
| RPC 管道全部 | api.ts → createHandler → Transport 不变 |

---

## 八、新增文件

使用三层抽象设计（`agent-abstraction-design.md`）：

| 文件 | 行数估 | 说明 |
|------|--------|------|
| `src/main/services/agent-manager.ts` | ~80L | `AgentManager` 类 + `AgentProvider` 接口 + `SessionHandle` 接口 |
| `src/main/services/agent-provider-opencode.ts` | ~150L | `OpenCodeProvider implements AgentProvider`（spawn + ndJsonStream + ACP session 管理） |
| `src/main/services/agent-session.ts` | ~60L | `SessionHandle` 实现（prompt 流生成器） |

**总计 ~290L 新代码**

---

## 九、实施步骤

| Step | 内容 | 文件 | 预计 |
|------|------|------|------|
| **1. 清理** | 删除 `acp-agent.ts`、`llm-proxy.ts`、`LLmPage.tsx`；清理 `api.ts` 中的 `llmProxy` router 和旧 agent import；更新 `shared/client.ts`、`renderer/lib/rpc.ts`、`cli/index.ts` | 5 文件 | 15min |
| **2. 新建接口层** | `agent-manager.ts` — AgentManager + AgentProvider 接口 + SessionHandle 接口 | agent-manager.ts | 15min |
| **3. 实现 Provider** | `agent-provider-opencode.ts` + `agent-session.ts` — OpenCodeProvider（spawn + ndJsonStream + ACP session） | 2 文件 | 1.5h |
| **4. 重写 api.ts** | `agent` router → 5 个新 procedure（listAgents/listModels/chatStream/listSessions/closeSession），委托给 AgentManager | api.ts | 20min |
| **5. 更新前端** | `agentStore.ts` 适配新 API | agentStore.ts | 15min |
| **6. 验证** | CLI: `diy2 agent listAgents` / `diy2 agent chatStream`；GUI 对话 | — | 30min |

**总计：~3h**

---

## 十、文件变更摘要

```
删除:
  src/main/services/acp-agent.ts
  src/main/services/llm-proxy.ts
  src/renderer/components-diy/LLmPage.tsx

新增:
  src/main/services/agent-manager.ts           # AgentManager + 接口
  src/main/services/agent-provider-opencode.ts # OpenCodeProvider 实现
  src/main/services/agent-session.ts           # SessionHandle 实现

修改:
  src/main/services/api.ts              # agent router 重写，移除 llmProxy
  src/renderer/.../store/agentStore.ts  # 适配新 API
  src/shared/client.ts                  # 移除 LlmProxyStatus，更新 ClientApi
  src/renderer/.../lib/rpc.ts           # 移除 llmProxy wrapper，新增 agent wrapper
  src/cli/index.ts                      # 移除 llmProxy 分组
```

---

## 十一、前置确认

开始实施前需确认：

1. ✅ opencode 1.17.18 已安装
2. ✅ `@agentclientprotocol/sdk` 1.2.1 已安装
3. ⚠️ opencode 是否已配置 provider 并登录？
   ```bash
   opencode providers list
   ```
   如未配置，需先执行 `opencode providers login`

4. ⚠️ `opencode acp` stdio 模式是否正常工作？
   验证命令（在终端直接运行即可，无需端口）：
   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' | opencode acp 2>/dev/null | head -1
   ```
