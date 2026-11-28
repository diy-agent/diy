# bot / 实例 / 工具 bot / 会议 —— 领域模型（2026-11-27 v2）

> v1 提过「人设 → bot → 实例」三层，用户裁定**不拆 persona 层**：人设就是 bot profile 的指令。
> 本版按澄清后的两层重写。
>
> ⚠️ **已被 `2026-11-28-bot-session-domain.md` 取代**（2026-11-28）：本文「实例 = profile × room」
> 与后来定的「一个领域对象 1:1 自己的 bot、bot 只有一条 session」冲突，以确认稿为准。本文件留作推理过程。

## 一、只有两层

```
bot profile（配置）        指令 + 名字 + 颜色 + 模型 + runtime
      │  在某个 room 里出现
      ▼
bot 实例（= profile × room） + session log
```

- **profile 是配置**，不是实例：全局助手、项目 bot、任务 bot 都是 profile，按 domain 归属（全局 / 项目 / 任务）。
- **实例是运行体**：room 里的那个 bot。它拥有自己的 session log —— 「任务 bot」就是「某 bot 实例 + 它的 session log」，没有别的概念。
- **没有 persona_ref**：人设 = profile 自己的 `instructions`，不单列一层。
- **没有 primary_flag**：一个 room 的 bot 就是该 profile 的实例，不存在主/次，也不可改。

## 二、两种 bot kind

| kind | 是什么 | 特征 |
|---|---|---|
| 沟通型 | 参与对话的 bot | 出现在成员列表、可 @、有 session log |
| **工具型** | job 之类 | **不参与沟通、不可 @**，只被调用 |

工具型不需要 session log 意义上的"对话"，它只是被跑一下。

## 三、room 与 bot 的关系（现状问题）

现在 `bot_roles` 里一个 type 下的**所有** profile 都会成为该 type 每个 room 的成员：

```ts
// app.ts
function membersOf(type) { return membersOfType(listRoles(), type); }  // = roles.filter(r => r.type === type)
```

于是 proj:diy 里有 4 个 bot（项目助手 / diy / cops / 小满），每个 task room 有 3 个。

**目标**：room 常态**只有自己的 bot**（任务 room 就任务 bot 一个），不常驻一堆不说话的 bot。

## 四、会议：两种形态（待拍板）

前提相同：room 常态只有自己的 bot。「开会」是把**已有的 bot 实例**拉进来，不 new 新 bot。

### 甲：私聊 room + 独立会议室

任务/项目 room 本身是私聊会话。点「开会」→ UI 切到本任务的**会议室**（另一个实体）→ 拉其他任务/项目 bot、全局助手进来 → 开完关闭，回到私聊 room。

- 好处：私聊记录与会议记录在实体层面分开；会议有明确起止和独立归档
- 代价：多一层实体 + UI 切换；跨 room 引用消息要处理

### 乙：同一个 room，临时加人

room 不区分私聊/会议。默认只有自己的 bot；点开会 → 在同一 room 拉人 → 开完 → 删掉其他参会人，room 回到只有自己。

- 好处：少一层实体，不用切 UI，实现简单
- 代价：room 的成员是动态的；历史消息的"当时谁在场"要靠快照

### 共同点（与形态无关）

既然 session 是**按 bot 走的**（一个 bot 一条连续 session，消息标 room），会议发言本来就进各 bot 自己的 session；
两种形态的差别只在「会议是不是一个独立 room 实体」，不在开销。

## 五、命名（2026-11-27 已落地）

| 旧 | 新 | 说明 |
|---|---|---|
| `BotRole` | **`BotProfile`** | 协议类型 |
| `RoleConfig` | **`BotProfileDefaults`** | 类型默认设置 |
| `bot_roles` | **`bot_profiles`** | 表（旧库启动自动 `ALTER TABLE ... RENAME`） |
| `role_config` | **`bot_profile_defaults`** | 表 |
| `session_state.bot_role_id` | **`bot_profile_id`** | 列（两代旧名都能迁） |
| `roles.*` RPC | **`botProfiles.*`** | 客户端同步 |
| `/settings/roles` | **`/settings/bots`** | 地址 |
| `RolesView.tsx` | **`BotProfilesView.tsx`** | 文件 |
| `roles.ts` | **`botProfiles.ts`** | 文件 |

中文显示名：页签与页面一律 **「机器人」**，类型默认那一项叫 **「默认设置」**（不再出现「角色 / profile / 实例」这类术语）。

## 六、待落地

1. 去掉 `primary_flag`（表 / 协议 / UI / 派生逻辑）—— 和下面第 4 条是同一件事
2. bot profile 按 domain 归属（全局 / 项目 / 任务），指令内联
3. 加 bot `kind`（沟通型 / 工具型），工具型不进成员列表、不可 @
4. room 成员从「type 派生全部」改为「默认只有自己的 bot」
5. 会议 = 同 room 状态切换（开会拉人、散会删人）
