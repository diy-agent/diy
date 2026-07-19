# Agent 接入层设计

> 2026-07-11 讨论定稿 | 基于 task/subject 模型，对 ACP agent 做一层封装

## 一、设计原则

| # | 决策 | 理由 |
|---|------|------|
| 1 | **一层 API** | ACP 是 Provider 内部实现细节，不暴露 raw ACP API |
| 2 | **task 为中心** | 对话吸附在 task 上，不是通用 agent chat |
| 3 | **1 task = 1 session** | 线性对话，无分支，无并发 prompt |
| 4 | **惰性启动** | 首次 chat 时 spawn，用户通过 `instance stop` 手动回收 |
| 5 | **历史靠 agent** | 不自己存对话历史，依赖 ACP session/load |
| 6 | **严格转发** | 不在 session 内造并行子 agent，agent 自己的 subagent 由其内部管理 |
| 7 | **Provider 硬编码** | 暂不用配置文件，直接写在代码里 |
| 8 | **使用官方 SDK** | `@agentclientprotocol/sdk`，不自建 ACP 客户端 |
| 9 | **只对接 opencode** | Hermes 太重先不做，opencode 全能力免 auth |
| 10 | **Stdio 传输** | opencode 主支持 stdio，Registry 全部 agent 也是 stdio |

## 二、概念映射

```
diy2 领域概念               ACP 领域概念             说明
─────────────              ─────────────             ────
provider (agent 软件)       agent                     opencode（内置在 providers.ts）
instance (进程)             ACP connection            spawn 出的子进程，1 instance = 1 stdio conn
session (会话)              ACP session               session/new，1:1 绑定到 task
chat (对话)                 prompt turn               session/prompt → session/update
model (模型)                provider/model            deepseek/deepseek-chat
```

## 三、架构

```
GUI (agentStore) / CLI
  │  diy2 RPC (Electron IPC / HTTP/2)
  ▼
api.ts — agent router                         ← 5 组子 router，不暴露 ACP
  │
  ▼
AgentManager                                   ← 管理 providers + instances + sessions
  │   provider → instance → sessions 映射
  ▼
AgentProvider 接口                             ← 内部接口，每个 agent 实现一个
  │
  ▼
OpenCodeProvider                               ← 唯一实现（当前）
  ├── spawn("opencode", ["acp"])
  ├── ndJsonStream(proc.stdin, proc.stdout)    ← @agentclientprotocol/sdk
  ├── acp.client({ name: "diy2" }).connectWith(stream, ...)
  └── 一条连接上多个 session
```

### 实例与会话的拓扑

```
subject (~/work)                               ← scope = subject 路径
  └── instance (opencode 进程 × 1)             ← 同一 subject 的 task 共享
        ├── session ── task local/abc          ← 1:1 绑定
        ├── session ── task local/def
        └── session ── task local/ghi

另一个 subject:
subject (~/project)
  └── instance (opencode 进程 × 1)              ← 另一个进程
        └── session ── task proj/xyz
```

- 一个 agent 进程只有 **一个 cwd**（spawn 时传入的 subject 路径）
- 每个 session 在这个 cwd 下工作
- 一个 session 不能挂多个目录（ACP 不支持，可接受）

## 四、AgentProvider 接口

```ts
interface AgentProvider {
  readonly id: string;          // "opencode"
  readonly name: string;        // "OpenCode"

  // 进程生命周期
  start(subject: string): Promise<void>;
  stop(): Promise<void>;
  status(): ProviderStatus;     // "stopped" | "starting" | "running" | "error"

  // 模型
  listModels(): Promise<ModelInfo[]>;
  setModel(model: string): Promise<void>;

  // Session — 全部以 task 为入口
  createSession(taskUri: string): Promise<SessionHandle>;
  resumeSession(sessionId: string, taskUri: string): Promise<SessionHandle>;
  listSessions(): Promise<SessionInfo[]>;
  closeSession(sessionId: string): Promise<void>;
}

interface SessionHandle {
  readonly id: string;          // ACP sessionId
  readonly taskUri: string;
  readonly subject: string;

  prompt(text: string): AsyncGenerator<SessionChunk>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

type SessionChunk =
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; status: string }
  | { type: "done"; stopReason: string; tokens?: { input: number; output: number } }
  | { type: "error"; message: string };
```

## 五、RPC API（api.ts agent router）

按 CLI 名词层级组织，5 个子 router：

```ts
agent: router({
  provider: router({
    list: rpc.unary({}),       // 列出已注册的 agent (硬编码)
    info: rpc.unary({ input: { id: z.string() } }),
  }),

  instance: router({
    list:   rpc.unary({}),                      // 列出运行中的进程
    start:  rpc.unary({ input: { task: z.string() } }),  // 为 task 启动进程
    stop:   rpc.unary({ input: { id: z.string() } }),    // 手动回收
    status: rpc.unary({ input: { id: z.string() } }),
  }),

  model: router({
    list: rpc.unary({ input: { task: z.string().optional() } }),
    set:  rpc.unary({ input: { model: z.string(), task: z.string() } }),
  }),

  session: router({
    list:  rpc.unary({ input: { task: z.string().optional() } }),
    info:  rpc.unary({ input: { task: z.string() } }),
    close: rpc.unary({ input: { task: z.string() } }),
  }),

  chat: router({
    send:    rpc.unary({       input: { task: z.string(), message: z.string() } }),
    stream:  rpc.serverStream({ input: { task: z.string(), message: z.string() } }),
    history: rpc.unary({       input: { task: z.string(), limit: z.number().optional() } }),
    cancel:  rpc.unary({       input: { task: z.string() } }),
  }),
})
```

对应的 CLI：

```
diy2 agent provider list
diy2 agent provider info <id>

diy2 agent instance list
diy2 agent instance start --task <uri>
diy2 agent instance stop <id>
diy2 agent instance status <id>

diy2 agent model list [--task <uri>]
diy2 agent model set <model> --task <uri>

diy2 agent session list [--task <uri>]
diy2 agent session info --task <uri>
diy2 agent session close --task <uri>

diy2 agent chat send    --task <uri> <message>
diy2 agent chat stream  --task <uri> <message>
diy2 agent chat history --task <uri>
diy2 agent chat cancel  --task <uri>
```

### chat stream 流式消息格式

```
{ type: "text",  content: "好的" }              ← 文本增量
{ type: "text",  content: "，我来帮你" }
{ type: "tool_call", name: "read", status: "in_progress" }
{ type: "tool_call", name: "read", status: "completed" }
{ type: "done",  stopReason: "end_turn", tokens: {...} }
{ type: "error", message: "auth required ..." }
```

## 六、对话流程（以 chat stream 为例）

```
1. CLI/GUI 发 RPC: agent.chat.stream({ task: "local/abc", message: "帮我重构" })

2. 读 task AGENTS.md frontmatter:
   → agent_provider: "opencode"
   → agent_model: "deepseek/deepseek-chat"
   → agent_session: null | "ses_xxx"
   → subject: "~/work"

3. 找/建 instance:
   → AgentManager.instanceForSubject("~/work")
   → 有 → 复用
   → 无 → spawn("opencode", ["acp"])  ← cwd = subject 路径

4. 找/建 session:
   → agent_session 存在 → session/resume
   → 不存在 → session/new
   → sessionId 写回 frontmatter

5. 发送消息:
   → session.prompt("帮我重构")
   → yield chunks (text / tool_call / done / error)

6. 流式接收:
   → 逐条 yield 到 serverStream
```

## 七、Session 持久化

绑定关系记录在 task 的 `AGENTS.md` frontmatter 中：

```yaml
---
title: "重构 api 层"
state: active
subject: "~/work"
agent_provider: "opencode"
agent_model: "deepseek/deepseek-chat"
agent_session: "ses_abc123"
---
```

- `agent_provider` + `agent_model`：创建 session 时写入，后续复用
- `agent_session`：session/new 返回后写入；下次对话直接 session/resume
- session/close 时清除 `agent_session`，保留 provider 和 model
- resume 失败（session 过期、agent 重启丢失）→ 降级到 session/new

## 八、进程生命周期

| 事件 | 行为 |
|------|------|
| 启动 | **惰性启动**：首次 `chat.send` / `chat.stream` / `instance.start` 时 spawn |
| 回收 | **不自动回收**：用户通过 `instance stop <id>` 手动关闭 |
| 崩溃 | 检测到进程退出 → 标记 instance 为 error → 下次请求自动重 spawn |
| 并发 | 同一 session 串行（ACP 规范要求），不同 session 可并发 |
| 日志 | stderr → `~/.diy/logs/acp-opencode.log` |

状态机：`stopped → starting → running ↔ crashed → stopping → stopped`

## 九、模型切换

opencode 不支持 `session/set_model`。切换方式：

1. 用户执行 `diy2 agent model set <model> --task <uri>`
2. 写入 task frontmatter → `agent_model: "new-model"`
3. 下次 spawn（instance 重启或新 instance）时注入环境变量：

```
OPENCODE_CONFIG_CONTENT={ "model": "new-model" }
```

4. 已有活跃 session → 不受影响，下次对话时新建 session 生效

## 十、OpenCodeProvider 实现要点

依托 `@agentclientprotocol/sdk`：

```ts
import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";

class OpenCodeProvider implements AgentProvider {
  private proc: ChildProcess | null = null;
  private ctx: ClientContext | null = null;

  async start(subject: string): Promise<void> {
    this.proc = spawn("opencode", ["acp"], {
      cwd: subject,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: this.model }),
      },
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(this.proc.stdin!),
      Readable.toWeb(this.proc.stdout!)
    );

    this.ctx = await acp
      .client({ name: "diy2" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => ({
        outcome: { outcome: "selected", optionId: ctx.params.options[0]!.optionId }
      }))
      .connectWith(stream, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        });
        return ctx;
      });
  }
}
```

权限策略：开发环境全部自动允许（`onRequest` 直接返回第一个 option），后续可选 GUI 弹窗。

## 十一、opencode 能力矩阵

| 能力 | 支持 | 处理 |
|------|------|------|
| `initialize` | ✅ | — |
| `session/new` | ✅ | — |
| `session/load` | ✅ | — |
| `session/resume` | ✅ | task 恢复用 |
| `session/fork` | ✅ | — |
| `session/list` | ✅ | — |
| `session/close` | ✅ | — |
| `session/stop` | ❌ | `session/cancel` notification 替代 |
| `session/set_model` | ❌ | 通过 `OPENCODE_CONFIG_CONTENT` 环境变量在 spawn 时切换 |

## 十二、内部模块

```
pkgs/diy-desktop2/src/main/services/
  agent-manager.ts             # AgentManager: providers + instances + sessions 映射
  agent-provider.ts            # AgentProvider 接口 + SessionHandle 接口
  agent-provider-opencode.ts   # OpenCodeProvider (implements AgentProvider)
  agent-session.ts             # OpenCodeSession: 包装 ACP session 的 prompt/cancel/close
```

`api.ts` 的 `agent` router → `AgentManager` → `AgentProvider` → `@agentclientprotocol/sdk`

## 十三、待清理代码

对接前需清理当前 `acp-agent.ts` — 这是早期错误的 Ollama HTTP REST 客户端实现（`POST /v1/chat/completions`），不是真正的 ACP。替换为基于 `@agentclientprotocol/sdk` 的 `agent-provider-opencode.ts`。
