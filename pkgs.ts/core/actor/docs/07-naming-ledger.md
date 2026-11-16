# 07 · 歧义账（字段命名）

> 这是**账本**不是计划：逐条记「现状 → 代价 → 目标 → 随哪一刀改」。
> 迁自已删除的 `docs/actor-protocol-naming.md`（2026-11-15），并补上 actor 包落地后的状态。
>
> 用法：改到 room / journal / 事件相关代码前**扫一眼**，做到对应那一刀时**一起改掉**，
> 不留双写、不留兼容别名。

## 图例

| 标记 | 含义 |
|---|---|
| ✅ 已销 | actor 包落地时已按目标改完，线上已经是新名字 |
| 🔴 / 🟡 / 🟢 | 未销的严重度。🔴 = 与帧字段直接撞名或会让 UI 说出假话；🟡 = 同一个东西好几个名字；🟢 = 只是不好看 |

---

## ✅ C1 `payload` → `data`

线上一律 `data`（与事件同构）。旧写法 `payload` 全部销掉。**已随 actor 包落地**（`wire.ts`）。

## ✅ C2 `k` → `type`，`q` → `query`，回执 tag 去前缀

回执的 `query.` 前缀去掉，五个 tag（`accepted` `done` `rejected` `ok` `err`）全局唯一；
相关性由在途请求表 + 帧 `id` 决定，不靠 tag 自证。**已随 actor 包落地**（`wire.ts` `FrameSchema`）。

## ✅ C3 `routing` / `targets` 不出现在帧里

`targets` 是**摆放知识**，属 actor 声明（`fanoutQuery` 的 `targets(state, input)`）。
调用方指定 `targets` = 把 placement 泄进客户端，且必然过期。
帧上只留 `consistency?: "projection" | "owner"`（声明给下限，调用方只能升不能降）。
**已随 actor 包落地**（[05](./05-multi-target.md) §三）。

## ✅ C4 帧上的 `partial`：**已否决，别再想回来**

**曾经的写法**：`{ type: "partial", data, failures, watermark }`，用于「多目标只成了一部分」。

**否决理由**（两轴混淆，见 [02](./02-wire.md) §二）：`type` 是**执行轴**，说的是「这次调用跑成了没有」。
`ok` = 跑完了，`err` = 没跑成（参数错 / 网络断 / 库坏）。**「10 台机器里 1 台没启动」是业务结果，叫 `ok`。**
`partial` 强迫 runtime 去判「什么叫一项」「什么算失败」，而它不知道。

**代价具体化**：

- 客户端 `switch` 里 `ok` 和 `partial` 走两个分支 → 同一份业务渲染写两遍；
- 重试语义变糊：`partial` 该重试全部还是失败的？`ok` + 逐项状态时，重试就是**再问一次**；
- 这个 tag 会**蔓延**：任何「部分成功」都往协议里挤，最后协议变成业务状态机。

**替代**：`ok` + `data.items[i].state`（业务轴）+ `meta.fanout`（执行回执）。单目标不存在「部分」：
0 成功 = `err`，1 成功 = `ok`。

**落地**：`FrameSchema` 枚举里没有 `partial`；`tests/intent.wire.test.ts` 有一条断言守着
（谁说「先加回来试试」，先红这条，再回来读上面的理由）。

## 🟢 C5 `meta.fanout` 这个名字是**暂定**

它装的是「执行回执」（哪个 target 答了 / 多久 / 什么 code）。另一个候选是 `meta.receipts`
（更准：它真的只是回执，跟 fanout 这个机制解耦）。

**随哪一刀**：第一个非进程内端口（跨节点扇出）落地时定死。改名可一次性完成 ——
读它的只有 runtime 与 kind 的 `aggregate`，UI 不许读（[05](./05-multi-target.md) §四）。

---

## 🔴 A1 `id` 在 room 域 = 任务 URI，而帧上的 `id` 是请求关联 id

**现状**：`diy.room.get/post/turn/roster/read` 的入参都是 `id`，含义是「房间 id = 任务 URI」
（`api-domains/room/api.ts:31,44,53`）。而帧外层 `id` 是请求关联 id，`commandId` 是幂等键。

**代价**：两层同名不同义。日志里出现 `id=...` 无法判断是哪一层；写 facade 时必然要重命名变量，
一不小心把业务 `id` 当帧 `id` 传下去。

**目标**：业务层叫 `room`（= 任务 URI 时显式写 `taskUri`；帧里 `id` 只用于关联）。
**随哪一刀**：`diy.room` 迁成 kind 那一刀（`pkgs.ts/room` → `defineKind`），入参同步 `id` → `room`。

## 🔴 A2 「读不到」和「真的没有」被压成同一个值

**现状**：
- `diy.room.roster`：`entry: any | null` —— `null` 同时表示「这个成员没有会话」与「我读不到它的会话」；
- `diy.room.turn`：`turn: any | null` —— `null` 同时表示「这一轮已不在会话里」与「那台机器没连上」。

**代价**：UI 只能画「暂无」，说不清是事实还是未知。这条在跨节点布局下必然发生。

**目标**（正解形态已经在 `tests/support/fixtures.ts` 的 `roomKind` 里跑通）：

- `roster.members[i]`：`state: "running" | "idle" | "unknown"` + `reason`（`E_NOT_FOUND` / `E_TIMEOUT`）；
  `null` 只允许表示「确实没有」；
- `turn`：单目标，改判别联合 `found` / `not-found` / `unknown`（单目标没有「部分」可言）。

**随哪一刀**：`diy.room` 迁成 kind + `roster` 改 `fanoutQuery` 那一刀（第一个跨节点查询）。

## 🔴 A3 事件业务种类叫 `kind`（RoomEvent）又叫 `type`（AgentSessionEvent）

**现状**：`RoomEventSchema.kind: "say" | "reply"`；agent 侧事件用 `type: "public.agent-conclusion" | …`；
渲染端 `TurnEvent.type: "text" | "thinking" | …`。三处两套。

**目标**：**帧上**的业务名统一叫 `name`（actor 包已如此）。`data` **内部**保留 `type`
（块树的 `{type:"text"}` 不动 —— 那是业务词汇，不是帧词汇）。

**随哪一刀**：room / session 的 journal 记录迁成 `JournalEntry` 那一刀。

## 🟡 B1 一个成员四个名字：`member` / `memberId` / `memberUri` / `name`

**现状**：入参 `member: z.string()`（「成员名或 id」，双关）；`turn` 输出同时有 `memberUri`（命中的成员 id）
和 `memberId`（roster）；成员显示名是 `name`。

**目标**：`memberId`（稳定身份，唯一真源）/ `memberName`（显示）/ `memberUri`（会话地址，没有就省略）。
入参若保留便利寻址，叫 `memberRef`（「名字或 id」），并在文档写清解析顺序。
**随哪一刀**：`diy.room` 迁成 kind 那一刀。

## 🟡 B2 游标四套名：`lastSeen` / `at` / `watermark` / `seq`

**现状**：`RoomSchema.lastSeen[memberId] = eventId`；`RoomEvent.at`；帧里还有 `watermark` `seq`。

**actor 包已定**（这套说法以后不再改）：

| 名字 | 含义 |
|---|---|
| `seq` | 事件流位置（单调；`after` 的起点） |
| `at` | 事件发生时刻（毫秒数，**不是**位置） |
| `accepted.at` | 受理点：其后的事件才是这个命令产生的（位置） |
| `watermark` | 这份答案物化到的位置 |
| `cursor` | 「人读到的最后一条」（替代 `lastSeen` 的说法） |

**目标**：`RoomSchema.lastSeen` → `lastCursor`；`diy.room.read` 的返回字段 `read: { member, event }` → `cursor`。
**随哪一刀**：`lastSeen` 是**持久字段**，先加文档别名说明，等 journal 迁移时一次性重命名。

## 🟡 B3 `text` vs `body`

**现状**：`diy.room.post` 入参 `text`（正文，开头 `@` 走解析）；早期草稿里 `resolve` 的输出叫 `body`。
**目标**：统一 `text`。**随哪一刀**：`resolve` query 落地那一刀。

## 🟡 B4 `live: boolean` vs `entry.state`

**现状**：`turn` 输出 `live: boolean`（这一轮还在跑）；`roster` 里靠 `entry.state` 判断。

**目标**：`roster.members[i].state` 用三态枚举（`running` / `idle` / `unknown`）作为**唯一**判断依据；
需要布尔的地方由渲染层自己投影（`state === 'running'`），不要再往协议里加第二套布尔。
**随哪一刀**：`roster` / `turn` 一起改（与 A2 同一刀）。

---

## 一次性改名清单（照这个顺序做，避免半改状态）

| # | 动作 | 销 | 状态 |
|---|---|---|---|
| 1 | `wire.ts`：`k→type`、`q→query`、`payload→data`、回执 tag 去前缀、三个 brand | C1 C2 | ✅ 已做 |
| 2 | 扇出只在声明（`fanoutQuery`），帧里没有 `routing` / `targets` | C3 | ✅ 已做 |
| 3 | 帧类型里没有 `partial`；多目标 = `ok` + 逐项状态 + `meta.fanout` | C4 | ✅ 已做 |
| 4 | `pkgs.ts/room` → `defineKind`：入参 `id→room`、`member→memberRef`，输出 `body→text`、`memberUri` 钉死为会话地址 | A1 B1 B3 | ⏳ |
| 5 | `roster` 改 `fanoutQuery` + 逐项三态；`turn` 改判别联合 | A2 B4 | ⏳ |
| 6 | journal 记录：`kind→name`；`lastSeen→lastCursor`（含持久数据迁移） | A3 B2 | ⏳ |
| 7 | 第一个跨节点端口落地时定 `meta.fanout` 的名字 | C5 | ⏳ |

**不做的事**：不为旧字段加兼容别名（一次性改）；不在 `data` 内部推行统一命名
（块树 `type` 保持业务含义）。
