# bot / session / room —— 确认稿（2026-11-28）

> **这份是唯一口径。** 取代：
> - `2026-11-28-bot-session-domain.html`（v2 设计稿，内容已收进来，仅留作推理过程）
> - `2026-11-28-bot-per-task.md`（我的草稿，方案岔路已被下面的口径否掉）
> - `2026-11-27-bot-domain-model.md` 里「实例 = profile × room」那句与本稿冲突，按本稿为准。
>
> 用户 2026-11-28：「每个领域对象 task/project 自动创建一个 bot，即一个任务就是一个独立的 bot，
> 两个任务可以沟通，不是一个 profile 对应一个 bot。不然几百个任务的信息被几个 bot 无法承载。」

## 一、六条不变量

1. 一个领域对象（task / project）**自动拥有**自己的 bot，1:1、**不可更换**（换 bot = 丢历史）
2. 每个 bot **只有一条 session**（跨 room、含 remote，都是同一份）
3. room 是**公共事件容器**：消息落 room，「谁在哪个房间说过什么」永远可查
4. 进 session 的每条内容都带来源 `{roomId, seq}`；摘要带**来源范围**
5. `entries` 是**可压缩快照**，历史真相在 room 事件流里 —— 压缩可以真删
6. 进 room 只补「**尚未消费**的事件」，读水位按房记（与 session 里留着什么无关）

## 二、数据模型

| 表 | 关键列 | 作用 | 相对现在 |
|---|---|---|---|
| `bot_profiles` | id, type, name, instructions, model… | **出生模板**（task / project 各一套） | 不动，7 行 |
| `bots` | id, profile_id, domain_type, domain_id<br>`UNIQUE(domain_type, domain_id)` | 一个领域对象一个 bot；`domain_type='global'` 那份是全局助手 | 新增（46 个 task/project → 46 行 + 1 全局） |
| `bot_sessions` | bot_id, turn, collapsed, entries, usage | 该 bot **唯一一条**上下文；entries 带来源；不存读水位 | 替代 `session_state` |
| `bot_room_cursors` | (bot_id, room_id), last_seq | 「它在每个 room 读到哪」；重启回放靠它 | 新表，从 session 拆出 |
| `bot_attendances` | (room_id, bot_id), joined_at, left_at | 「出席过」。任务/项目房恒 1 行；会议室按会议生命周期 | 替代 `room_members` |
| `entities` | id, type | room = 这里的 task / project / meeting | 不动 |
| `entity_items` | seq, entity_id, item{author.id=bot} | room 的公共事件流 | 不动 |
| `deliveries` | (room_id, message_id, bot_id), state | 「这条送到谁」，按 room 算 | 不动 |
| `turn_facts` | (bot_id, turn), room_id, ended_at, usage | 结算行；号属于 bot（连续），room_id 记「这轮发生在哪」 | 键改成 (bot_id, turn) |

### session 里一条 entry

```jsonc
{
  "source": { "roomId": "task-mwlxxv3u", "seq": 51234 },  // 来自哪条 room 事件
  "turn": 319,                 // 这个 bot 的第 N 轮，跨 room 连续
  "message": { "role": "user", "content": [ /* … */ ] },
  "at": 1795793690233
}

// 压缩摘要：来源可跨多个 room，记范围而不是单个房名
{
  "kind": "summary",
  "sources": [
    { "roomId": "task-mwlxxv3u", "fromSeq": 50800, "toSeq": 51230 },
    { "roomId": "meeting-01",   "fromSeq": 100,   "toSeq": 128 }
  ],
  "content": "A 与 B 已确定统一用 Result 类型，错误码归 API 层。"
}
```

**摘要 + 源范围是不可拆的一对** —— 只存摘要不存范围，等于把事实抹了还留下一个无法核对的说法。

## 三、为什么不能几个 bot 承载几百个任务

- **任务隔离**：几十个任务的工具输出 / 代码 / 结论挤进一份上下文，压缩只能反复丢细节，A 任务的知识变成 B 任务的噪声
- **人设冲突**：一套 instructions 不可能同时是「前端任务助手」和「后端任务助手」
- **责任边界**：这条发言是谁说的、这轮 token 算谁的、这个 worktree 是谁开的 —— 共用一个 bot 就都认不出

## 四、会议

会议室就是普通 room：把已有 bot 拉进来，**不是新建 bot**。各自 session 仍是一条，只是多了几段标着 `room=会议` 的内容；开完会删成员，**事件仍在**。

## 五、迁移（019 起）

1. **给 41 个任务房 / 5 个项目房补建 bot**：`bots` 按 task、project 各建一行（profile 取对应模板），`bot_attendances` 把每个房指向自己的 bot
2. **历史消息一个字不改**：它们标的是 `author.id=<当时那个 bot>`，历史上是谁就是谁。34 份 `session_state` **不合并** —— 不同快照的 turn 不在同一条时间线上，可能重复、摘要还可能互相矛盾
3. **用 room 事件流重建 session**：原始记录优先；事件缺失才退回「带来源范围的摘要」；最后按实际导入量落 `bot_room_cursors`
4. **读水位从 session 拆到 `bot_room_cursors`**：重启回放按房各续各的，不重复 ingest 也不漏读

## 六、还没定的两件事

1. **配置页怎么列这些 bot**：左栏只列模板 + 从任务房间进「这个任务的 bot」，还是平铺列全部（46 条会很长）
2. **模板能不能删**：老消息的 `author.id` 指着模板，删了就是「数据在、界面丢」；建议禁删，只许改名 / 改指令

## 七、随之要改的账本条

| 单元 | 变化 |
|---|---|
| `bot-per-task` | 语义定案：**自动建、1:1、不可换**，且**要回填 46 个**（不是「按需」） |
| `session-per-bot` | 定案：一条 session 跨 room，entries 带 `source`，读水位拆到 cursors |
| `drop-primary-flag` | 仍依赖 bot-per-task（`route()` 的兜底要等「一房一 bot」到位） |
| `meeting-room` | 定案：普通 room + `bot_attendances`，不新建 bot |
| `tool-bots` | 不受影响 |
