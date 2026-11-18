# 房间消息模型（终稿 v2）

> 讨论稿。只讨论**消息形态**，不考虑存储、编码、压缩。
> v1 是扁平 `Item[]`、工具是 block（决定 A）。v2 加决定 B：**一轮是整体，条目永不插进别人的中间**。
> A 不变，B 是它上面一层。

## 0. 两个决定

**A. 工具是 content block。** 一条消息 = 一个 `content: ContentBlock[]`，
工具调用是数组里的 block，结果按 `callId` 挂回 `results`。
（v1 已定，v2 不改。）

**B. 一轮对话是一个整体，不做 next-step 插入。**

后者是我认为更根本的那条。交错截断不是"用户滚动时看着乱"这种观感问题，
是模型问题：一旦允许 B 的条目插进 A 的一步中间，A 就必须在读取时被**重建**，
而重建需要一个能反推相邻性的判据。现在这个判据是三层启发式：

| 判据 | 位置 | P0 后 |
|---|---|---|
| 上一条 assistant 同 turn 同 author → 并进去 | `timeline.ts:175-181` | 已删 |
| 同 `(turnId, authorId)` 的第 n 段 → 键加 `#n` + `continued` | `timeline.ts:182-196` | 已删 |
| 找不回工具行 → 造独立卡片、`turnId: ''`、按 `at` splice 回去 | `timeline.ts:242-255` | 只剩「那一轮也不在窗口里」这一种（§9） |

第三行的注释把失败模式写完了：

> 已有结局：这条提问可能是几百条之前、那条工具行已经滑出窗口的。借用「最后一条
> assistant」会让卡片凭空跑到时间线底部…所以挂成**独立卡片**

也就是说：**模型允许出现"找不回来"的状态，然后靠 UI 层兜底**。嵌套之后这种状态
在类型上就不存在了 —— 容器的位置定了就定了，追加发生在容器内部，没有"插进去"
这个操作，也就没有"插进去了要能找回来"这件事。

这条决定能替掉的东西比 A 更多，见 §6。

> **本节两条都已定。** A 在 v1 定；B 在 v2 定，取「轮闭合后不可变」
> （提问被回答 = 新起一轮，见 §8 第 1 条）。下面各节按这两个决定写，不再并列备选。

---

## 1. 契约

三级，每一级恰好是一个消费方需要的那级：

```ts
//   Turn   房间的位置单位（创建时定死，之后只往里长，永不搬家）
//    └ Reply   一个 bot 的一次完整回复（并行 = 多个 reply 并列）
//        └ Step    一次 LLM 补全（模型消息的边界在这层）

// ── 来源：两轴正交 ────────────────────────────────────────────
//
//   kind 回答"谁产的"，form 回答"这是个什么东西"。
//   form 的词汇是**语义**的（"这份内容是文件里的指令"），不是视觉的
//   （"它该画成灰底小字"）。折叠、颜色、顺序是消费方的事。

type MessageSource =
    | { kind: 'human';   userId: string }
    | { kind: 'bot';     botId: string; name: string; color: string }
    | { kind: 'tool';    callId: string }
    | { kind: 'system-prompt' }
    ;

type ContextForm =
    | 'instructions'   // persona / AGENTS.md / skill 正文
    | 'catalog'        // 工具清单、房间成员
    | 'snapshot'       // 会被下一次同源快照取代的状态
    | 'notice'         // 一次性事件：截断、工具悬空、有人加入
    | 'relay'          // 另一个 bot 递来的话
    | 'recall'         // 从别人 session 里捞出来的片段
    ;

type Sourced = MessageSource & { form?: ContextForm };

// ── 内容区块 ────────────────────────────────────────────────

type ContentBlock =
    | { type: 'text';      text: string }
    | { type: 'reasoning'; text: string }
    | { type: 'tool-call'; id: string; name: string; arguments: string }  // 原始 JSON 串，不解析
    | { type: 'image';     attachment: ImageRef; offloaded?: true }
    | { type: 'file';      attachment: FileRef }
    ;

/** 工具结果：三份各归各位，core 不解释 meta */
interface ToolResultView {
    state: 'running' | 'ok' | 'error';
    /** 给模型看的那份 */
    text?: string;
    /** 结构化失败身份：机器码给 UI / 统计用，**不进模型 content** */
    error?: { name: string; code: string; reason?: string };
    /** 只给 UI：diff / 字节数 / 退出码 / 耗时。core 原样透传，不解释 */
    meta?: { bytes?: number; ms?: number; exitCode?: number;
             diff?: { path: string; added: number; removed: number } };
}

interface MessageStats {
    ttftMs?: number;
    decodeMs?: number;
    outputTokens?: number;
    tps?: number;
    retries?: number;
    wallMs?: number;
    usage?: { inputTokens: number; outputTokens: number; totalTokens?: number;
              cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number };
}

// ── 三级 ────────────────────────────────────────────────────

interface Step {
    index: number;
    content: ContentBlock[];
    results?: Record<string, ToolResultView>;
    stats?: MessageStats;
}

type ReplyStatus =
    | 'streaming'
    | 'awaiting-input'   // 挂在提问上等回答。**终止态**
    | 'done'
    | 'failed'
    ;

type EndReason =
    | { kind: 'completed' }
    | { kind: 'max-tokens'; maxOutputTokens: number; finishReason?: string; steps?: number }
    | { kind: 'filtered'; finishReason?: string }
    | { kind: 'tool-mismatch'; pendingCalls: number }
    | { kind: 'interrupted' }
    | { kind: 'awaiting-input'; askId: string }
    | { kind: 'error'; message: string; code: string; status?: number }
    | { kind: 'unknown'; note: 'no-finish' | 'empty-output' | `finish=${string}`; finishReason?: string }
    ;

interface Reply {
    id: string;              // m_a_t07
    /** 自身更新计数，单调递增。判新旧只比它 —— 不跟房间事件号混 */
    rev: number;
    at: number;
    source: Extract<Sourced, { kind: 'bot' }>;
    status: ReplyStatus;
    steps: Step[];
    /** 终止态的判定。`switch` 可穷举 */
    end?: EndReason;
    /** 整条回复的汇总账。投影折好，UI 不做算术 */
    stats?: MessageStats;
    /** 解释性附注（截断原因等）。附着在它解释的那条回复上，不是独立条目 */
    notice?: { kind: string; text: string; detail?: string };
}

/** 人说的话 / 投进某个 bot 上下文的系统注入 */
interface Message {
    id: string;
    at: number;
    role: 'user' | 'system';
    source: Sourced;
    content: ContentBlock[];
}

type TurnCause =
    | { kind: 'human'; messageId: string }
    | { kind: 'ask-answered'; askId: string }
    | { kind: 'system' }
    ;

interface Turn {
    id: string;              // turn-…
    /** 房间事件号，全局单调。只用于幂等和增量，**不用于排序** */
    seq: number;
    at: number;
    cause: TurnCause;
    /** 人说的话（system 触发的轮没有） */
    input?: Message;
    /** 每个 bot 一份完整回复。并行跑就是并行 append */
    replies: Reply[];
    status: 'open' | 'done';
}
```

**两个号，两个用途，不会再互相污染：**

- `Turn.seq` —— 房间事件号，幂等/增量用。**排序不用它**：`Turn[]` 的数组下标就是位置。
- `Reply.rev` —— 这条回复自己的更新计数。判新旧只比它，跟房间有多少事件无关。

现在的问题正是这两件事共用一个 `seq`：`projection.ts:117` 每次 `apply` 都
`this.seq = Math.max(this.seq, event.seq)`，而 `text.delta` 每来一个字就
`++seq`（`agent.ts:113`）—— 于是 `Item.seq` 是 **token 序号**，不是事件序号。
`order` / `orderOf`（`room.ts:93`、`:641`）整个 Map 就是在给这个污染打补丁。

---

## 2. 时间线

`room:diy`，成员：你 / 小A（#4C8DFF）/ 小B（#FF7A45）。
你 @ 两个 bot，两个并行跑。

| seq | 动作 | 落在哪 |
|---|---|---|
| 41 | `turn.create` → `t_07`（`input` = `m_u_01`） | 时间线末尾 |
| 42 | `reply.create` → `r_a` rev1 | `t_07.replies[0]` |
| 43 | `reply.create` → `r_b` rev1 | `t_07.replies[1]` |
| 44 | `r_a` rev2 —— step1 定稿（思考 + `call_1`） | `t_07.replies[0].steps[0]` |
| 45 | `r_a` rev3 —— `results.call_1 = ok` | 同上 |
| 46 | `r_b` rev2 —— step1 定稿（正文） | `t_07.replies[1].steps[0]` |
| 47 | `r_a` rev4 —— step2 定稿（`call_2` bash） | `t_07.replies[0].steps[1]` |
| 48 | `r_a` rev5 —— `results.call_2 = ok` | 同上 |
| 49 | `r_b` rev3 —— step2 定稿 + 截断 → `done` | `t_07.replies[1]` |
| 50 | `r_a` rev6 —— step3 定稿 + `ask_1` → `awaiting-input` | `t_07.replies[0]` |
| 51 | `t_07` → `done`（两条 reply 都到终止态） | — |
| 52 | `turn.create` → `t_08`（你：@小B 顺带看看 reduce.ts） | 时间线末尾 |
| 53 | `r_b2` rev1 —— streaming | `t_08.replies[0]` |
| 54 | `ask.answered` `ask_1` | — |
| 55 | `turn.create` → `t_09`（`cause: ask-answered`） | 时间线末尾 |
| 56 | `r_a2` rev1 —— step1 定稿（工具结果 + 结论）→ `done` | `t_09.replies[0]` |
| 57 | `r_b2` rev2 → `done`；`t_08` → `done` | — |

这张表里没有一次"插进别人中间"：

- 小A 的 4 步全在 `t_07.replies[0].steps[]` 里，小B 的 2 步全在
  `t_07.replies[1].steps[]` 里，**并行的是两个数组，不是一条流**。
- 小B 在 seq 46 就出正文了，小A 在 seq 50 才停。两者谁先谁后不影响位置：
  `t_07` 在 seq 41 拿到位置，之后再没动过。
- `t_09` 是因为提问被回答而**新起的轮**，不在 `t_07` 里长出第 4 步。

### 不变量

> **位置在创建时确定，之后只往容器内部追加，永不移出、永不重排。**

推论，每条都替掉一段现有代码：

1. 同一 bot 在同一轮里最多一条 reply → 不存在"同 author 的第 2 段"，`#n` 无从产生。
2. reply 不跨轮搬家 → 不会出现"找不回工具行"的孤儿卡片。
3. 排序只需比较 `Turn[]` 的下标 → 不排序，不需要 `orderedByAppearance`。
4. 交错上限 = **同时在跑的 reply 数**（通常 2-3），不是 delta 数（几千）。

第 4 条是"灾难性"这个词的答案：交错量从"与 token 数成正比"降到"与并发 bot 数成正比"。

---

## 3. 范例

### 3.1 seq 41 —— 一轮开始

```json
{
  "id": "t_07",
  "seq": 41,
  "at": 1730000000000,
  "status": "open",
  "cause": { "kind": "human", "messageId": "m_u_01" },
  "input": {
    "id": "m_u_01",
    "at": 1730000000000,
    "role": "user",
    "source": { "kind": "human", "userId": "u_you" },
    "content": [{ "type": "text", "text": "@小A @小B 为什么首屏会卡" }]
  },
  "replies": []
}
```

投递（轮级，独立于消息本身）：

```json
{ "kind": "delivery", "delivery": {
    "roomId": "room:diy", "messageId": "m_u_01", "turnId": "t_07",
    "botId": "b_a", "state": "delivering", "updatedAt": 1730000000001 } }
```

> **UI**：一条人的消息，下面挂两个小人头（delivering / queued）。这个人头是**轮级**的 ——
> 现在它挂在消息条目上靠 `chipsOf`（`timeline.ts`）筛，嵌套后它就是 turn 的字段。

### 3.2 seq 42 / 43 —— 两条回复的骨架

```json
{
  "id": "r_a", "rev": 1, "at": 1730000000210,
  "status": "streaming",
  "source": { "kind": "bot", "botId": "b_a", "name": "小A", "color": "#4C8DFF" },
  "steps": []
}
```

```json
{
  "id": "r_b", "rev": 1, "at": 1730000000220,
  "status": "streaming",
  "source": { "kind": "bot", "botId": "b_b", "name": "小B", "color": "#FF7A45" },
  "steps": []
}
```

> **UI**：`t_07` 里并排（或堆叠）两张卡，各自"正在输入…"。两张卡的位置在
> 这一步就定了，之后不管谁先说谁后说完，卡片不换位、不重挂。

### 3.3 流式 chunk（transient，不进日志，不占 seq，不动 `rev`）

```json
{ "kind": "chunk", "roomId": "room:diy", "turnId": "t_07", "replyId": "r_a",
  "chunk": { "type": "reasoning-delta", "step": 0, "blockIndex": 0, "text": "先看 " } }
```

```json
{ "kind": "chunk", "roomId": "room:diy", "turnId": "t_07", "replyId": "r_a",
  "chunk": { "type": "tool-call-delta", "step": 0, "blockIndex": 1, "id": "call_1",
             "name": "read",
             "argsText": "{\"path\":\"pkgs.ts/agent/entity-runtime/src/projection.ts\"}" } }
```

`(turnId, replyId, step, blockIndex)` 是完整地址 —— 不需要找"最后一条 assistant"。

### 3.4 seq 45 —— `r_a` rev3，工具结果原地落位

```json
{
  "id": "r_a", "rev": 3, "at": 1730000000402,
  "status": "streaming",
  "source": { "kind": "bot", "botId": "b_a", "name": "小A", "color": "#4C8DFF" },
  "steps": [
    {
      "index": 0,
      "content": [
        { "type": "reasoning", "text": "先看 projection 里 seq 怎么涨的。" },
        { "type": "tool-call", "id": "call_1", "name": "read",
          "arguments": "{\"path\":\"pkgs.ts/agent/entity-runtime/src/projection.ts\"}" }
      ],
      "results": {
        "call_1": { "state": "ok", "text": "1  // projection.ts\n2  …",
                    "meta": { "bytes": 3821, "ms": 12 } }
      },
      "stats": { "ttftMs": 900, "decodeMs": 380, "outputTokens": 61, "tps": 160,
                 "usage": { "inputTokens": 18420, "outputTokens": 61, "cacheReadTokens": 18176 } }
    }
  ]
}
```

> **UI**：`t_07.replies[0].steps[0]` 那一行从 `running` 变 `3.8KB · 12ms`。
> 地址不是"最后一条 assistant 里叫 `tool-call_1` 的那行"，就是那个数组元素。

### 3.5 seq 49 —— `r_b` 终止：截断的解释附着在它解释的回复上

```json
{
  "id": "r_b", "rev": 3, "at": 1730000001200,
  "status": "done",
  "source": { "kind": "bot", "botId": "b_b", "name": "小B", "color": "#FF7A45" },
  "end": { "kind": "max-tokens", "maxOutputTokens": 8192, "finishReason": "length", "steps": 2 },
  "notice": {
    "kind": "truncated",
    "text": "小B 的输出被上限截断（8192 tokens）",
    "detail": "finishReason=length，已产出 8192 / 8192"
  },
  "steps": [
    {
      "index": 0,
      "content": [{ "type": "text", "text": "我这边看首屏是先渲染再等快照。" }]
    },
    {
      "index": 1,
      "content": [
        { "type": "text", "text": "跑一下测试确认。" },
        { "type": "tool-call", "id": "call_9", "name": "bash",
          "arguments": "{\"command\":\"pnpm -r test\"}" }
      ],
      "results": {
        "call_9": {
          "state": "error",
          "text": "exit 1\nFAIL pkgs.ts/agent/entity-runtime/src/projection.test.ts\n  ● seq 应当等于事件序号",
          "error": { "name": "ToolError", "code": "ExitNonZero", "reason": "命令以非零码退出（1）" },
          "meta": { "exitCode": 1, "ms": 8200, "bytes": 412 }
        }
      }
    }
  ],
  "stats": { "ttftMs": 700, "decodeMs": 4310, "outputTokens": 812, "tps": 188, "wallMs": 9400 }
}
```

> 三份分工，整个设计的要害：
> - `text` 进模型上下文 —— 模型只知道"挂了、挂了什么"；
> - `error.code` 是机器码 —— UI 画红框、统计失败率，**不属于模型可见历史**；
> - `meta` 是工具私有展示载荷 —— core 不解释，UI 想画 diff 就画 diff。
>
> `notice` 不再是独立条目：它解释的是"小B 这一条为什么这么短"，所以它属于 `r_b`。
> 这也消掉了 v1 里"页脚 transient / 通知持久"这个不对称 —— 那个不对称的存在
> 原因是扁平列表里没有"这条跑完了"这个位置，只能拆成两个条目。

### 3.6 seq 50 —— `r_a` 挂在提问上（终止态 `awaiting-input`）

```json
{
  "id": "r_a", "rev": 6, "at": 1730000002000,
  "status": "awaiting-input",
  "source": { "kind": "bot", "botId": "b_a", "name": "小A", "color": "#4C8DFF" },
  "end": { "kind": "awaiting-input", "askId": "ask_1" },
  "steps": [
    { "index": 0, "content": [ "…" ] },
    { "index": 1, "content": [ "…" ] },
    {
      "index": 2,
      "content": [
        { "type": "text", "text": "证据够了，问你一句。" },
        { "type": "tool-call", "id": "call_3", "name": "ask",
          "arguments": "{\"kind\":\"choice\",\"question\":\"要我把 seq 拆开改吗？\"}" }
      ],
      "results": { "call_3": { "state": "running" } }
    }
  ]
}
```

`results.call_3` 一直 `running`，直到提问被回答 —— 那时它是 `ok` + 回答文本。
**提问卡片不需要单独挂载，它在 `content` 里就有位置。**

```json
{ "kind": "ask", "request": {
    "askId": "ask_1",
    "owner": "b_a",
    "turnId": "t_07",
    "replyId": "r_a",
    "toolCallId": "call_3",
    "kind": "choice",
    "question": "证据够了。要我把 seq 拆开改吗？",
    "options": [
      { "value": "doc",   "label": "先写文档" },
      { "value": "step1", "label": "直接拆 seq", "description": "会删掉 order/orderOf" }
    ],
    "allowFreeform": true,
    "at": 1730000002000
} }
```

> `(turnId, replyId, toolCallId)` 是三元地址，精确命中。
> 现在 `attachAsk` 要靠 `id === \`tool-${toolCallId}\`` 全表搜，搜不到还要
> `fallback: 'standalone'` 造一个 `turnId: ''` 的孤儿卡片（`timeline.ts:242-255`）。

### 3.7 seq 54-56 —— 答完之后：新起一轮

```json
{ "kind": "ask.answered", "askId": "ask_1", "answer": { "values": ["step1"] } }
```

```json
{
  "id": "t_09",
  "seq": 55,
  "at": 1730000005500,
  "status": "open",
  "cause": { "kind": "ask-answered", "askId": "ask_1" },
  "replies": [
    {
      "id": "r_a2", "rev": 1, "at": 1730000005600, "status": "done",
      "source": { "kind": "bot", "botId": "b_a", "name": "小A", "color": "#4C8DFF" },
      "end": { "kind": "completed" },
      "steps": [
        {
          "index": 0,
          "content": [
            { "type": "text",
              "text": "根因是 seq 被 delta 撑爆了 —— 每来一个字就 ++seq，于是 Item.seq 是 token 序号，不是事件序号。order/orderOf 就是在补这个洞。" }
          ],
          "results": {
            "call_3": { "state": "ok", "text": "直接改" }
          }
        }
      ],
      "stats": { "ttftMs": 640, "decodeMs": 2680, "outputTokens": 342, "tps": 127,
                 "usage": { "inputTokens": 20020, "outputTokens": 342, "cacheReadTokens": 19712 } }
    }
  ]
}
```

> 好处：`t_07` 从此**不可变**。位置在前、内容永不再变，可以做快照 diff、
> 可以缓存、可以分页。v1 里 `t_07` 会在你回答之后从"已经翻过去的地方"再长出一段，
> 那条路径上现在的兜底就是 `order`（`timeline.ts:104-109` 注释里写的那个洞）。
>
> 代价：同一次调查被切成两条 reply，模型 transcript 靠 `call_3` 的 tool_result 自然接续
> （assistant 带 tool_call → tool 结果 → 继续）。这不破坏协议，但确实是一次"断"。

### 3.8 快照

```json
{
  "turns": [
    {
      "id": "t_07", "seq": 41, "status": "done",
      "cause": { "kind": "human", "messageId": "m_u_01" },
      "input": { "id": "m_u_01", "role": "user",
                 "source": { "kind": "human", "userId": "u_you" },
                 "content": [{ "type": "text", "text": "@小A @小B 为什么首屏会卡" }] },
      "replies": [ "… r_a（awaiting-input，见 3.6）…", "… r_b（done，见 3.5）…" ],
      "deliveries": [
        { "botId": "b_a", "state": "delivered" },
        { "botId": "b_b", "state": "delivered" }
      ]
    },
    { "id": "t_08", "seq": 52, "status": "done",
      "input": { "id": "m_u_02", "role": "user",
                 "source": { "kind": "human", "userId": "u_you" },
                 "content": [{ "type": "text", "text": "@小B 顺带看看 reduce.ts" }] },
      "replies": [ "… r_b2 …" ] },
    { "id": "t_09", "seq": 55, "status": "done",
      "cause": { "kind": "ask-answered", "askId": "ask_1" },
      "replies": [ "… r_a2，见 3.7 …" ] }
  ]
}
```

> **UI 离线可重建**，且不需要任何启发式：位置是数组顺序，并行是 `replies[]`，
> 工具状态在 `results`，红框原因在 `results[].error`，性能数字在 `stats`，
> 已答提问在 `results.call_3.state === 'ok'`（回答文本就是它的 `text`）。

---

## 4. bot 看到的上下文：同一个模型，另一个投影

房间 UI 和 bot 的 LLM 上下文是**同一批事实的两个投影**，不是两份数据。

```ts
/** bot 自己看到的历史 */
type TranscriptEntry =
    | { role: 'assistant'; replyId: string; step: Step }
    | { role: 'user'; message: Message }      // 人的话、relay 进来别人的整条回复
    | { role: 'system'; message: Message }    // instructions / catalog / snapshot
    ;

function toTranscript(turns: readonly Turn[], botId: string): TranscriptEntry[];
```

拼装规则：

1. 系统层先：`instructions` → `catalog` → `snapshot`（各是一条 `Message`）。
2. 按 `Turn[]` 顺序，取本 bot 的 reply，展开成 `assistant` + 每步。
3. 别人的 reply **只能整条**作为 `form: 'relay'` 的 user `Message` 插入。
4. 没落定的 reply 不进 transcript。

第 3 条是决定 B 的直接推论，也是它在架构上的真正理由：

> **只有"整条回复"才拿得走。** 如果允许 step 级交错，那么"要不要把 A 的第 2 步
> 递给 B"就变成一个必须回答、且没有好答案的问题 —— A 的第 2 步发生在 B 的第 3 步
> 中间，递过去就破坏了 B 的因果顺序。原子化把这个问题从"要想清楚"变成"不存在"。

小B 的 transcript 里，小A 的结论长这样：

```json
{
  "role": "user",
  "message": {
    "id": "r_a",
    "at": 1730000002000,
    "role": "user",
    "source": { "kind": "bot", "botId": "b_a", "name": "小A", "form": "relay" },
    "content": [{ "type": "text", "text": "根因是 seq 被 delta 撑爆了 …" }]
  }
}
```

> `id` 沿用 `r_a` → UI 可以按 id 判"这条时间线上已经显示过了"，不用比文本。
> `[小A 的结论]` 这个模板在**适配器边界**，不在日志里。现在 `form: 'relay'` 已经是
> 结构化字段了，模板只是渲染。

系统注入也进这个投影（不进房间时间线）：

```json
{
  "role": "system",
  "message": {
    "id": "m_s_2",
    "role": "system",
    "source": { "kind": "system-prompt", "form": "snapshot",
                "sections": [
                  { "name": "房间成员", "text": "你、小A、小B" },
                  { "name": "当前任务", "text": "定位首屏卡顿" }
                ] },
    "content": [{ "type": "text", "text": "房间成员：你、小A、小B\n当前任务：定位首屏卡顿" }]
  }
}
```

> 顺带：只有 prompt 进了模型，`cacheReadTokens` 才有解释力。现在 persona 一改
> 整段 cache 失效，而数据里看不出这件事发生过。

---

## 5. 消费方对照

| 消费方 | 拿到的 | 关键字段 |
|---|---|---|
| 房间时间线（UI） | `Turn[]`，数组顺序即位置 | `replies[]` 并行、`source` 上色 |
| 小A 的 LLM 上下文 | `TranscriptEntry[]` | `tool-call.arguments` 原始串，不解析 |
| 小B 的 LLM 上下文 | 同上，别人的回复 `form: 'relay'` | 边界序列化前缀 |
| 折叠出来的账 | `Reply.stats` / `Step.stats` | 从日志复算，不另埋点 |
| 存储 | 日志事件（本文不讨论） | delta 不进日志 |

---

## 6. 这两条决定替掉了什么

按可指行排列。**1-5 是决定 B 替掉的，6-8 是决定 A 替掉的。**
标 ✅ 的行**已经在 P0 里做完了**（见 §9），剩下的还等着 P1。

| # | 现有代码 | 为什么存在 | 之后 |
|---|---|---|---|
| 1 ✅ | ~~`previous.kind==='assistant' && 同turnId && 同author` 才合并~~ | 相邻性被交错打断，只能看"上一条"猜 | 一条 reply 本来就是一个整体 |
| 2 ✅ | ~~`segments` map、`#n` 键、`continued: true`~~ | 同一 bot 在一轮里被插开成多段 | 同 bot 同轮最多一条 reply |
| 3 ◐ | `timeline.ts:255-268` `fallback:'standalone'`、按 `at` splice | 找不回工具行（已经滑出窗口）且**那一轮整个也不在窗口里** | 地址是 `(turnId, replyId, toolCallId)`，不靠搜 |
| 4 | `timeline.ts:113-117` `orderedByAppearance` 排序 | 扁平列表要靠 `order` 排序 | 数组顺序即位置 |
| 5 | `room.ts:93` / `:598` / `:647` `orderOf: Map`、`nextOrder()` | 每个条目都要一个位置号 | 每个 turn 一个位置，序号 = 下标 |
| 6 | `timeline.ts:218` / `:223` `id === \`tool-${toolCallId}\`` | UI 必须知道投影层拼前缀的约定（`projection.ts:150`） | `toolCallId` 就是 block 的 `id` |
| 7 | `reduce.ts:34-40` `isStale`：文本变短 = 旧事件 | `text` 是逐 delta 累加的，只能比长度 | 比 `Reply.rev` |
| 8 | `timeline.ts` 的"页脚 transient + notice 条目持久" | 扁平列表没有"这条跑完了"的位置 | `Reply.end` / `Reply.notice`，都在对象上 |

还有一处是**语义**上的收益，不在表里：`turnId` 现在只用来分组（`entries` 里靠
它判断能不能合并），嵌套之后它不是"分组键"而是"容器"。分组键需要稳定、唯一、
可比较 —— 容器不需要，容器就是容器。

---

## 7. 代价（诚实的那部分）

1. **渲染多一层**。`Turn → Reply → Step` 比扁平列表深一层。但 React key 更稳：
   `r_a` 这个 key 从创建到终止不变，不会因为"切段"重挂。
2. **并行回复不能"按时间交错"展示**。小B 先说完，它也不会跑到小A 上面。
   这是特性不是缺陷（位置稳定 > 时间精确），但如果产品要"谁说话谁跳到下面"，
   嵌套就堵死了这条路。
3. **一轮的闭合取决于最慢的那条 reply**。小A 挂提问问了一小时，`t_07` 就开着一小时。
   界面要显示"这一轮还没完"。换来的是：**关闭的轮不可变**。
4. **提问回答 = 新起一轮，会把一次调查切成两条 reply**。模型 transcript 靠
   `tool_result` 接续，协议上没问题，但"这一步和上一步是同一次调查"这个信息
   只存在于 `cause.kind === 'ask-answered'` 里。
5. **同 bot 的并发**：一个 bot 在 `t_07` 还有 streaming 的 reply 时又收到 `t_08` 的投递。
   两种处理：(a) 排队，等它空；(b) 允许同一 bot 同时有两条 streaming reply。
   现在 `delivery.state` 有 `queued`，倾向于 (a)，但这条要写进约束，否则并发
   又会从"同一 bot 的多个 reply 并行"这个新口子漏回来。
6. **relay 只能拿整条 reply**。拿不到"别人第 2 步的中间结论"，只能等它整条跑完。
   考虑到 tool 结果的中间态本来也不该跨 bot 共享，我认为这条是对的，但要承认
   它限制了"边跑边协作"这类玩法。

---

## 8. 还没定

1. ~~一轮的边界~~ —— **已定 (A)**（见 §7 第 3、4 条的代价）：
   人一句话 + 所有 bot 回复 = 一轮；提问被回答 → 新起一轮；**闭合的轮不可变**。

   不取的两个备选，理由留档：
   - (B) 回答续在原 reply 里（`t_07` 重新 `open`，长出第 4 步）。transcript 少断一次，
     但闭合的轮不再是不可变的 —— 而「闭合即不可变」正是这条选择的收益来源，
     换掉它等于只拿代价不拿好处。
   - (C) 一个 bot 的一次完整回复 = 一轮。最接近现有 `delivery.turn` 语义、改动最小，
     但 `Turn.replies` 退化成恒长 1，`input` 要指回原消息 —— 也就是把「整体」
     降级成「每条各自原子」，交错上界从 O(并发 bot) 回到 O(并发 bot × 轮)。
2. **同 bot 并发**：倾向 (a) 排队（等它空出当前 reply 再投下一轮）。
   这是**运行时策略，不影响形状** —— 排队还是并行，「reply 不跨轮搬家」都成立，
   嵌套模型不用改。放这儿是因为它决定 `delivery.state === 'queued'` 要不要进快照。
3. **`reasoning` 要不要进 UI 时间线**。现在 `projection.ts` 直接把 `reasoning.delta`
   丢了。它天然是一个 block，但要不要给用户看是产品决定。
4. **`stats` 放契约上，还是 UI 自己从 stream 算**。本文选前者（UI 不做算术），
   代价是投影层多算一遍。
5. **`form` 封闭 vs 开放**。本文封闭 6 值。开放更松，但 `switch` 没法穷举 ——
   和 `EndReason` 是同一个取舍。

---

## 9. 最小落地路径

全量换成 `Turn`/`Reply`/`Step` 要动协议契约（`Item` 4 个变体、`Snapshot`、
`StreamEvent`、`TurnEndReason`），而 `Item` 在 32 个文件里被引用、`buildTimeline`
有 4 个生产调用方 + 3 个测试。不是一次能做完的。

§6 那 8 条里有一部分**不需要换契约**就能杀掉，因为它们只是「在扁平流里重建嵌套」的
产物，而扁平流其实已经握有嵌套所需的一半信息：`(turnId, author)` 就是 reply 的
唯一地址（在「同 bot 同轮一条 reply」这个不变量下）。

落地之后回头看，实际拿到的是 **1、2 整条 + 3 的一半**，而不是当初估的 1-5。
下面每个 P0 都附了「原先以为能拿到什么 / 实际拿到什么」—— 这一节刻意保留误差，
因为它本身就是这类估算的样本。

### P0（已落地）

**P0-1 分组，而不是相邻合并。** ✅
把「看 previous 猜能不能并」换成「按 `(turnId, author.id)` 分桶，位置取首次出现」。
→ 杀掉 §6 第 1、2 条。`#n` 键、`continued` 标志、`segments` map 全部删掉，
两个 surface 里为「续段」准备的那条分支也一起删了（否则就是留一段永远不执行的死代码）。

**P0-2 `AskRequest` 加 `turnId`。** ✅（收益比原先写的**小** —— 下面这句是更正）
`turnOf` 由房间按 `tool-${toolCallId}` 记账（那个工具条目先落、执行体后跑），闸门在创建
提问时就盖上去，所以 `list()` / `answeredList()` / 推给界面的那份都带着它。

> 原先写的是「有了 turnId，按 key 找桶永远找得到，孤儿卡片消失」。**这句话不成立**：
> 整轮都滑出窗口时照样没有桶可找。所以 `fallback: 'standalone'` 在 P0 里**删不掉** ——
> 它要等回复成为容器（P1）之后才会变成「不可能发生的状态」。
>
> 真实收益是三条小的：卡片终于知道自己属于哪一轮（不再是 `''` 哨兵）；
> 工具行滑出去但那一轮还在时能挂回正确的位置，不必借「最后一条 assistant」猜；
> 以及将来 P1 的地址 `(turnId, replyId, toolCallId)` 有了一半。

**P0-3 停掉 delta 撑 `seq`。** ✅（收益也比原先写的**小**）
`agent.ts` 只有结构性事件（开跑 / 工具 / 收尾）才 `++seq`，增量共用当前号。

> 原先写「杀掉 §6 第 4、5 条，`order` 可以删」。**不成立**：`order` 存在的原因是
> 「条目落库时刻 ≠ 出现时刻」（`db.appendItem` 把 `seq` 换成行号），和 delta 是不是
> token 号没有关系。停止 delta 撑号只是让 `seq` **回到事件序号**，两套号的矛盾原样还在。
> 删 `order` 要等位置由容器定义（P1）。

P0 做完的真实状态：**视图层已经是「一个 bot 一轮一条」，交错没有发生的位置；
`#n` / `continued` / 相邻性启发式全部消失。** §6 真正拿到的是第 1、2 条，
第 3 条拿到一半，第 4、5、6、7、8 条还在。

**P0-4 失败属于回复，不属于轮。** ✅（review 追加，原本漏了）

分桶之后冒出一个 P0-1 的副作用：`error` 条目如果还独立成条，它只能排在整条回复**之后** ——
因为回复的位置在首次出现时就定死了，之后不移动。而失败之后同一个 bot 在同一轮里还会再跑
一次（排队中的投递带着同一个 `turnId`），于是「说一段 → 失败 → 重试成功」被渲染成
「说一段 + 重试成功，然后调用失败」。因果倒挂，不是排版问题。

修法不是把错误插到某个工具行后面（那还是条目级思路，且 `Item` 的 `error` 根本没有
`toolCallId`），而是按**归属**切：

```
有 author 的 error   → 那个 bot 的 run.failed      → 回复的 part（按时间顺序插进去）
没有 author 的 error → endItems 的轮级结局         → 独立的条目
```

这条规则可以一般化成整个 P0 的形状判据：**谁拥有它，决定它是 part 还是 entry。**
轮级的事实（「这一轮怎么停的」「@ 激活了谁」）成条；回复级的事实（说了什么、调了什么工具、
哪一步失败了）成 part。原来 `notice` / `error` 一视同仁地成条，是因为扁平流里没有「回复」
这个容器 —— 现在有了，就该分开。

### P1（契约）

`Item` → `Turn { replies: Reply { steps: Step[] } }`；`TurnEndReason` → `EndReason`；
`StreamEvent` 的 `item` → `reply`；`Snapshot.turns`。
这时才需要碰那 32 个文件。**先落袋 P0，再判断 P1 值不值** —— P1 换来的主要是
§6 第 6、7、8 条（工具进 `content`、`rev` 判新旧、`end` 挂在对象上），
而这三条本来也可以各自独立做。
