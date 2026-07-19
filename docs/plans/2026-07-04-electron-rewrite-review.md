# diy-desktop2 移植审查报告（2026-07-10 更新）

**审查对象**: `/Users/ccc/git/diy/diy-research/pkgs.ts/diy.ts/pkgs/diy-desktop2`

---

## Step 1 已完成：架构统一（2026-07-10）

### 删除的旧代码

| 删除 | 行数 | 替代 |
|------|------|------|
| `command/defs/*.ts` + `command/types.ts`/`define.ts`/`schema.ts`/`registry.ts` | ~650 | `api.ts` 嵌套 router |
| `adapters/cli-runner.ts` | ~130 | `CliApp` + 内存 Transport 本地降级 |
| `adapters/rpc-server.ts` | ~120 | `rpc-port.ts`（`Http2Transport` + `createHandler`） |
| `adapters/rpc-client.ts` | ~80 | `Client` + `connectHttp2Rpc` |
| `tests/command/task-def.test.ts` | ~60 | `cli.intent.test.ts` 覆盖 |

### 新增

| 新增 | 行数 | 说明 |
|------|------|------|
| `src/cli/index.ts` 重写 | ~80 | `CliApp` + 内存 Transport 降级 |
| `rpc-port.ts` | ~66 | HTTP/2 RPC 端口服务 |
| `@diy/rpc` RouteNode 树 | ~80 | `buildRouteTree`/`routeLeaves`/`routeResolve`/`routeWalk` |
| `@diy/rpc` `createMemTransportPair` | ~50 | 内存 Transport 对（本地降级） |
| `transport-builtin.ts` | ~65 | 合并 `transport-logger.ts` + `memory.ts` |

### 架构现状

```
api.ts (router — 嵌套: task/subject/ui/agent/llmProxy/log/doctor)
  ├── main/index.ts: createHandler → Electron IPC + HTTP/2 RPC Port
  ├── renderer/rpc.ts: Client 手动 invoke (跨进程约束)
  ├── cli/index.ts: CliApp → 优先远程, 降级内存 Transport
  └── zod 上挂 .cliArg()/.cliOption() → CliApp 自动解析/help
```

---

## 剩余工作

### Step 2: ACP Agent

**策略变更**：只对接 ACP 协议 (Protocol v1, `agentclientprotocol.com`)，不做 AgentBackend 抽象层。

详见 [`2026-07-10-acp-research.md`](./2026-07-10-acp-research.md)。

| 任务 | 说明 | 行数估计 |
|------|------|---------|
| AcpClient | spawn 子进程 + NDJSON + JSON-RPC | ~150 |
| AcpSession | session 生命周期 + prompt + cancel | ~100 |
| AcpCapabilities | initialize 握手 → 能力配置 | ~40 |
| `api.ts` 集成 | `agent.chatStream` 对接 ACP 流 | ~30 (修改) |
| Session 持久化 | sessionId → task AGENTS.md frontmatter | ~20 |
| **总计** | | **~340 行** |

### Step 3: 补余

| 模块 | 缺口 | 计划 |
|------|------|------|
| `diy ref` | 完全未移植 | 简化重写，详见 [`2026-07-10-ref-rewrite.md`](./2026-07-10-ref-rewrite.md) |
| `diy llm` | 完全未移植 | 延期

---

## 代码量

| 层级 | 当前 TS (LOC) | 覆盖率 vs Python |
|------|-------------|-----------------|
| RPC 库 | ~1,600（3 包） | 全新资产 |
| Core | ~800 | ~47% |
| CLI + API | ~370（api.ts） | 单源真相 |
| App/GUI | ~1,100 | ~13% |
| Agent | ~120（ACP client） | ~7.5% |
| LLM CLI | 0 | 0% |
| Ref 系统 | 0 | 0% |
| **总计** | **~4,000 (+ RPC lib)** | **~26%** |
