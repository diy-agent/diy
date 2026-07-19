# 迁移计划重新评估（2026-07-11）

**评估对象**: 4 份计划文档 vs 当前实际代码
**代码基线**: `pkgs.ts/diy.ts/pkgs/diy-desktop2/` + `diy-rpc/` + `rpc-transport/` + `rpc-transport-electron/`

---

## 一、各计划准确性总览

| 计划 | 日期 | 准确性 | 状态 |
|------|------|--------|------|
| `2026-07-02-electron-rewrite.md` | 07-02 | ⚠️ 严重过时 | 架构已翻天覆地，建议归档 |
| `2026-07-04-electron-rewrite-review.md` | 07-04 (更新 07-10) | ⚠️ 部分过时 | 核心判断正确，但 ref/LLM 状态标注错误 |
| `2026-07-10-ref-rewrite.md` | 07-10 | ✅ 基本准确 | 设计匹配实现，仅细节有偏差 |
| `2026-07-10-acp-research.md` | 07-10 | ✅ 准确但未实施 | 研究正确，代码尚未按此实现 |

---

## 二、逐计划详细比对

### 2.1 `2026-07-02-electron-rewrite.md` — ❌ 严重过时

这是最早的 Electron 重写计划，其描述的架构（command/defs + 三套适配器）已被完全取代。**不应再作为参考**。

| 计划内容 | 实际 |
|----------|------|
| 包名 `diy-desktop` | `diy-desktop2` |
| React 18 + TailwindCSS 3 (Material3) | React 19 + TailwindCSS 4 + shadcn/ui + lucide-react |
| `command/defs/*.ts` + `command/types.ts` / `define.ts` / `schema.ts` / `registry.ts` (Phase 1B) | **全部删除**。命令定义已融入 `api.ts` 的 `rpc.unary()` / `rpc.serverStream()` |
| `adapters/cli-runner.ts` — commander 适配 | `src/cli/index.ts` — `CliApp` + 内存 Transport 降级 |
| `adapters/rpc-server.ts` — Unix socket | `src/main/services/rpc-port.ts` — HTTP/2 (fastify) |
| `adapters/ipc-handlers.ts` | `main/index.ts` — `createMainTransport` + `createHandler` |
| 文件结构 `electron/core/`, `electron/command/`, `electron/adapters/` | `src/main/core/`, `src/main/services/` |
| RPC: `net.Server` Unix socket | `@diy/rpc-transport` HTTP/2 |
| ACP: 计划中的 Phase 3 服务层 | `acp-agent.ts` 存在但**不是真正的 ACP 客户端**（是 Ollama REST API 包装） |
| `diy llm` 延期 | 已通过 `api.ts` 的 `agent` router 实现基础功能 |
| `diy ref` 系统 0 行 | **已完整实现** (~1000 行)：`ref.ts` + `ref-project.ts` + `ref-sync.ts` + `ref-config.ts` |
| 依赖: commander, js-yaml, chokidar, fastify | commander 已废弃（用 CliApp）；新增 zod v4, lucide-react, shadcn, oxlint/oxfmt, ws, @base-ui/react, class-variance-authority, tailwind-merge |

**建议**: 归档此文档，用 `README.md` 或最新 review 替代。

---

### 2.2 `2026-07-04-electron-rewrite-review.md` — ⚠️ 部分过时

核心架构描述（Step 1 完成状态）是准确的，但代码量统计和模块状态有误。

#### 准确的部分 ✅

- Step 1 删除的旧代码列表正确
- 新增的 `api.ts` router、`CliApp`、`rpc-port.ts`、`@diy/rpc` RouteNode 树描述正确
- 架构现状图（`api.ts → main/index.ts → createHandler`）正确
- `transport-builtin.ts` 合并了 memory transport 正确

#### 不准确的部分 ❌

**1. 代码量统计严重失实**

| 层级 | 计划标注 | 实际（粗略计数） | 偏差 |
|------|---------|-----------------|------|
| RPC 库 | ~1,600（3 包） | ~1,600 ✅ | — |
| Core | ~800 | ~1,400 | 少估 600L |
| CLI + API | ~370（api.ts） | ~470 | 少估 100L |
| App/GUI | ~1,100 | ~1,500 | 少估 400L |
| Agent | ~120 | ~120 ✅ | — |
| LLM CLI | **0** (❌) | 已有 agent router 集成 | **错标为 0** |
| Ref 系统 | **0** (❌) | **~1,000** | **完全错标** |
| 总计 | ~4,000 | ~6,200 | 少估 ~55% |

**2. 模块状态误标**

```
计划说:    Ref 系统    — 0 行, 0%
实际:      ref.ts (200L), ref-project.ts (300L), ref-sync.ts (360L), ref-config.ts (140L)
           api.ts 中已注册 ref router (5 个 procedure)

计划说:    LLM CLI    — 0 行, 0%
实际:      api.ts 中 agent router: chat, chatStream, listModels, status (4 个 procedure)
           + acp-agent.ts (120L Ollama 客户端)
           + llm-proxy.ts
           LLM 功能 CLI 上可用 (diy2 agent chat 等)
```

**3. 文件路径模式不统一**

计划用的路径模式 `diy-desktop2/src/main/` 实际上源文件在 `src/main/`（包内不用包名做前缀）。但这不是错误，只是表述差异。

**4. 剩余工作标注失准**

- Step 3 "diy ref 完全未移植" → 实际已完整实现
- Step 3 "diy llm 完全未移植" → agent router 已可用

**建议**: 更新代码量统计和模块状态。

---

### 2.3 `2026-07-10-ref-rewrite.md` — ✅ 基本准确

设计决策完全匹配实现。仅以下细节有偏差：

#### 准确匹配 ✅

| 设计决策 | 代码实现 |
|----------|---------|
| 三级项目边界检测（lock file → diy.yaml → 报错） | `ref-project.ts:findProjectRoot()` ✅ |
| lock 文件驱动（uv.lock / package-lock.json） | ✅ |
| diy.yaml 是纯 ref 配置，不作为项目边界 | ✅ |
| workspace 解析（monorepo 检测） | `resolvePythonWorkspaces()` / `resolveNodeWorkspaces()` ✅ |
| TOML 极简解析器（`[project] name` + `[tool.uv.workspace] members`） | ✅ |
| scope 检测 (`detectCurrentScope`) | ✅ |
| diy.yaml include/exclude 过滤 | `loadRefConfig()` + `matchFilter()` ✅ |
| git URL 解析：内置映射 → npm view → PyPI JSON API | `KNOWN_REPOS` → `resolveNpmRepo()` → `resolvePypiRepo()` ✅ |
| 并发 clone (默认 4) | `syncRefs()` with chunked concurrency ✅ |
| ref.lock.yaml v5 格式 | `writeLockFile()` ✅ |
| api.ts ref router (sync/list/status/add/remove) | 5 个 procedure ✅ |
| CommandDef 废弃，用 api.ts router 替代 | ✅ |
| `_collect_sources_from_all_boundaries()` 删除 | 不存在于新代码 ✅ |

#### 细微偏差 ⚠️

**1. 代码量估算偏低**

| 模块 | 计划估计 | 实际 |
|------|---------|------|
| `core/ref-project.ts` | ~80L | ~300L |
| `core/ref.ts` | ~100L | ~200L |
| `services/ref-sync.ts` | ~150L | ~360L |
| `services/ref-config.ts` | ~60L | ~140L |
| **总计** | **~570L** | **~1,000L** |

实际多了约 430 行，主要因为：
- TOML 解析器比预期复杂（200+ 行含类型解析）
- glob 展开、workspace info 构建、pyproject.toml 读取等 ~100L
- `KNOWN_REPOS` 内置映射表 ~90 行
- 错误处理、日志、路径规范化等 ~100L

**2. ref.lock.yaml 顶层 key**

```
计划:  refs:          ← 旧名
代码:  ref:           ← 新名（有 refs 兼容读取）
```

代码实现了 `normalizeLockData()` 做向后兼容，计划未提及此实现细节。

**3. source 部分的 key 格式**

```
计划:    TanStack/router: ~/.diy/ref/github.com/TanStack/router/main/
代码:    github.com/TanStack/router: ~/.diy/ref/github.com/TanStack/router/main/
```

代码使用 `host/owner/repo` 作为 key，计划中的示例是 `owner/repo`（不含 host）。

**4. diy.yaml 查找逻辑**

计划表述为"从项目根向上查，取第一个 diy.yaml"，代码实现在 `loadRefConfig()` 中有更细致的逻辑：先查 cwd 子项目目录，再查项目根，再向上（情况 A 的补充）。

**5. 缺少 source scope 标记**

计划说 `source 也按 scope 分组`，代码中 source 写入时会用 `dep.scope`（即宿主项目的 workspace name）分组，与计划一致但不明显。

---

### 2.4 `2026-07-10-acp-research.md` — ✅ 研究准确，代码未实施

#### 准确的 ✅

- Protocol v1 的 API 描述基于 agentclientprotocol.com 和 GitHub registry 验证
- 能力探测与降级策略设计合理
- Session 持久化方案（task AGENTS.md frontmatter）合理
- 不用 `@agentclientprotocol/sdk` npm 包的决策有道理

#### 矛盾 ⚠️

**`@agentclientprotocol/sdk` 已在 dependencies 中**

```
package.json:  "@agentclientprotocol/sdk": "^1.2.1"
计划说:        不用此包，自建 ~150 行
```

实际：包已安装但未被 `acp-agent.ts` 使用（acp-agent.ts 是纯 Ollama HTTP 客户端）。这可能是安装其他依赖时顺带引入的，或者是提前为未来使用做准备。

#### 实施状态 ❌

| 计划步骤 | 状态 |
|----------|------|
| Step 2a: ACP 基础设施 (AcpClient + spawn + NDJSON + initialize) | **未实施** |
| Step 2b: 集成到 diy-desktop2 (替换 acp-agent.ts) | **未实施** |
| Step 2c: 端到端测试 (Hermes + 1 个 Registry agent) | **未实施** |

当前 `acp-agent.ts` 实际是一个 **Ollama 兼容的 HTTP REST 客户端**（`/v1/chat/completions`），与 ACP 协议（stdio + JSON-RPC + session/new + session/update 流）完全不同。

当前架构：
```
api.ts agent.chatStream
  → acp-agent.ts AcpAgentClient.streamChat()
      → POST http://localhost:11434/v1/chat/completions (SSE stream)
```

计划架构：
```
api.ts agent.chatStream
  → acp-agent.ts AcpClient
      → spawn("hermes acp") → NDJSON stdin/stdout
      → initialize → session/new → session/prompt
      → session/update 回调 → yield chunks
```

---

## 三、实际代码结构（2026-07-11 现状）

```
pkgs.ts/diy.ts/pkgs/
├── diy-desktop2/
│   ├── package.json              # React 19, TailwindCSS 4, shadcn/ui
│   ├── src/
│   │   ├── cli/index.ts          # CliApp + 内存 Transport 降级
│   │   ├── main/
│   │   │   ├── index.ts          # Electron 主进程
│   │   │   ├── core/
│   │   │   │   ├── app-config.ts # AppConfig (diyHome/cache/userData 三路径)
│   │   │   │   ├── state.ts      # state.yaml + AGENTS.md + star
│   │   │   │   ├── task.ts       # 任务 CRUD + zod 校验
│   │   │   │   ├── task-tree.ts  # 磁盘任务树构建
│   │   │   │   ├── subject.ts    # subject 管理
│   │   │   │   ├── fs-lock.ts    # 文件锁
│   │   │   │   ├── ref.ts        # ref.lock.yaml 解析 + scope 过滤
│   │   │   │   └── ref-project.ts # 项目边界检测 + workspace 解析
│   │   │   ├── services/
│   │   │   │   ├── api.ts        # 单源真相 — 全部 procedure 定义
│   │   │   │   ├── rpc-port.ts   # HTTP/2 RPC 端口
│   │   │   │   ├── ui-bus.ts     # UI 事件推送
│   │   │   │   ├── acp-agent.ts  # Ollama HTTP 客户端（待重写为 ACP）
│   │   │   │   ├── llm-proxy.ts  # LLM 代理
│   │   │   │   ├── file-watcher.ts
│   │   │   │   ├── health.ts
│   │   │   │   ├── ref-sync.ts   # ref sync 引擎
│   │   │   │   └── ref-config.ts # diy.yaml 读写
│   │   │   ├── preload/index.ts
│   │   │   └── renderer/         # React 19 + shadcn/ui
│   │   │       ├── App.tsx
│   │   │       ├── components-diy/ (TaskTree, AgentChatPanel, LLmPage, LogPanel...)
│   │   │       ├── components/ui/  (shadcn 组件)
│   │   │       └── store/         (taskStore, agentStore, notificationStore)
│   │   └── serve/index.ts        # 静态服务（替代 Vite dev server）
│   └── tests/
│       ├── setup.ts              # DIY_HOME → /tmp 隔离
│       ├── helper.ts             # 测试辅助
│       ├── core/                 # state, task, task-tree, subject, fs-lock
│       ├── services/             # health
│       └── cli.intent.test.ts    # CLI 集成测试
├── diy-rpc/                      # @diy/rpc — 纯内核
│   └── src/
│       ├── transport/            # Client/Server/Transport/Envelope/AsyncQueue
│       └── rpc/
│           ├── index.ts          # rpc.unary / serverStream / router / createHandler
│           └── cli-rpc/          # CliApp / parseArgv / meta (.cliArg/.cliOption)
├── rpc-transport/                # @diy/rpc-transport — HTTP/2 + WebSocket
└── rpc-transport-electron/       # @diy/rpc-transport-electron — Electron IPC
```

---

## 四、实际代码量（2026-07-11 粗略统计）

| 模块 | 行数 |
|------|------|
| diy-rpc (transport + rpc + cli-rpc) | ~1,600 |
| rpc-transport (http2 + ws) | ~350 |
| rpc-transport-electron | ~120 |
| **RPC 库小计** | **~2,070** |
| core/state.ts | ~180 |
| core/task.ts | ~170 |
| core/task-tree.ts | ~180 |
| core/subject.ts | ~60 |
| core/fs-lock.ts | ~40 |
| core/app-config.ts | ~70 |
| core/ref.ts | ~200 |
| core/ref-project.ts | ~300 |
| **Core 小计** | **~1,200** |
| services/api.ts | ~300 |
| services/rpc-port.ts | ~60 |
| services/ui-bus.ts | ~25 |
| services/acp-agent.ts | ~120 |
| services/llm-proxy.ts | ~60 |
| services/file-watcher.ts | ~40 |
| services/health.ts | ~50 |
| services/ref-sync.ts | ~360 |
| services/ref-config.ts | ~140 |
| **Services 小计** | **~1,155** |
| renderer/** (React) | ~1,500 |
| cli/index.ts + serve/index.ts | ~100 |
| preload/index.ts | ~40 |
| main/index.ts | ~200 |
| **App 层小计** | **~1,840** |
| tests/** | ~500 |
| **总计** | **~6,765** |

---

## 五、建议行动

### 高优先级

1. **归档 `2026-07-02-electron-rewrite.md`** — 内容已被后续 plan 和实际代码完全覆盖
2. **更新 `2026-07-04-electron-rewrite-review.md`** — 修正 ref 系统、LLM CLI 的状态标注和代码量

### 中优先级

3. **`2026-07-10-ref-rewrite.md`** — 追加"实施完成"标记，更新代码量估算到 ~1,000L
4. **`2026-07-10-acp-research.md`** — 标注"待实施"，并注明当前 `acp-agent.ts` 是 Ollama 客户端而非 ACP
5. 决定 `@agentclientprotocol/sdk` 的去留 — 如果确定不用，从 `package.json` 移除

### 低优先级

6. 考虑添加一份 `README.md` 或 `STATUS.md` 在 `docs/plans/` 下，作为计划目录的索引（哪些已完成、哪些待办）
7. `diy.yaml` 中 `ref:` 的顶层 key 格式（`host/owner/repo` vs `owner/repo`）在代码和计划中统一

---

## 七、待确认问题（2026-07-14 评审）

### Q5: `@agentclientprotocol/sdk` 的去留决定？

本文 §2.4 指出了矛盾：`07-10-acp-research.md` 说不用 SDK，但 SDK 已在 `package.json`。实际两份文档在该问题上意见相反——本文认同"不用"的决策有道理，而 `07-11-acp-opencode-implementation.md` 却选择使用 SDK。

→ 需要明确决策：用还是不用？若用，从 `diy.yaml` 删除 ref 条目还是继续作为外部参考？

A: 用agentclientprotocol/sdk，不要自行实现，自行实现有什么意义呢

### Q6: 建议行动的执行状态？

本文列举了 7 条建议行动（归档/更新/标记/决定），目前哪些已执行、哪些未执行？

A: 你需要自行调查

**→ 调查（2026-07-14）：**

| # | 建议行动 | 状态 |
|---|---------|------|
| 1 | 归档 `2026-07-02-electron-rewrite.md` | ❌ 未执行（文件仍在原位，无 archive/ 目录） |
| 2 | 更新 `2026-07-04-electron-rewrite-review.md` | ❌ 未执行（07-10 时间戳后未再修改） |
| 3 | `2026-07-10-ref-rewrite.md` 追加"实施完成" | ❌ 未执行（无状态标记） |
| 4 | `2026-07-10-acp-research.md` 标注"待实施" | ❌ 未执行（文件无更新） |
| 5 | 决定 `@agentclientprotocol/sdk` 的去留 | ✅ 已决定：保留并使用 SDK（见 Q1/Q5 回答） |
| 6 | 添加 `README.md` 或 `STATUS.md` 在 `docs/plans/` | ❌ 未执行（`ls` 确认文件不存在） |
| 7 | 统一 `diy.yaml` 中 `ref:` key 格式 | ❌ 未调查 |
| — | **综合** | 5/7 项未执行 |

建议：至少执行 #1（归档旧计划）和 #4（标注 ACP 研究为待实施 + 注明 SDK 决策已推翻），其他可延后。

### Q7: 覆盖范围缺失

本文评估了 4 份旧计划，但自身也有一份同天的新计划 (`2026-07-11-acp-opencode-implementation.md`) 未纳入评估范围。若有后续版本，建议追加对实施计划的对照评估。

A: 请按照本需求重新评估如何实现，协议研究在 `pkgs.ts/agent-protocol`，diy 实现文档在 `docs/opencode/` + `docs/agent-abstraction-design.md`，继续研究或参考

**→ 重新评估（2026-07-14）：**

`agent-protocol/` 目录（commit `8e7cd4f`）包含 ~5000 行首次提交的研究，其中**三份文档直接决定了实施方向**：

---

### 关键发现：`opencode acp` 传输层是 stdio，不是 HTTP

| | `2026-07-11-acp-opencode-implementation.md` | `agent-protocol/` 研究结果 |
|------|------|------|
| ACP 传输 | `createHttpStream(url)` HTTP | `ndJsonStream(stdin, stdout)` stdio |
| opencode 参数 | `--port`, `--cwd` | `acp`（无参数即可，端口是内部后端） |
| 启动方式 | spawn + waitForReady(port) | spawn 即 ready，一行 `ndJsonStream` |
| Session 模型 | 单 session（`ctx.buildSession(cwd).withSession()`） | 多 session（一条连接多个 `session/new`） |

**结论：当前实施计划的架构假设是错的，必须修正。**

---

### 更好的实施蓝图：`agent-abstraction-design.md`

`agent-protocol/docs/agent-abstraction-design.md`（373L）已设计了一个完整的抽象层，比当前实施计划更成熟：

| 当前计划 | agent-abstraction-design 设计 |
|----------|------|
| 单文件 `acp-open.ts` | 三层：`AgentManager` → `AgentProvider` → `SessionHandle` |
| 只支持 opencode | 换 agent 只换 `AgentProvider` 实现 |
| api.ts 直接调 AcpService | api.ts 通过 `AgentManager` 间接调用 |
| 进程管理裸写在 service 里 | `AgentProvider` 接口定义生命周期状态机 |
| 无能力补丁 | `agents/patches` 字段处理 agent 差异（如 opencode 不支持 `session/set_model`） |

**建议：放弃当前 `acp-open.ts` 单文件方案，采用 `agent-abstraction-design.md` 的三层设计：**

```
新文件:
  src/main/services/agent-manager.ts          (~80L)  AgentManager + AgentProvider 接口
  src/main/services/agent-provider-opencode.ts (~150L) OpenCodeProvider implements AgentProvider
  src/main/services/agent-session.ts           (~60L)  SessionHandle + prompt 流

新 api.ts agent router:
  listAgents → agentManager.listProviders()
  listModels → provider.listModels()
  chatStream → agentManager.createSession() → session.prompt()
  listSessions → provider.listSessions()
  closeSession → provider.closeSession()
```

总计 ~290L 新代码，~30L api.ts 修改，~3.5h 估时。

---

### opencode 特定接入要点（来自 `opencode/integration-notes.md`）

1. **stdio 启动**：`spawn("opencode", ["acp"], { stdio: ["pipe", "pipe", "inherit"] })`
2. **模型切换**：opencode 不支持 ACP `session/set_model`，改用环境变量 `OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "..." })` 在启动时配置
3. **认证**：首次需 `terminal` auth method，token 缓存于 `~/.local/share/opencode/auth.json`
4. **能力矩阵**：init ✅, session/new ✅, resume ✅, fork ✅, list ✅, close ✅ — 完全满足基础需求
5. **权限**：全部默认允许（development），后续可选 GUI 弹窗

---

## 六、关键发现总结

```
✅ 已完成:
  - RPC 三层架构（Transport/Client+Server/Procedure+Router）
  - api.ts 单源真相 (15 procedure, 6 个顶级 router 组)
  - CliApp 自动 CLI 生成 + 内存 Transport 降级
  - HTTP/2 RPC 端口 + Electron IPC 传输
  - 完整 core 数据层 (state/task/task-tree/subject)
  - 完整 ref 系统（边界检测/scope/deps 收集/git clone/lock file）
  - React 19 + shadcn/ui GUI 基础框架
  - 测试隔离 + 意图测试

🚧 待完成 (按 ACP 计划):
  - ACP 客户端重写（当前是 Ollama REST，非 ACP 协议）
  - Agent session 持久化到 task frontmatter
  - 多 agent 支持

📋 已废弃:
  - commander-based CLI adapter
  - Unix socket RPC server
  - command/defs/ + CommandDef DSL
  - 旧 adapters/ 三件套 (cli-runner/rpc-server/rpc-client)
  - _collect_sources_from_all_boundaries() 递归扫描
```
