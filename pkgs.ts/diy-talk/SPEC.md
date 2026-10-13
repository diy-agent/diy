# @diy/talk —— 对话容器内核：事件 / 锚点 / 反应原语 + role 铁律

> **本文档状态：意图测试为唯一真源** —— `tests/intent.talk.test.ts`（R1–R7）已覆盖本 SPEC 全部可验证行为。
> 本文保留作**决策记录与索引**：新增需求先写意图测试，再补实现。
>
> 范围：本包是「对话容器与工作流容器**共用的地基**」的第一块（##311 序列第 1 个原子任务，##312）。
> 依据：##166 §一 结论 5/10/11/12、§3.5 role 表、§7.4 痛点、§10.2 统一原语、§12.4「存储上是 thread，聊天室是它的渲染」。

## 目录

- [1. 需求（R1–R7）](#1-需求r1r7)
- [2. 形状](#2-形状)
- [3. 决策记录](#3-决策记录)
- [4. 明确不做](#4-明确不做)
- [5. 边界（谁接在后面）](#5-边界谁接在后面)

---

## 1. 需求（R1–R7）

| # | 需求（人类语言） | 用例位置 |
|---|---|---|
| R1 | **role 铁律**：自己的内容 → `assistant`；他人的发言 → `user`（**绝不能是 `assistant`**）；文档资料对谁都算 `user`；他人的 tool/thinking 不得进入装配 | `describe('R1 …')` |
| R2 | **doc-range 钉 revision**：`{ revisionId, offset, quote }` 三字段缺一不可；正文改版后仍报得出「针对哪一版」 | `describe('R2 …')` |
| R3 | **JSON round-trip 恒等**；键序固定（落盘 diff 友好） | `describe('R3 …')` |
| R4 | **引用完整性**：悬空 `replyTo` / 指向自己 / `id` 重号一律报错 | `describe('R4 …')` |
| R5 | **非法 anchor 一律拒绝**（未知 type、缺 `data`、字段类型错），带点路径定位 | `describe('R5 …')` |
| R6 | **反序列化边界**：非 JSON、缺字段报错；多余字段丢弃 | `describe('R6 …')` |
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

- **`at` 一律由调用方传入**（ISO 字符串）：本包不取时间 ⇒ 可重放、可测试、可脱离 Node 运行。
- `causes` 缺省 `[]`（「没有触发谁」只有这一种表示，缺省不丢信息）；其余字段缺失一律报错 ——
  `at` 没有自然缺省，时间是事实，不能凭空补。
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
   为工作流的「触发谁」准备，见 §10.2）。两者字段同源可互相投影，但**不强行合成一个类型** ——
   合成会让对话侧无谓携带 `causes`、工作流侧无谓携带 `turnId`。
5. **role 铁律不做例外开关**（结论 5）。「例外仅限真正共用同一 API session 的连续轮次」，DIY 不属此例；
   留一个参数就等于留一条把他人发言标成 `assistant` 的后门。将来真有共用 session 的形态，应是**显式的新 `kind`**，
   由意图测试先定义，而不是一个布尔开关。
6. **诊断一律不静默**（沿用 `@diy/template` 的教训）：非法 anchor / 悬空 replyTo / role 违规全部抛 `TalkError`（带 `code` + `path`）。
   静默丢弃的后果是「装配出来的历史少一条反驳」，而这正是决策线断掉最难发现的形态。

## 4. 明确不做

- **不做存储**：不 import `node:fs`，不认识 task 目录、不决定落地格式与版本号（归 ##319 宿主接入）。
- **不做装配**：不拼 prompt、不产出 `messages[]`、不做窗口裁剪与投影（归 ##314）。本包只给
  「一条内容该装配成哪个 role」的纯函数与断言。
- **不做工作流**：泳道单指针、guard 求值、轨迹折线归 ##313（`@diy/flow`，依赖本包）。
- **不做 fuzzy 搜索算法**（见决策 2）。
- **不做插件 / 可见性规则 / 通知投递**（§13.2 的五个插件槽与 §10.5 待决 7 的调度，均属后续任务）。

## 5. 边界（谁接在后面）

| 后续 | 接什么 |
|---|---|
| ##313 `@diy/flow` | 用 `anchor.type = 'node'` 表达泳道节点；容器不变量（单指针 / 可回退）在那边 |
| ##314 装配器 | 消费 `Reaction[]` / `Event[]` + `assemblyRole`，产出 `messages[]`；三种装配策略与窗口裁剪 |
| ##319 宿主接入 | 事件流落地（jsonl？）+ `diy flow` CLI 域 + 提示词装配；本包的 `eventToJson` / `threadToJson` 是唯一出入口 |
