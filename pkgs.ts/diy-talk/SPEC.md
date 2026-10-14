# @diy/talk —— 对话容器内核：事件 / 锚点 / 反应原语 + role 铁律

> **本文档状态：意图测试为唯一真源** —— `tests/intent.talk.test.ts`（R1–R7）已覆盖本 SPEC 全部可验证行为。
> 本文保留作**决策记录与索引**：新增需求先写意图测试，再补实现。
>
> 范围：本包是「对话容器与工作流容器**共用的地基**」（##311 序列第 1 个原子任务 ##312 + 装配器 ##314）。
> ##314 的装配器决策见 §7（需求真源 `tests/intent.assemble.test.ts` A1–A6）。
> 依据：##166 §一 结论 5/10/11/12、§3.5 role 表、§7.4 痛点、§10.2 统一原语、§12.4「存储上是 thread，聊天室是它的渲染」。
> 本次收口：review1（mimo2.6）四条 + review2（deepseek-4.1-flash）六条，采纳见文末「评审收口」。

## 目录

- [1. 需求（R1–R7）](#1-需求r1r7)
- [2. 形状](#2-形状)
- [3. 决策记录](#3-决策记录)
- [4. 明确不做](#4-明确不做)
- [5. 边界（谁接在后面）](#5-边界谁接在后面)
- [6. 评审收口](#6-评审收口)
- [7. 装配器（##314）](#7-装配器314)

---

## 1. 需求（R1–R7）

| # | 需求（人类语言） | 用例位置 |
|---|---|---|
| R1 | **role 铁律**：自己的内容 → `assistant`；他人的发言 → `user`（**绝不能是 `assistant`**）；文档资料对谁都算 `user`；他人的 tool/thinking 不得进入装配；**非法来源类别报错**（不静默降级） | `describe('R1 …')` |
| R2 | **doc-range 钉 revision**：`{ revisionId, offset, quote }` 三字段缺一不可；`pinsRevision` **三态**判是否本修订；**锚点构造器一律自检** | `describe('R2 …')` |
| R3 | **JSON round-trip 恒等**；键序固定（落盘 diff 友好）；`compact` 单行输出（jsonl 用） | `describe('R3 …')` |
| R4 | **引用完整性**：悬空 `replyTo` / 指向自己 / `id` 重号 / **异锚点混串** / **事件 `causes` 自指·重复** 一律报错 | `describe('R4 …')` |
| R5 | **非法 anchor 一律拒绝**（未知 type、缺 `data`、字段类型错、**未知字段**），带点路径定位 | `describe('R5 …')` |
| R6 | **反序列化边界**：非 JSON、缺字段（含 `replyTo` 键缺失）、**未知字段（写侧拒绝 / 读侧可选放行）**、**`at` 非 ISO** 一律报错 | `describe('R6 …')` |
| R7 | **零依赖纯内核**：不 import `node:fs` / `electron` / `@diy/app`，不取时间 | `describe('R7 …')` |

## 2. 形状

形状遵循仓库 `rule.discriminated-union`：**判别键同级只放所有分支共有的字段，分支私有数据进 `data`**。
锚点没有公共字段 ⇒ 每个分支就是 `{ type, data }` —— 于是「任何类型化节点都是 `{ type, …, data }`」保持自相似，
通用序列化 / 校验 / UI 只认 `.data` 即可。

```ts
Anchor =
  | { type: 'message';    data: { messageId: string } }                                // 模式 1/2
  | { type: 'doc-range';  data: { revisionId: string; offset: number; quote: string } } // 模式 3
  | { type: 'task-field'; data: { field: string } }
  | { type: 'node';       data: { nodeId: string } }                                    // 工作流泳道节点

Event    = { id, author, anchor, content, causes, at }        // 容器无关的泛化记录（##166 §10.2）
Reaction = { id, author, turnId, target, replyTo, content, at } // 对话侧特化（结论 10）
role     = 自己 → 'assistant'；他人发言 / 资料 → 'user'
```

- **`at` 一律由调用方传入**（ISO-8601 字符串，接受 `YYYY-MM-DDTHH:mm:ss[.sss][Z|±HH:mm]`）：本包不取时间 ⇒
  可重放、可测试、可脱离 Node 运行。**格式在入口校验**（「时间是事实，格式也是事实」）。
  **边界（决策 12）**：只校验 ISO **形态**（数字位数 + 分隔符），**不校验日历合法性** ——
  `2026-99-99T99:99:99Z` 之类也放行；「该时刻是否真实存在」属语义，归宿主（##319）。
- `causes` 缺省 `[]`（「没有触发谁」只有这一种表示，缺省不丢信息）；**不得自指或重复**。
  其余字段缺失一律报错 —— `at` 没有自然缺省，时间是事实，不能凭空补。
- `Reaction.replyTo` **必须显式出现**（`null` = 起头）：键缺失不能被静默当成「起头」，否则丢的是回复链本身。
- **thread = 同一锚点下的发言集合**：`parseThread` / `assertThreadRefs` 要求所有 `target` 同锚点。
- **未知字段**：写侧 / 读侧**缺省一律拒绝**（形状封闭）；读侧前向兼容显式传 `{ allowUnknown: true }`。
  **边界（决策 11）**：`allowUnknown` 是**只读检查闸** —— 只让解析不报错，**不保留**未知字段；
  读到的对象**不得**再经本包 `*ToJson` 落盘（否则读-改-写一次就把新字段抹了）。读写往返不丢字段归宿主。
- 校验函数一律返回**规范化后的新对象**（只含已知字段、键序固定）⇒ 序列化天然稳定，不受调用方书写顺序影响。

## 3. 决策记录

1. **锚点统一原语，而非三套实现**（结论 10）。三模式 / 两容器只换 `anchor.type`：
   模式 1/2 用 `message`、模式 3 用 `doc-range`、工作流用 `node`。这就是「工作流 ≡ 对话」的字面落地（§10.2）。
2. **`doc-range` 必钉 `revisionId`，且必须带 `quote`**（结论 11）。只存 `offset` 会随正文漂移；
   `quote` 是漂移后 fuzzy 校正的唯一凭据，也让「这条批注针对哪一版」永远明确。
   **fuzzy 校正本身不在本包做**：它需要当前版正文，而正文是宿主的（本包不认识文件系统）——
   本包的职责是**不丢证据**，校正动作归装配 / 宿主（##314 / ##319）。
3. **`replyTo` 是结构化寻址**（§7.4 痛点 2）。案例里轮次靠肉眼对齐编号 → 人被逼纠正「最后一条是 R19，不是你说的 R21」。
   **引 id 才能被机器校验（悬空即报错），引文字只能靠人对齐。** 故 `replyTo` 是 `string | null` 且必须是本 thread 内的 id。
4. **`Reaction` 与 `Event` 并存不是重复**：前者是对话侧特化（带 `turnId` + 回复链），后者是容器无关泛化（带 `causes`，
   为工作流的「触发谁」准备，见 §10.2）。**`Reaction` 可单向投影为 `Event`**（丢掉 `turnId` 与回复链 `replyTo`），
   反向不成立（`Event` 无 `turnId` 无从补）—— 故**不强行合成一个类型**（review2 意见 6：原「可互相投影」是过度承诺）。
5. **role 铁律不做例外开关**（结论 5）。「例外仅限真正共用同一 API session 的连续轮次」，DIY 不属此例；
   留一个参数就等于留一条把他人发言标成 `assistant` 的后门。将来真有共用 session 的形态，应是**显式的新 `kind`**，
   由意图测试先定义，而不是一个布尔开关。`assemblyRole` 对非法 `kind` **抛错**（review1 意见 1），不得静默降级。
6. **诊断一律不静默**（沿用 `@diy/template` 的教训）：非法 anchor / 悬空 replyTo / role 违规全部抛 `TalkError`（带 `code` + `path`）。
   静默丢弃的后果是「装配出来的历史少一条反驳」，而这正是决策线断掉最难发现的形态。
   **「绝不静默丢弃」的精确口径**（review2 意见 4 收口）：**已识别字段的非法值 / 引用悬空 / 未知字段**一律报错；
   未知字段写侧拒绝（防调用方数据被抹）、读侧缺省拒绝（可 `allowUnknown` 放行做前向兼容）。
7. **`pinsRevision` 三态而非 `isOnRevision` 二态**（review2 意见 1）：非 `doc-range` 锚点不参与修订轴，返回 `null`
   而非 `true` —— 旧的「恒 true」会被误当「本修订批注」过滤器，把 message / task-field / node 全纳入。
8. **thread 必须同锚点**（review2 意见 2）：否则「所有不同对象的争论全串在一条时间线上」在存储层就已合法
   （§7.4 痛点 4，正是本包要干掉的状态）。`mixed-anchor` 在写 / 读侧都拦。
9. **`at` 校验 ISO-8601**（review1 意见 2）：格式也是事实，下游排序 / 比较依赖它；非 ISO 文本入口即拒。
10. **`eventToJson` / `reactionToJson` / `threadToJson` 支持 `{ compact: true }`**（review1 意见 4）：
    缺省缩进多行（人读 / diff），compact 单行供 ##319 拼 jsonl；两者 round-trip 等价。
11. **`allowUnknown` 是只读检查闸，不保留未知字段**（review3 意见 1）：它只让读侧解析不报错，
    返回的仍是「只含已知字段」的规范化对象 —— 与 R3「键序固定 + 只含已知字段」一致。
    因此**不**承担「读写往返保真」：读-改-写要保未知字段，是宿主（##319）的职责（自行保留原始 JSON），
    本包明写此边界而非静默丢弃（宿主若误用，是「用了只读闸去写」，非本包违约）。
12. **`at` 只校 ISO 形态、不校日历合法性**（review3 意见 2）：内核保持轻、不引 `Date`
    （零依赖 + 可脱离 Node 运行）。词法成立即放行；语义（时刻真实存在）归宿主。
13. **`assertThreadRefs` 入口自检**（review3 意见 3）：入参逐条经 `parseReaction` 规整
    （已解析对象重解析幂等），故调用方无需先自行 parse；`replyTo` 类型错报 `invalid-reaction`，
    不再被下游误报成 `dangling-reply`（类型错 = 类型错、结构错 = 结构错）。

## 4. 明确不做

- **不做存储**：不 import `node:fs`，不认识 task 目录、不决定落地格式与版本号（归 ##319 宿主接入）。
- **不做存储 / 不碰 LLM SDK**：本包的装配（§7）只把结构渲染成纯 `Message[]` 数据，不 import 任何
  LLM SDK、不拼 prompt 的具体形状 —— 输出形状由宿主映射。
- **不做工作流**：泳道单指针、guard 求值、轨迹折线归 ##313（`@diy/flow`，依赖本包）。
- **不做 fuzzy 搜索算法**（见决策 2）。
- **不做插件 / 可见性规则 / 通知投递**（§13.2 的五个插件槽与 §10.5 待决 7 的调度，均属后续任务）。

## 5. 边界（谁接在后面）

| 后续 | 接什么 |
|---|---|
| ##313 `@diy/flow` | 用 `anchor.type = 'node'` 表达泳道节点；容器不变量（单指针 / 可回退）在那边 |
| ##314 装配器 | **已完成**（本包含 `src/assemble.ts`）；消费 `Reaction[]` / `Event[]` + `assemblyRole`，产出 `Message[]`；三种装配策略 + 注入式窗口钩子 |
| ##319 宿主接入 | 事件流落地（jsonl）+ `diy flow` CLI 域 + 提示词装配；本包 `*ToJson` 负责**校验 / 规范化**（`compact` 供 jsonl），行分隔与文件布局由 ##319 定 |

## 6. 评审收口

- **review1**：意见 1（非法 kind）✓采纳；意见 2（ISO `at`）✓采纳；意见 3（causes 自指·重复）✓采纳，
  **前向 replyTo 顺序约束 ✗驳回**（见 `tests/intent.talk.test.ts` R4 与探针 `t312-reject-forward-reply`）；意见 4（多行 vs jsonl）✓采纳（加 `compact`）。
- **review2**：意见 1（`pinsRevision` 三态）✓采纳；意见 2（同锚点）✓采纳；意见 3（`replyTo` 显式）✓采纳；
  意见 4（未知字段）✓采纳（写侧拒绝 + 读侧 `allowUnknown`）；意见 5（构造器自检）✓采纳；意见 6（投影措辞）✓采纳（改为单向）。
- **review3**（收口复审，PR 已准予）：意见 1（`allowUnknown` 只读、不保留未知字段）✓采纳（决策 11：
  文档写明只读闸边界）；意见 2（ISO 只校形态）✓采纳（决策 12：明写不校日历合法性）；意见 3（`assertThreadRefs`
  入口自检）✓采纳（决策 13：逐条 `parseReaction`，类型错报 `invalid-reaction`）。

---

## 7. 装配器（##314）

> `assemble({ sources, strategy, window, selfId }) → Message[]`；需求真源 `tests/intent.assemble.test.ts`（A1–A6）。

把「多源 + 投影 + 窗口」装配成一次 LLM 请求的 `messages[]` —— ##166 §一 结论 4「**模式 = 一份装配策略，
不是三套实现**」的代码化（§3.1 那张图）。

**输入（多源）**：`Source` 是判别联合 `{ type, data }`，每源内容**同质**（源类型定 role 轴）：

```ts
Source =
  | { type: 'reactions'; data: { reactions: readonly Reaction[] } }   // 发言线 → kind=speech
  | { type: 'trace';     data: { events: readonly Event[] } }        // 私有过程 → kind=trace
  | { type: 'material';  data: { events: readonly Event[] } }        // 资料演进 → kind=material
```

**输出**：`Message = { role: 'user' | 'assistant', content: string }` —— 纯数据，宿主自行映射到 SDK。

**三条内置策略**（`STRATEGIES`；也可传自定义 `AssemblyStrategy` 对象）：

| 策略 | 选源 + 投影 | 对应模式 |
|---|---|---|
| `full` | 全收（含**自己的**过程） | 模式 1 全量档案 |
| `text-only` | 去 `trace`（tool / thinking），保留发言（含 `replyTo` 寻址）与资料 | 模式 2 邮件组型 |
| `changes-only` | 只留 `material`（文档修订）+ 钉在 `doc-range` 上的发言（批注线） | 模式 3 文档型 |

**决策记录**：

1. **内核不变量先于策略**：**他人的过程产物（tool / thinking）永不进入装配** —— 连 `full` 也不。
   故 `full` 与 `text-only` 的差别是「是否带上**自己的**过程」，不是「是否暴露别人的过程」（§3.5 role 表 + 结论 14）。
2. **role 翻译复用 `role.ts`**（不在装配器重写）：每条内容经 `assemblyRole` 得 role，再以 `assertRoleAssignments`
   复核铁律 —— 他人发言绝不可能被装配成 `assistant`（结论 5）。
3. **存结构、装配时渲染**（结论 13）：输入是 `Reaction` / `Event` 结构，渲染（作者前缀 + `[回复 <id>]` 寻址）
   只发生在装配时；缺省渲染 `renderItem`，策略可换 `render`。
4. **窗口 / 摘要是注入式钩子**（§五「真正的取舍点」）：`window: (Message[]) => Message[]` 由**宿主**给，
   内核不自作主张 —— 渲染之后再交给它，可裁剪、可前插摘要。**排序同理归宿主**（内核保序，不替宿主排）。
5. **不碰 LLM SDK**：输出是纯 `Message[]` 数据；具体 SDK 的 message 形状由宿主映射（##319）。
