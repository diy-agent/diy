# OpenCode ACP 接入笔记

> opencode v1.17.18 | ACP Protocol v1 | CI validated: 2026-07-11
> 源码确认: 2026-07-11 (ssh clone → `packages/opencode/src/cli/cmd/acp.ts` + `src/acp/service.ts`)

## 关键发现：传输层

**opencode 的 ACP 传输使用 stdio（NDJSON over stdin/stdout），完全遵循 ACP 规范。**

### 双层架构

```
Client (diy2)                    opencode 子进程
    │                                │
    │── ACP (stdio/NDJSON) ────────→│  ndJsonStream(stdin, stdout)
    │                                │   └── AgentSideConnection
    │                                │       └── agent.create(conn)
    │                                │
    │                                ├── 内部 HTTP 后端 (随机端口)
    │                                │   └── opencode SDK API
    │                                │       └── 管理 session / model / provider
```

源码证据 (`acp.ts`)：

```ts
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"

// 1. 启动内部 HTTP 后端（opencode 自己的 SDK 用）
const server = Server.listen(opts)                   // --port 控制的是这个
const sdk = createOpencodeClient({                   // opencode SDK 连自己的后端
  baseUrl: `http://${server.hostname}:${server.port}`
})

// 2. ACP 通信：stdio（这才是对外的 ACP 传输）
const stream = ndJsonStream(input, output)            // stdin/stdout
const agent = ACP.init({ sdk })
new AgentSideConnection((conn) => agent.create(conn), stream)
```

**`--port` 是内部 HTTP 后端的端口，不是 ACP 端口。ACP 永远走 stdio。**

## CLI 命令

```bash
# ACP stdio 模式（内部后端随机端口）
opencode acp

# 指定内部后端端口 + 工作目录
opencode acp --port 0 --cwd /path/to/project

# 模型列表
opencode models [provider]
```

## ACP 能力矩阵 (CI 验证)

```
initialize:        ✅    protocolVersion: 1
session/new:       ✅
session/list:      ✅
session/fork:      ✅
session/resume:    ✅
session/stop:      ❌    method_not_found (-32601)
session/set_model: ❌    invalid_params (-32602)
```

| 能力 | 支持 |
|------|------|
| `loadSession` | ✅ |
| `sessionResume` | ✅ |
| `sessionFork` | ✅ |
| `sessionList` | ✅ |
| `sessionStop` | ❌ |
| `setModel` | ❌ (改用 `session/set_config_option` / `model` config option) |
| `authMethods` | `["terminal"]` |

## 模型切换

opencode 不支持 ACP `session/set_model`，但支持通过 **config options** 切换模型：

```ts
// ACP 方式：通过 set_config_option
ctx.request("session/set_config_option", {
  sessionId,
  configId: "model",
  value: "deepseek/deepseek-chat"
})
```

也可以在启动时通过环境变量预配置：

```ts
spawn("opencode", ["acp"], {
  env: {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: "deepseek/deepseek-chat"
    })
  }
})
```

| 环境变量 | 作用 |
|----------|------|
| `OPENCODE_CONFIG` | 配置文件路径 |
| `OPENCODE_CONFIG_CONTENT` | 内联 JSON 配置（不落盘） |

## diy2 集成架构 (修正版)

```ts
// ✅ 正确：stdio ACP，不需要端口管理
const proc = spawn("opencode", ["acp"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "deepseek/deepseek-chat" })
  }
});

const stream = ndJsonStream(
  Writable.toWeb(proc.stdin),
  Readable.toWeb(proc.stdout)
);

acp.client({ name: "diy2" })
  .onRequest("session/request_permission", autoAllow)
  .onNotification("session/update", (ctx) => {
    const u = ctx.params.update;
    if (u.sessionUpdate === "agent_message_chunk") {
      yield u.content.text;   // → RPC pipe → GUI
    }
  })
  .connectWith(stream, async (ctx) => {
    await ctx.request(methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
    return ctx.buildSession(cwd).withSession(async (session) => {
      session.prompt(userMessage);
      for (;;) {
        const msg = await session.nextUpdate();
        if (msg.kind === "stop") return msg.response;
        // update messages handled by onNotification above
      }
    });
  });
```

对比之前的错误方案：
| | ❌ 旧方案 (HTTP) | ✅ 新方案 (stdio) |
|------|---------|------|
| 传输 | `createHttpStream(url)` | `ndJsonStream(stdin, stdout)` |
| 端口管理 | 需要分配/就绪轮询/清理 | 不需要 |
| 进程管理 | spawn + 等待 HTTP ready | spawn 即 ready |
| ACP 规范 | 不符合（HTTP 还是草案） | **符合 SHOULD 要求** |

## 当前已配置 Provider

```
● DeepSeek        (api — deepseek/deepseek-chat)
● OpenCode Go     (api — opencode-go/*)
+ OpenCode free   (内置 — opencode/*)
```

## 可用模型 (20+)

```
opencode/big-pickle              (free)
opencode/deepseek-v4-flash-free  (free)
opencode-go/deepseek-v4-pro      (paid)
opencode-go/glm-5.2              (paid)
opencode-go/kimi-k2.7-code       (paid)
opencode-go/qwen3.7-max          (paid)
deepseek/deepseek-chat           (direct API)
...
```

## 注意事项

1. **ACP 传输是 stdio，不是 HTTP** — 之前的判断是错的，`--port` 是内部后端端口
2. **模型不进 ACP 的 session/new** — 通过 config option 或环境变量传入
3. **首次使用需认证** — terminal auth method，token 缓存在 `~/.local/share/opencode/auth.json`
4. **内部 HTTP 后端端口对 diy2 透明** — 不需要管理，opencode 自用
5. **内存占用约 200-500MB** — Bun 运行时 + LLM 上下文
