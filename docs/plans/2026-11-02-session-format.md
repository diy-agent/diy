# session / bot 数据契约（现状快照）

> 任务：`projects/4/tasks/503`（父 `#266`）。纯文档，不改代码。
> 用户裁（2026-11-02）：**不做数据迁移，开发以内存 app 为主，主打快速迭代，废弃一切旧东西。**

## 零、这份文档是什么 / 不是什么

**是**：截至 2026-11-02，磁盘上、内存里、线上（renderer）各自长什么样的**核实记录**。每条都对着
`rg` 出来的代码，不信任务 body 里的旧表（那张表已经过期，见第八节）。

**不是**：

- 不是冻结的 schema 承诺 —— 没有外部消费者、没有真实用户数据、不迁移旧数据，**格式想改就改**。
- 不是迁移方案 —— 不写兼容分支，不写 `schemaVersion`（结论见第七节）。
- 不是实现计划 —— 发现的实现与直觉不符处只记录，不修（第八节）。

**它的用法**：下次要改消息 / 会话 / bot 的形状时，先看这里「现在是什么」，直接改代码，
然后更新这份文档。判断标准从「会不会破坏旧数据」变成「**改完有没有人/什么东西会读错**」——
当前答案是：只有本仓库的代码会读，所以只要同一个 PR 里改齐就行。

---

## 一、磁盘布局总览

数据根 `$DIY_HOME`（生产 `~/.diy`；dev / 测试由启动器指到别处）。

```
$DIY_HOME/
├── bots/
│   └── <botId>/
│       └── bot.json                bot 身份（BotConfig）
├── sessions/
│   └── chat/
│       └── <sessionId>/
│           ├── meta.json           会话身份（SessionMeta）
│           ├── bot.json            会话归属（{ botId }）
│           ├── index.json          桶索引（投影，可重建）
│           └── 0001-20261102-130600+0800.jsonl   消息桶（一桶一段连续 seq）
└── chat-ui.json                    界面状态（{ activeBotId }），不是领域真源
```

来源（已核实）：

- bots / 会话归属 / 桶：`pkgs.ts/agent/bot/src/store-fs.ts:1-13`（头注即目录契约）、
  `pkgs.ts/agent/store-jsonl/src/types.ts:1-12`
- 会话目录名固定在 `sessions/chat`：`apps/chat/sessions.ts:127,129`
- `chat-ui.json`：`apps/chat/sessions.ts:57-59,196-201`

注意：**session 包的缺省存储是内存**（`@diy-agent/session-store-memory`），jsonl 是 apps/chat
装配时显式注入的（`apps/chat/sessions.ts:238-241` 注释与实现）。所以「磁盘上有这些东西」是
chat 这个宿主的选择，不是 session 内核的固有行为；换宿主可以完全不落盘。

---

## 二、bot：`bots/<id>/bot.json`

### 2.1 形状

定义：`pkgs.ts/agent/bot/src/types.ts:20-45`。
落盘过滤：`store-fs.ts:174-190`（`persistable` 只写已知字段）。

```json
{
  "id": "bot-1",
  "name": "大王助手",
  "instructions": "你是「大王助手」，在 diy 的聊天窗口里陪大王干活。…",
  "model": "providerId/modelId",
  "primarySessionId": "s-mf3k2a-9x1z0q",
  "createdAt": "2026-11-02T13:06:41.387+0800",
  "updatedAt": "2026-11-02T13:06:41.387+0800"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 目录名；`[A-Za-z0-9_-][A-Za-z0-9_.-]*`（`store-fs.ts:24`） |
| `name` | 是 | 显示名 |
| `instructions` | 是 | 行为指令；空串 = 不注入。旧字段名 `persona` 读兼容（`store-fs.ts:197-201`） |
| `model` | 是 | `providerId/modelId`；##497 起必填，空 ⇒ 读成 `""` + `needsModel: true` |
| `primarySessionId` | 否 | 这个 bot 的长期会话 id（##498）；`primary()` 首次调用写回 |
| `reasoningEffort` | 否 | 推理强度档位，未设 = 跟随模型缺省 |
| `maxOutputTokens` | 否 | 输出软上限 tokens，未设 = 跟随场景缺省 |
| `createdAt` / `updatedAt` | 是 | `localISOString()`：`YYYY-MM-DDTHH:mm:ss.SSS+0800` |

**不落盘的字段**：`needsModel`（读兼容标记，`store-fs.ts:174`）。
**写入方**：只有 `createFileBotStore().save()`；读方：`load()/list()`。
**未知字段**：`parseConfig`（`store-fs.ts:203-236`）按字段取值、不做 unknown 拒绝 ⇒ 加字段向后可读。

### 2.2 与「人物（persona）」的关系

`PersonaDef = { name, model, reasoningEffort?, maxOutputTokens?, instructions }`
（`pkgs.ts/agent/bot/src/persona.ts` 的 zod schema）。也就是说 **bot 就是一个人物 + id + 时间 +
会话指针**，字段名刻意一致。将来要加人物级配置，优先加在 `PersonaDef` 上，bot.json 自然跟着长。

### 2.3 将来可能加的字段（现在都没有）

| 想加 | 放哪 | 判据 |
|---|---|---|
| `tools` / 能力开关 | `bot.json`（身份级） | 若「同一个人物在不同会话用不同工具」⇒ 应该放会话侧，不是 bot |
| 多个人物 / 角色切面 | 不放 bot，放 persona 库 | bot 是「一个人物的一次实例」 |
| `avatar` / 展示元数据 | `bot.json`，纯展示 | 删掉不影响行为 |
| 记忆 / 长期知识 | 独立目录，bot.json 只存引用 id | 别把大块数据塞进身份文件 |

（以上「想加」是候选，不是结论；任务当前只要求记现状。）

---

## 三、会话：`sessions/chat/<id>/`

### 3.1 `meta.json` — 会话身份

定义：`apps/chat/sessions.ts:46-55`；读写：`writeMeta` / `readMeta`（`sessions.ts:182-186, 530-550`）。

```json
{
  "id": "s-mf3k2a-9x1z0q",
  "title": "新会话",
  "model": "providerId/modelId",
  "createdAt": "2026-11-02T13:06:41.387+0800",
  "updatedAt": "2026-11-02T13:06:41.387+0800",
  "messageCount": 0
}
```

- `title`：建会话时写死 `"新会话"`；**第一次 send 后**若仍是 `"新会话"`，用该条用户正文前 20 字
  （空白压成一格）替换，之后不再改（`sessions.ts:499,527-530`）。用户手工改标题目前没有入口。
- `model`：**缓存**，打开会话时以 `bot.model` 为准，不一致就重写 meta（`sessions.ts:237-241`）。
  但 `readMeta` 要求它是 string，缺了整份 meta 判无效 ⇒ 形式上「必填」。
- `updatedAt`：每次 send 结束写一次；`botStore.sessionsOf()` 按它排序（`store-fs.ts:139-161`）。
- `messageCount`：**投影**，而且是「只加不减」的增量累加（`sessions.ts:496-501`），语义见第六节。

**不在 meta 里**：`schemaVersion`、token 用量、轮数、最近一步指标、压缩状态。后三者目前只在内存里。

### 3.2 `bot.json` — 会话归属（方案 B）

`{ "botId": "bot-1" }`。归属记在**会话自己**的目录里，而不是 bot.json 里存 `sessionIds`——
删 bot 不该丢会话数据（`pkgs.ts/agent/bot/src/types.ts:55-58` 的设计注释、`store-fs.ts:123-127`）。

写入：`botStore.assign(sessionId, botId)`（`store-fs.ts:140-152`）；
读取：`ownerOf()`；扫码：`sessionsOf(botId)` 遍历 `sessions/chat/*/bot.json`。

**权威关系**：会话属于谁，以**会话侧** `bot.json` 为准。`bot.primary()` 会先核对
`store.ownerOf(id) === config.id` 才复用写回的 id，否则新建（`bot.ts:51-59`）。
所以 `bot.json` 里的 `primarySessionId` 是**指针 / 缓存**，不是归属事实。

### 3.3 消息桶（真源）

定义与切分规则：`pkgs.ts/agent/store-jsonl/src/types.ts:1-47`、
`src/store.ts:1-24`（头注）、`DEFAULT_MAX_BUCKET_BYTES = 16 MB`（`types.ts:47`）。

- **按大小切**（16 MB），不按天。单条超大允许独占一桶。
- 文件名：`<序号4位>-<YYYYMMDD>-<HHMMSS><±HHMM>.jsonl`，如 `0001-20261102-130600+0800.jsonl`
  （`store.ts:35` 正则）。注意 **`-` 分隔日期与时间**，`+0800` 是那一刻的本地偏移；
  旧命名 `log-0001.jsonl` 仍可读、不再产（`store.ts:36`）。
- 一行一条消息，**没有头部行 / 没有版本行**。`serialize` 的字段顺序固定：
  `seq, role, type, text, data, mentions, at`（`store.ts:398-410`）。
- `seq` 全会话单调递增（1 起），**跨桶连续**；压缩只替换内存里的可见历史，不重置 seq。
- 写：只追加最后一桶；`index.json` 只在**切桶**时重写。恢复：index 缺失 / 损坏 / 多桶 / 少桶
  各有既定行为（`store.ts:1-19` 头注；少桶 = `store/missing-bucket` 报错不静默跳过）。

### 3.4 `index.json` — 桶索引（投影）

```json
{
  "buckets": [
    { "file": "0001-20261102-130600+0800.jsonl", "bytes": 1234,
      "fromSeq": 1, "toSeq": 4, "fromAt": 1762000000000, "toAt": 1762000004000 }
  ],
  "totalBytes": 1234,
  "nextSeq": 5
}
```

定义：`types.ts:31-40`。**可重建**：index 丢了就扫桶重算（`store.ts:236-260`）。
末桶可能在 index 写完后继续追加，打开时会重扫末桶刷新 bytes/toSeq（`store.ts:290-296`）。

### 3.5 `$DIY_HOME/chat-ui.json` — 界面状态

```json
{ "activeBotId": "bot-1" }
```

定义 `sessions.ts:57-59`。只记「上次选中的 bot」；没有就是没有，回落列表第一个。
它不是领域数据，删了不影响任何业务事实。

---

## 四、一条消息的完整形状

### 4.1 落盘 / 内存：`ChatMessage`

定义：`pkgs.ts/agent/session/src/types.ts:42-68`；解析校验：`src/message.ts:parseMessage`。

```ts
interface ChatMessage {
  seq?: number;                 // 会话内全局单调，1 起；落盘必带
  role: 'system' | 'user' | 'assistant' | 'tool';
  type?: MessageType;           // 判别键，6 种（见下）
  text?: string;                // 正文；tool-call 没有
  mentions?: readonly string[]; // @ 提到谁（目前 chat 不产）
  at?: number;                  // 写入时刻，epoch 毫秒
  data?: unknown;               // 分支私有载荷槽位，只要 JSON 装得下
}
```

`MessageType`（`types.ts:28`）：

| type | 谁产 | 说明 |
|---|---|---|
| `human` | 用户输入 | `role: user` 的缺省 type |
| `agent-conclusion` | 一轮结束 | `role: assistant` 的缺省 type；进 room 主线 |
| `agent-notice` | agent 主动播报 | 当前 chat 不产 |
| `agent-trace` | 调工具前 / 中断 | 中间过程；只在会话日志 |
| `tool-call` | 模型要调工具 | `role: assistant`，正文为空，载荷在 `data.tool` |
| `tool-result` | 工具执行结果 | `role: tool`，正文进 `text` |

`role` 有 4 种，但 `type` 只有 6 种且不含 system —— **system 消息没有 type**（`message.ts:40-44`
的缺省推导表里没有 system）。`system` 目前只用来装 bot 的 `instructions`。

一行真实落盘的样子（按 `serialize` 字段序）：

```json
{"seq":1,"role":"system","text":"你是「大王助手」…","at":1762000000000}
{"seq":2,"role":"user","type":"human","text":"帮我看下目录","at":1762000001000}
{"seq":3,"role":"assistant","type":"tool-call","data":{"tool":{"name":"bash","args":{"command":"ls"},"id":"call_1"}},"at":1762000002000}
{"seq":4,"role":"tool","type":"tool-result","text":"a.txt\nb.txt","at":1762000002100}
{"seq":5,"role":"assistant","type":"agent-conclusion","text":"有两个文件。","at":1762000003000}
```

`data` 是**能力槽位**：session 只保证「JSON 装得下、原样吐出」，不解释 schema（`types.ts:78-87`、
`message.ts:130-171`）。目前唯一被本包解释的私有载荷是 `tool-call` 的 `data.tool = { name, args, id }`
（`message.ts:186-197`），`args` 允许 `null`（无参数也必须写）。

### 4.2 线上（主进程 ↔ renderer）：`WireMessage` / `Block`

定义：`pkgs.ts/ui/chat-page/src/shared.ts:7-15, 45-48`；归一化：`pkgs.ts/ui/chat-page/src/blocks.ts`。

```ts
interface Block {
  kind: string;                        // 开放字符串，插件可自造
  id: string;                          // 声称「同一条消息内唯一」
  data: Record<string, unknown>;
}
interface WireMessage {
  role: "user" | "assistant";
  blocks: readonly Block[];
}
```

内置 kind 三个：`text / think / tool`（`shared.ts:17`），对应 data 形状
`TextBlockData / ThinkBlockData / ToolBlockData`（`shared.ts:21-43`）。
渲染器注册表在 `pkgs.ts/ui/chat-page/src/block-renderers.ts`，不认识的 kind 走 fallback（原样 JSON）。

**这里要先纠正任务 body：`WireMessage` 早已不是 `{role, text}`。** ##499 已经改成 Block 列表
（`shared.ts:3-5` 头注、`blocks.ts:1-9`）。body 里那句「现在只有 {role,text}，装不下 tool call」
依据的是旧代码。

### 4.3 `WireMessage` 的真实局限（这才是 ##498 卡住的点）

尽管线上已经是 Block，仍然装不下/装不全下面的东西：

1. **think 是死路**：`toBlocks` 有 `reasoning-delta → think` 分支（`blocks.ts:50-61`），
   `BUILTIN_BLOCK_KINDS` 也声明了 `think`、渲染器也注册了，但**没有任何生产路径产 reasoning**：
   - `SessionDelta` 联合里没有 reasoning 分支（`pkgs.ts/agent/session/src/types.ts:89-104`）；
   - provider 明确丢弃 reasoning part（`pkgs.ts/model/provider/src/openai.ts:143-146`）；
   - `wireOf` 的输入 `eventsOfMessage` 只产 `text-delta` / `tool-call`（`blocks.ts:162-172`）。
   结论：思考过程**既不落盘也不上 UI**，think 渲染器目前只被单元测试覆盖。
2. **tool 参数被压成显示字符串**：`ToolBlockData.args` 是 `argsText()` 的 JSON 串再截 120 字符
   （`blocks.ts:204-213`、`SUMMARY_MAX=120` 在 `blocks.ts:27`）。结构化参数、完整输出被截断后的 summary、
   error 与真实工具调用共用 `kind:"tool"`（`name:"error"`）——**语义混在一块**。
   要「重放 / 编辑工具调用」必须回到底层 `ChatMessage.data.tool`，线上拿不回来。
3. **role 被压成两种**：system 丢弃、tool-result 就地折叠进上一个 tool block
   （`blocks.ts:131-157`）。若会话第一条就是 tool-result，会凭空造一条 `role:"assistant"`
   的消息（`blocks.ts:141-151`），角色信息失真。
4. **mentions / at / seq 不过桥**：UI 拿不到时间、拿不到 @ 信息、拿不到稳定 seq。
5. **`Block.id` 不是全局 key**：`toBlocks` 每次从 `b0` 开始编号（`blocks.ts:34, 47, 57…`），
   而 `wireOf` 对每条消息各调一次 ⇒ 不同消息的块 id 会重复。注释只说「同一条消息内唯一」，
   但实际使用（列表 key、折叠状态持久化）很容易误用。
6. **多模态没有位置**：可以自造 `kind:"image"`，但 `data` schema 未定，且 fallback 会把
   base64 原样塞进 `<details>`。

### 4.4 怎么扩：三种可选路线（不兼容旧数据，可以任选）

前提变化：**旧数据不用管，所以不必再「只加字段不换形状」。**

| 路线 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A. 扩 Block** | 保留归一化层。`ToolBlockData` 增 `input: unknown`（结构化参数）、`state` 增 `"pending"`；新增 `kind: "notice" / "attachment"`；think 接上 reasoning delta | UI 仍然只认 Block，边界干净；插件仍可自造 kind | 显示字段与结构字段双份，可能漂移；主进程要维护映射表 |
| **B. 线上直传 ChatMessage** | `WireMessage` 直接换成 `Omit<ChatMessage,"seq"|"at">`（或加回 seq/at），renderer 按 `type/data` 渲染 | 零信息损失、无映射层、与落盘同形 | renderer 绑定 session 的 `type` 词表；显示友好的 summary 要 renderer 自己算；插件自造 type 需要注册机制 |
| **C. 混合** | Block 上加 `source?: ChatMessage`（原始载荷），显示字段继续保留 | 既能显示又能重放/编辑 | 体积翻倍（工具输出双份），两个真相可能不一致 |

**倾向（建议，待用户裁）**：短期用 **A**（改动最小，保持 ##499 的边界）；如果接下来要做
「工具调用可编辑 / 可重放」或「消息导出」，直接跳到 **B** —— 反正不迁移旧数据，晚换不如早换。
**不建议 C**：双真相是 bug 温床。

另外无论选哪条，**thinking 必须先在生产链路上打通**（provider 消费 reasoning part →
`SessionDelta` 加分支 → `wireOf` 映射），否则 `think` 块就是一张空头支票。

---

## 五、会话组织：切分、标题、计数

### 5.1 消息文件怎么切

- 一个会话一个目录；目录内**多个桶**，按 **16 MB** 切，不按天、不按轮（`types.ts:1-12`）。
- 为什么按大小：曾实测 181 MB 单文件把 tail/grep 拖慢（`types.ts:44-47` 注释）。按天仍可能被
  一次长跑撑爆。
- 单桶上界是构造参数 `maxBucketBytes`，宿主可调；chat 目前用缺省（`apps/chat/sessions.ts:241`
  只传 `dir`）。

### 5.2 标题

`meta.json.title`，首条用户消息的前 20 字（空白压一格，超长加 `…`，空则保持「新会话」），
只在 `title === "新会话"` 时写入一次（`sessions.ts:499,527-530`）。之后不随对话更新，
也没有重命名入口。

### 5.3 `messageCount`：投影，而且现在不准

- **语义未定义**：写入时 += `session.messages.length` 的增量（`sessions.ts:496-501`），
  也就是把 system / user / trace / tool-call / tool-result / conclusion **全部算进去**。
  而新会话的第一轮会连带把 system 也算进来（system 是打开会话时 append 的）。
  ⇒ 同样是「一问一答」，有没有 system、有没有 trace，计数不同。
- **没有消费者**：全仓 `rg messageCount` 只命中 `sessions.ts` 自己（写、读、默认）。
  会话列表用的是文件系统扫描（`botStore.sessionsOf`），不是这个数。
- **不会自愈**：只增量累加，外部删桶 / 手工改文件后不会重算。

**判据**：删掉 `messageCount` 能从桶重算 ⇒ 它是投影。建议将来要么删掉，要么定义为
「桶内全部 entry 数」并由 store 在打开时重算；现在两个都没有。

### 5.4 用量（tokens / 轮数 / 花费）：不是投影，是丢失

`SessionSnapshot.usage`（`TokenUsage`：`inputTokens / outputTokens / turns / cacheReadTokens?`）
只在**内存**里（`pkgs.ts/agent/session/src/session.ts:97,212-217`），不写进任何文件；
`apps/chat` 的 `lastStep`（底部指标条的「上一步」）也是进程内 `Map`（`sessions.ts:138`）。

后果：**重启后 `metrics.turns` 归零**，尽管消息还在；底部指标条全部为空。
这不属于「可重算的投影」——桶里没有每条消息的 usage，删了就真没了。

### 5.5 系统提示词的注入时机

`instructions` 只在**新建会话**时写成一条 `role:"system"` 消息，而且仅当
`initialMessages.length === 0`（`sessions.ts:250-253`）。之后：

- 改 `bot.instructions` ⇒ `updateBot` 会丢掉打开缓存（`sessions.ts:431-434`），重开时历史非空，
  **不会再追加新 system** ⇒ 旧指令继续生效，改动静默失效。
- 改 `bot.model` 会通过 `opened()` 重新装 LLM（`sessions.ts:237-245`），这个生效。

这与 persona 设计里「改人物 = 所有引用者统一变（下一轮生效）」的语义相悖，记录为第八节不一致项。

---

## 六、真源 / 投影表

判据：**删掉投影能重新算出来；删掉真源就完了。**

| 东西 | 位置 | 性质 | 谁写 | 删了会怎样 |
|---|---|---|---|---|
| 消息 | `sessions/chat/<id>/*.jsonl` | **真源** | session → jsonl store | 不可恢复 |
| 会话归属 | `sessions/chat/<id>/bot.json` | **真源**（归属事实） | `botStore.assign()` | 会话变孤儿：UI 扫不到，但消息还在 |
| 会话身份（id/title/createdAt） | `sessions/chat/<id>/meta.json` | **真源** | apps/chat `writeMeta` | `readMeta` 返回 null ⇒ 会话打不开 |
| bot 身份 | `bots/<id>/bot.json` | **真源** | bot store `save()` | 丢 bot；其会话变孤儿 |
| `meta.model` | meta.json 字段 | 投影（缓存） | 打开会话时按 `bot.model` 重写 | 可重算（真源是 `bot.model`） |
| `meta.messageCount` | meta.json 字段 | 投影（应可重算） | 增量累加 | 应可数桶重算；当前语义不明 |
| `meta.updatedAt` | meta.json 字段 | 投影（最近一次 send） | apps/chat | 可从桶末条 `at` 重算 |
| `primarySessionId` | bot.json 字段 | **指针 / 缓存**，非归属事实 | `bot.primary()` | 丢失 ⇒ 下次 `primary()` 新建会话（旧会话变孤儿，但可经归属扫回） |
| 桶索引 `index.json` | 会话目录 | 投影（可重建） | jsonl store | 扫桶重建 |
| 桶文件名里的时间 | 文件名 | 提示，非真值 | jsonl store | 桶内首尾行说了算 |
| token 用量 / turns | 仅内存 | **既非真源也非投影（丢失）** | session / apps/chat | 重启归零，无法重算 |
| `lastStep`（上一步指标） | 仅内存 | 运行时投影 | apps/chat | 归零（可接受） |
| 当前选中 bot | `chat-ui.json` | UI 状态 | apps/chat | 回落列表第一个 |
| `BotView.sessionCount` | 内存 | 投影（扫目录） | apps/chat | 重算 |
| `needsModel` | 内存 | 读兼容标记（从不落盘） | bot store 读 | 重算 |
| `WireMessage` / `Block` | 内存 / 线上 | 投影（显示用） | `blocks.ts` `wireOf` | 从 `ChatMessage` 重算 |
| `ChatSnapshot` | 内存 / 线上 | 投影（整页视图） | apps/chat | 重算 |

**一句话**：磁盘上真正的真源只有三样 —— **消息桶、会话归属、两份身份文件（bot.json / meta.json）**；
其余都能丢，唯独用量（5.4）目前既丢了又算不回来。

---

## 七、`schemaVersion`：结论「不加」

### 7.1 现状

全仓 `rg 'schemaVersion|schema_version'`（排除 node_modules/dist）**零命中**。目前没有任何版本标记。

### 7.2 结论与理由

**不加。** 依据用户 2026-11-02 的裁定：

- 不做数据迁移，开发以内存 app 为主，快速迭代，废弃旧东西；
- 没有外部消费者、没有真实用户数据；
- 加了版本号就要维护「读旧版 → 迁移」的分支，那是给不存在的存量付成本；
- 改形状时，**同一个 PR 里改齐读写方**即可；发现不认识的字段就让它报错，比静默兼容更安全。

### 7.3 这个前提什么时候失效（重新考虑版本号的触发条件）

出现任意一条，就该回来把版本号加上：

1. 有真实用户在用（磁盘上有舍不得丢的对话）；
2. 有本仓库之外的消费者（导出工具 / 同步 / 另一个 app 读这些文件）；
3. 需要跨机器 / 跨版本共享数据（例如 bot 的 `diy://` 引用）；
4. 出现「新旧代码必须同时在线」的部署形态（热升级 / 多实例）。

### 7.4 如果将来要加，怎么加（留给未来的自己）

- 加在**信封文件**顶层：`bot.json` 与 `session/meta.json` 各一个 `schemaVersion: 1`（整数）。
- **不加在 jsonl 桶的每一行**：`parseMessage` 用 `rejectUnknown` 拒绝未知键（`message.ts:41-43`），
  一行一条 entry 的结构里混版本行还会打断 seq 连续性。消息格式版本由同目录 `meta.json` 承载
  （一个会话目录一份）。
- `index.json` 不加（可重建投影，重建时以桶为准）。
- 读取策略：缺失 = 1；大于当前支持版本 ⇒ 拒绝打开；小于 ⇒ 走迁移链（到时再写）。

---

## 八、实现与契约 / 直觉不一致的地方（只记录，不修）

| # | 现象 | 证据 | 影响 |
|---|---|---|---|
| 1 | 任务 body 说 `WireMessage` 是 `{role,text}` | 实际早已是 Block 列表：`chat-page/src/shared.ts:45-48`、`blocks.ts:131` | body 过期；按它写文档会写错 |
| 2 | body 表把会话归属写成 `sessions/<id>/bot.json` | 实际是 `$DIY_HOME/sessions/chat/<id>/bot.json`（`sessions.ts:127,129`） | 路径少一级 |
| 3 | body 表没有列 `index.json`、桶文件、`chat-ui.json` | `session-store-jsonl/src/types.ts:1-12`、`sessions.ts:57-59` | 表格不完整 |
| 4 | `think` 块是死代码 | 渲染器已注册（`block-renderers.ts:28`），但无生产路径产 reasoning（`session/types.ts:89-104`、`openai.ts:143-146`、`blocks.ts:162-172`） | UI 里永远看不到思考过程 |
| 5 | `Block.id` 注释说「稳定」，实际每条消息从 `b0` 重编 | `blocks.ts:34,47`，`wireOf` 每条消息调一次 `toBlocks`（`blocks.ts:152`） | 跨消息 id 重复，不能当全局 key |
| 6 | `error` 与真实工具调用共用 `kind:"tool"` | `blocks.ts:100-111`、`141-151` | 语义混同，UI 无法区分 |
| 7 | `messageCount` 语义不明且无人消费 | 只增不减（`sessions.ts:496-501`），全仓无读取方 | 数字不准也无人发现 |
| 8 | 用量不落盘，重启 `turns` 归零 | `session.ts:97,212-217`；`sessions.ts:138` | 与「消息还在」矛盾；且不可重算 |
| 9 | 改 `bot.instructions` 对已存在会话不生效 | 只在 `initialMessages.length === 0` 时注入（`sessions.ts:250-253`）；`updateBot` 只是丢缓存（`sessions.ts:431-434`） | 静默失效，与 persona 语义相悖 |
| 10 | 删 bot 级联删会话是**应用层**策略 | 应用层删目录（`sessions.ts:443-451`）；bot 包 `remove` 只删身份（`store-fs.ts:123-127`） | 契约里要写清「级联归谁」，否则换宿主行为会变 |
| 11 | `primarySessionId`（bot 侧）与 `bot.json`（会话侧）双写，可能不一致 | 权威在会话侧（`bot.ts:54`），指针用于免扫（`bot.ts:30-36`） | 指针失效时会新建会话，旧会话变孤儿 |
| 12 | `meta.model` 形式必填但只是缓存 | `readMeta` 缺它返回 null（`sessions.ts:534-539`） | 缓存字段缺失反而导致会话打不开 |
| 13 | `WireMessage` 不带 `at` / `seq` / `mentions` | `shared.ts:45-48` | UI 无法显示时间 / 稳定排序 / @ 信息 |
| 14 | `data` 槽位「不解释 schema」，但 `tool-call` 的 `data.tool` 被强制校验 | `message.ts:186-197` | 文档里「不解释」要改成「只解释这一个」 |

---

## 九、待定（不编）

1. `messageCount` 的最终定义：删掉 / 改成可重算的桶行数 / 改成「用户可见消息数」？
2. 用量（tokens / turns / cost）落不落盘？落的话放 `meta.json`（简单，但每步写一次）还是
   追加一条 `type:"usage"` 的特殊 entry（能按步回放，但 `MessageType` 要加分支）？
3. `primarySessionId` 指针留不留？去掉就得每次扫目录，留下就得处理不一致。
4. `tools` 挂在 bot（身份级）还是会话级？
5. 会话标题：保留「首条消息截 20 字」还是要重命名入口 / 模型摘要？
6. `think` 要打通到哪一层：只上 UI 不落盘，还是也进桶（会撑大文件，且上游多要求
   reasoning_content 回传）？
7. `WireMessage` 走 A / B / C 哪条路线（4.4）？

---

## 十、核实清单（本文所有「实际是」的依据）

```
pkgs.ts/agent/bot/src/types.ts:20-45,47-58,60-88    BotConfig / BotSessionRef / BotStore
pkgs.ts/agent/bot/src/store-fs.ts:1-13,24,100-196  落盘布局 / persistable / 读兼容
pkgs.ts/agent/bot/src/bot.ts:30-59                 primary() 与指针写回
pkgs.ts/agent/bot/src/persona.ts                   PersonaDef（bot 的字段来源）
pkgs.ts/agent/session/src/types.ts:28,42-68,78-104  MessageType / ChatMessage / SessionDelta
pkgs.ts/agent/session/src/message.ts:49-197        parseMessage / data 槽位 / data.tool
pkgs.ts/agent/session/src/session.ts:97,143-218    send 里追加什么 / usage 内存
pkgs.ts/agent/store-jsonl/src/types.ts:1-47 分桶契约
pkgs.ts/agent/store-jsonl/src/store.ts:1-24,35,84-160,398-410  切桶 / index / serialize
pkgs.ts/ui/chat-page/src/shared.ts:7-48,84-121                          Block / WireMessage / BotView / ChatSnapshot
pkgs.ts/ui/chat-page/src/blocks.ts:33-172                               归一化 / wireOf
pkgs.ts/ui/chat-page/src/block-renderers.ts:24-33                       渲染器注册
pkgs.ts/model/provider/src/openai.ts:120-155                       provider 消费 / 丢弃哪些 part
apps/chat/sessions.ts:46-59,127-241,431-501,527-550                  SessionMeta / 目录 / 注入 / 计数 / 标题
```
