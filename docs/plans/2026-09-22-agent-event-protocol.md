# Agent 事件记录协议设计

> 状态：设计已收敛，尚未实现。
>
> 本文定义 diy agent 的持久化事件记录、实体事实、流式生命周期和溯源关系。它与模型可见的 context wire 不是同一个协议。
>
> 未发布阶段允许破坏性调整，不设计迁移链。

## 1. 目标

事件日志需要同时满足：

- 人可以直接阅读，单行尽量自描述；
- 能区分 diy 模块写入、外部来源和因果关系；
- 能表达一次性事件与流式事件；
- 能表达实体树、并发和交错更新；
- JSON 与 TypeScript/Zod 使用同一套结构；
- 插件暂不实现，但未来类型扩展不能污染 core 字段。

## 2. 核心结论

当前不再把 `start`、`stop`、`delta`、`patch` 当作实体行为。

```text
event  = 一条持久化记录
source = 哪个模块写出了这条记录
origin = 事实内容来自谁
entity = 事实依附的实体
frame  = 事件在一次流中的阶段
fact   = 实体实际发生了什么
cause  = 为什么发生，关联哪个上游事件
```

最终结构：

```text
Event
├── eventId
├── ts
├── source
├── origin?
├── entity
├── frame
├── fact
└── cause?
```

## 3. `action`、`op` 与 `fact`

### 3.1 `action` 不作为通用事件字段

`action` 更适合表示命令或意图：

```text
tool.call
context.place
instruction.load
```

持久化日志关心的是已经发生的事实，因此使用过去式或事实型名称：

```text
tool.requested
tool.started
tool.output
tool.completed
context.replaced
instruction.loaded
```

### 3.2 `start/stop` 属于 frame

```text
start / stop / 中间数据
```

只说明流生命周期，不说明实体的业务事实。因此替换为：

```text
frame.mode:  unary | stream
frame.phase: single | begin | data | end | abort
```

```text
unary  + single              一次性完整记录
stream + begin/data/end      流式记录
stream + abort               流被中断
```

`fact.type` 才是实体事实类型；`frame.phase` 只是传输阶段。

### 3.3 不再使用顶层 `op`

旧协议：

```text
start | delta | patch | stop
```

目标协议：

```text
frame.phase + fact.type + fact.data
```

例如：

```json
{
  "frame": {"mode": "stream", "phase": "data", "seq": 3},
  "fact": {
    "type": "output",
    "data": {"text": "a.txt\\n"}
  }
}
```

不再需要 `delta_content`。`phase=data` 已经表示这是流中的一段数据。

## 4. 公共事件结构

```ts
interface EventRecord {
  eventId: string
  ts: string
  source: string
  origin?: Origin
  entity: EntityRef
  frame: Frame
  fact: Fact
  cause?: CauseRef
}

interface EntityRef {
  type: string
  id: string
  /** 仅在实体首次出现时提供；表示实体树中的结构父节点。 */
  parent?: string
}

interface Frame {
  mode: "unary" | "stream"
  phase: "single" | "begin" | "data" | "end" | "abort"
  /** stream 内顺序；unary 可省略。 */
  seq?: number
}

interface CauseRef {
  eventId: string
  relation: string
}
```

所有事件都带 `source`、`entity.type`、`entity.id`、`frame` 和 `fact.type`，保证单行可读。`parent` 只在实体第一次声明时出现，后续事件通过实体 id 引用已有实体。

## 5. `type + data`：统一的判别结构

采用：

```json
{"type":"output","data":{"text":"a.txt\\n"}}
```

不采用：

```json
{"type":"output","output":{"text":"a.txt\\n"}}
```

原因：插件或未来类型未知时，类型名不应成为公共对象的动态字段，避免与 core 公共字段碰撞。

统一规则：

```text
type       判别字段
data       当前类型的专属数据
其他字段   只放经过协议定义的公共字段
```

例如：

```json
{
  "fact": {
    "type": "output",
    "status": "partial",
    "data": {"text": "a.txt\\n"}
  }
}
```

其中 `status` 是公共事实元数据，`data.text` 是 output 专属字段。`data` 不是把所有字段混装进去的通用 body。

### 5.1 不需要 TypeScript 泛型

使用普通判别联合即可：

```ts
interface LlmOrigin {
  type: "llm"
  data: {
    provider: string
    model: string
    requestId?: string
  }
}

interface UserOrigin {
  type: "user"
  data: {
    channel?: string
  }
}

interface ProcessOrigin {
  type: "process"
  data: {
    name: string
    pid?: number
  }
}

type Origin = LlmOrigin | UserOrigin | ProcessOrigin
```

Fact 同样使用显式联合：

```ts
interface OutputFact {
  type: "output"
  data: { text: string }
}

interface CompletedFact {
  type: "completed"
  data: { status: "ok" | "error" }
}

type Fact = OutputFact | CompletedFact
```

如果多个变体确实共享字段，用普通接口继承：

```ts
interface FactCommon {
  observedAt?: string
}

interface OutputFact extends FactCommon {
  type: "output"
  data: { text: string }
}
```

泛型只是减少重复的可选工具，不是协议必需品。运行时仍需 Zod 或其他 schema 校验，因为 TypeScript 类型会擦除。

## 6. source、origin、cause

### 6.1 source：日志生产模块

`source` 表示哪个 diy 模块实际写出了这条事件：

```text
diy.ui
diy.agent.transport
diy.tool-runner
diy.prompt
```

它不是 LLM，也不是用户。source 由宿主代码确定，不能由 LLM 输出或工具参数填写。

插件命名暂不设计；未来如有实际场景，再增加稳定的插件 source 命名空间。

### 6.2 origin：事实内容的来源

`origin` 使用与 fact 相同的 `type + data` 结构：

```json
{
  "origin": {
    "type": "llm",
    "data": {
      "provider": "zen.go",
      "model": "gpt-5.6-luna"
    }
  }
}
```

其他来源：

```json
{"origin":{"type":"user","data":{"channel":"desktop-ui"}}}
{"origin":{"type":"process","data":{"name":"bash","pid":1234}}}
{"origin":{"type":"application","data":{"module":"prompt-registry"}}}
```

### 6.3 cause：因果关系

```text
source = 谁写日志
origin = 内容来自谁
cause  = 为什么发生
```

例如，LLM response 触发工具请求：

```json
{
  "source": "diy.agent.transport",
  "origin": {
    "type": "llm",
    "data": {"provider": "zen.go", "model": "gpt-5.6-luna"}
  },
  "entity": {
    "type": "tool",
    "id": "session/1/turn/1/step/1/tool/1",
    "parent": "session/1/turn/1/step/1"
  },
  "frame": {"mode": "unary", "phase": "single"},
  "fact": {
    "type": "requested",
    "data": {
      "callId": "call_abc",
      "name": "bash",
      "args": {"cmd": "ls"}
    }
  },
  "cause": {
    "eventId": "session/1/event/12",
    "relation": "response-to"
  }
}
```

### 6.4 parent 与 cause 不可混用

```text
entity.parent = 实体树的结构关系
cause.eventId  = 事件之间的因果关系
```

因此系统同时存在：

```text
实体关系：树
事件关系：有向图
日志存储：线性追加序列
```

这支持多个工具并发执行、事件交错和独立回放。

## 7. id 规则

实体 id 使用 session 局部、可读的层级路径：

```text
session/1
session/1/turn/1
session/1/turn/1/step/1
session/1/turn/1/step/1/text/1
session/1/turn/1/step/1/tool/1
session/1/context/env.os
```

事件 id 与实体 id 分离：

```text
eventId:  session/1/event/42
entityId: session/1/turn/1/step/1/tool/1
```

原因：

- 实体 id 表示持续存在的实体；
- event id 表示一条具体日志记录；
- 同一个实体可以产生多条事件；
- 便于按实体回放和按事件追踪。

当前只定义 diy core 的 session 局部 id，不提前设计插件 id 分配协议。

工具服务商提供的 `callId` 保留在 fact.data 中，不直接作为实体 id：

```json
{
  "fact": {
    "type": "requested",
    "data": {
      "callId": "call_abc",
      "name": "bash"
    }
  }
}
```

## 8. 实体与事实类型

### 8.1 用户消息

用户消息是一次性事实，不拆成 start/delta/stop：

```json
{
  "eventId": "session/1/event/1",
  "source": "diy.ui",
  "origin": {
    "type": "user",
    "data": {"channel": "desktop-ui"}
  },
  "entity": {
    "type": "message",
    "id": "session/1/turn/1/message/1",
    "parent": "session/1/turn/1"
  },
  "frame": {"mode": "unary", "phase": "single"},
  "fact": {
    "type": "submitted",
    "data": {"role": "user", "content": "看看目录"}
  }
}
```

发送失败不删除这条事实：用户确实提交过消息，只是后续没有 assistant 事件。

### 8.2 助手文本与 think

```text
entity.type = text / think
frame.mode  = stream
fact.type   = content / completed / failed
```

流式片段：

```json
{
  "source": "diy.agent.transport",
  "origin": {
    "type": "llm",
    "data": {"provider": "zen.go", "model": "gpt-5.6-luna"}
  },
  "entity": {"type": "text", "id": "session/1/turn/1/step/1/text/1"},
  "frame": {"mode": "stream", "phase": "data", "seq": 3},
  "fact": {
    "type": "content",
    "data": {"text": "我看看"}
  }
}
```

### 8.3 工具

工具统一使用：

```text
entity.type = tool
fact.data.name = bash / read / ...
```

不使用：

```text
kind: tool.bash
kind: tool.read
```

也不为每个工具建立第二层实体类型。工具名称是开放的业务值，工具参数由工具自身 schema 定义：

```json
{
  "fact": {
    "type": "requested",
    "data": {
      "callId": "call_abc",
      "name": "read",
      "args": {"path": "README.md"}
    }
  }
}
```

工具输出可以是流式事实：

```json
{
  "frame": {"mode": "stream", "phase": "data", "seq": 1},
  "fact": {
    "type": "output",
    "data": {"text": "a.txt\\n"}
  }
}
```

### 8.4 context 与 decision

```text
entity.type = context
fact.type   = replaced / patched / snapshot / removed
```

```text
entity.type = decision
fact.type   = made
```

例：

```json
{
  "source": "diy.prompt",
  "origin": {
    "type": "application",
    "data": {"module": "prompt-registry"}
  },
  "entity": {
    "type": "context",
    "id": "session/1/context/env.os"
  },
  "frame": {"mode": "unary", "phase": "single"},
  "fact": {
    "type": "replaced",
    "data": {
      "path": "env.os",
      "content": "soft:\\n  - playwright-cli\\n",
      "schema": 2
    }
  }
}
```

## 9. context 与 prompt cache 的关系

事件日志和模型 wire 分层：

```text
ops/event log       记录事实、来源、因果和实体变化
Context Tree        唯一的上下文状态
model wire          将 Context Tree 投影为 system/runtime 消息
```

Context Tree 设计：

```text
Context Tree
├── places           割点集合，唯一 placement 配置
├── system 容器      每次请求全量重建
└── runtime 容器     增量 patch，定期 snapshot
```

规则：

- `places` 两两不可互为祖先/后代；
- system 不进入消息历史，因此不需要补丁；
- runtime 使用路径级 patch；
- compaction、会话恢复、patch 超阈值、placement 迁移、wire 版本升级、用户手动操作时发全量 snapshot；
- snapshot 使用 `supersedes: all`；
- Context Tree 是唯一状态，不维护事实树和投影树两套状态；
- 变化按 step 最终 hash 比较，中途改动后恢复原值视为未变化；
- YAML 用于变量节点渲染，模板负责稳定自然语言 framing。

wire 版本由编码语义派生：

```text
WIRE_VERSION = sha256(canonical(WIRE_ENCODING)).slice(0, 8)
```

ops 中的 context fact 是审计和恢复依据；它不等同于直接发给模型的 context wire。

## 10. 持久化与回放

事件文件仍是 append-only JSONL。回放器负责：

```text
JSONL → EventRecord → 实体树/事件索引 → blocks/messages/context projection
```

单次事件：

```text
frame.mode=unary, phase=single
```

流式事件：

```text
begin → data × N → end
```

异常中断：

```text
begin → data × N，没有 end
```

未闭合流不能被假设为完整事实。各实体定义自己的中断策略；context 未闭合时不投影，并标记需要 rebaseline。已有历史中没有有效 context 事件时，首次打开自动生成 baseline。

UI 默认折叠 context 和 decision 事件；工具、文本和 think 按实体树展示。

## 11. dsh 的借鉴边界

dsh 的事件名采用命名空间形式：

```text
agent/request
tools/execute
system-prompt/assemble
```

其 scope 主要用于：

```text
注册隔离、作用域继承、事件路由
```

不是完整的持久化 provenance 字段。

diy 借鉴：

- source 使用稳定命名空间，例如 `diy.agent.transport`；
- fact type 使用明确的领域事实名称；
- entity parent 与 cause 分离；
- 不引入 dsh 的 Cordis、projection 或插件运行时架构。

## 12. 旧协议到目标协议的映射

| 旧协议 | 目标协议 |
|---|---|
| `start` | `frame.phase = begin`，同时声明实体 |
| `delta` | `frame.phase = data` + 对应 `fact.type` |
| `patch` | `frame.phase = data` + 具体事实类型，例如 `status-changed` |
| `stop` | `frame.phase = end` |
| user 三段消息 | `unary + single` 的 `message.submitted` |
| `meta` | source/origin/entity/frame/fact 的结构字段 |
| `fields` | `fact.data` |
| `kind` | `entity.type` |
| `parent` | `entity.parent`，只在实体首次声明时出现 |

未发布阶段可以直接切换，不保留旧格式迁移兼容。

## 13. 实现顺序

### P0：先建立纯观测和验证

- 定义 `EventRecord`、`Origin`、`Fact`、`Frame` TypeScript 类型；
- 定义 Zod runtime schema；
- eventId/entityId 分离；
- 记录 source、origin、cause、frame、fact；
- 补充 replay 和并发交错测试；
- 记录 cached input、reasoning、output usage 和 hash。

### P1：Context Tree 与容器

- Context Tree 唯一状态；
- places placement policy；
- system/runtime 两个容器；
- runtime snapshot 持久化；
- 老会话无有效 context 时自动 baseline。

### P2：路径级 runtime patch

- append/set 不再作为顶层 op；
- 由具体 fact 类型和 `fact.data` 表达实体事实；
- patch 与 snapshot 由 context projection 负责。

### P3：Prompt Lab

- 用树形展示实体和 placement；
- 手动切换 system/runtime/auto/hidden；
- 显示 source、origin、cause 和事实类型。

### P4：自动 placement

暂缓。未来若实现，需要阈值、滞后和冷却机制；安全规则/system 资格不能被自动迁移。

## 14. 当前不做

- 不提前设计插件 id 分配协议；
- 不把 dsh 作为 runtime 依赖；
- 不实现 in-history system，直到真实验证 `gpt-5.6-luna + zen.go + AI SDK` 的能力；
- 不把 `action`、`op`、`start/stop` 混为实体事实；
- 不为每个工具建立 `tool.bash`、`tool.read` 等新的 entity kind；
- 不使用 TypeScript 泛型作为公共协议必要条件；
- 不创建通用 `body` 杂货袋；
- 不为插件预留尚未确定的字段或生命周期。

## 15. 历史兼容：事件日志与 LLM 历史分离

老数据不能因为协议升级而失效；同时不迁移、不重写旧 JSONL。这里要分开处理两类权威数据，并把一种可选观测数据单独看待：

```text
ops 事件事实日志    UI、审计、回放、状态投影的权威
llm 消息历史        续聊时构造下一次请求的权威
raw 请求观测        旁路 HTTP/stream 快照，仅用于调试观测，可选
```

这不是要求必须有三个持久化文件，而是三种不同用途。UI 不应直接把 LLM 消息日志当作事件日志，LLM 也不应直接依赖 UI 展示模型。

### 15.1 两条独立的投影链

```text
旧事件 JSONL ── LegacyDecoder ──┐
                                 ├─ CanonicalEventView ── UI
新事件 JSONL ── V2Decoder ───────┘                  └─ LLM history projection

llm.jsonl（ModelMessage 历史） ──────────────── 续聊消息来源
raw.jsonl（可选 request/stream 快照） ─────────── 调试观测
```

`CanonicalEventView` 只存在于内存，是兼容层的统一读取模型，不要求把旧文件转换成新格式。

- UI 以事件日志为主要事实源；
- LLM history projection 从事件事实投影消息历史；
- `llm.jsonl` 保存续聊所需的 `ModelMessage[]`，是消息历史来源，不作为 UI 事件树的唯一来源；
- `raw.jsonl` 可选保存实际 request（system/messages/tools/settings）和 stream parts，仅用于缓存、provider 转换和中断问题观测；它不参与 UI、续聊或状态恢复；
- 旧日志缺少 `source`、`origin`、`frame` 等新字段时，适配器补 `unknown/legacy`，不能伪造真实来源。

### 15.2 版本分层

`raw.jsonl` 是临时观测产物，不属于业务协议，不提供稳定格式兼容保证；未来可以由 OTel 或其他 telemetry 替代、删除或改变格式。

以下业务版本不能混为一个版本号：

```text
eventSchemaVersion  事件 JSONL 的存储结构
historyFormat       LLM messages 的投影/传输结构
contextWireVersion  Context Tree runtime patch/snapshot 编码
```

例如 context wire 版本不匹配时，只需要忽略旧 runtime context、标记需要 rebaseline；不影响 UI 展示旧事件，也不需要迁移旧日志。

新会话可以在首条 session 记录或 manifest 中声明版本。没有版本头的旧文件按 legacy v1 读取：

```text
无版本头 → legacy decoder
新 session → 明确 eventSchemaVersion
```

不向旧文件头部补写版本，因为这仍然属于修改历史数据。

### 15.3 什么时候开启新 session

不是所有版本变化都需要新 session：

| 变化 | 处理 |
|---|---|
| 新增可选字段 | 原 session 继续，旧 reader 默认缺省 |
| 新增 fact type | 原 session 继续，未知类型用 generic renderer |
| 仅 UI 展示变化 | 原 session 继续 |
| 可由 adapter 无损读取的结构变化 | 原 session 继续 |
| 事件语义、合并规则或 message projection 不兼容 | 关闭旧 session，开启新 session |
| LLM message/provider 格式不兼容 | 开启新 session，建立 continuation bridge |

不兼容升级时：

```text
旧 session：可读、可展示、只读
新 session：负责继续对话和写入新格式
```

新 session 通过关系引用旧 session，不复制旧事件：

```json
{
  "eventId": "session/2/event/1",
  "ts": "2026-09-22T12:00:00.000Z",
  "source": "diy.agent",
  "entity": {
    "type": "session",
    "id": "session/2"
  },
  "frame": {
    "mode": "unary",
    "phase": "single"
  },
  "fact": {
    "type": "continued-from",
    "data": {
      "sessionId": "session/1"
    }
  }
}
```

若旧消息格式仍被当前 provider 接受，新 session 可以只读引用旧消息作为请求历史；若不兼容，则用一次性 summary/baseline bridge 建立新历史。两种情况下都不改写 `session/1`。

UI 不应静默切换。用户看到旧会话时仍能正常阅读；点击“继续”时明确创建 `session/2`，并显示 `continued-from session/1`。

### 15.4 LegacyDecoder 的注意事项

适配旧 `start/delta/patch/stop` 时：

```text
旧 start       → frame.begin
旧 delta       → frame.data + 对应 fact
旧 patch       → frame.data + 状态/字段事实
旧 stop        → frame.end
```

适配器必须：

- 保留旧实体 id，不重新编号；
- 用 session 作用域隔离短 id；
- 对缺失字段使用 `legacy` / `unknown`，不猜测来源；
- 对未闭合块显示“中断/未完成”，不静默丢弃；
- 对无法理解的 fact 保留原始 JSON，并使用 generic renderer；
- 将兼容损失标记为内部 view metadata，不回写旧日志。

### 15.5 推荐策略

```text
1. 旧数据永不迁移、永不重写；
2. reader 按版本分派，统一投影到内存 CanonicalEventView；
3. UI 永远保留 legacy renderer/generic fallback；
4. 事件日志和 LLM messages 分开维护；
5. 仅在语义或传输不可兼容时开启新 session；
6. 新 session 用 continuation 引用旧 session，不复制旧事件；
7. 精确请求快照若启用则写入 raw.jsonl，不让 UI、续聊或状态恢复依赖它；未来可由 OTel 替代。
```
