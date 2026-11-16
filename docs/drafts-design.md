# 草稿（drafts）设计 —— 未提交输入的统一缓冲

> 状态：P1–P3 已实现（2026-10-24 提案并落地）。范围：diy2 / `entity-chat` + `entity-runtime` + `apps/diy2/server`。
> 本文先回答「草稿到底是 inbox 的草稿，还是所有输入/选择的草稿」，再给落地方案。

## 1. 一句话

**草稿 = 已经输入、尚未提交的持久化缓冲**，按 `(容器, 字段)` 存，提交即清，真源在服务端。

它不是 inbox 条目：`InboxItem` 是 `say()` 之后的投递记录（有 id / mode / recipients，会被 agent 消费），
草稿是 `say()` 之前的状态（没有 id、不进投递队列、不参与路由）。发送动作才把草稿变成 InboxItem。

## 2. 三类状态，别混在一起

| 类别 | 例子 | 有没有「提交」 | 生命周期 | 存哪 |
|---|---|---|---|---|
| **草稿 draft** | 发言框、ask 卡半填答案、（将来）长表单 | 有；提交后应消失 | 输入即存，提交/取消即删 | 服务端 sqlite（**不写 localStorage**） |
| **偏好 preference** | surface、模型、侧栏开合、房间筛选、上次打开的房间 | 没有 | 长期有效，不自动清 | localStorage / 服务端 settings |
| **临时 ephemeral** | hover、mention 候选、滚动位置、面板开合 | 没有 | 只服务当下交互 | 组件 state，丢了无感 |

判据只有一句：**「提交」这个词对它成立吗？提交后该不该消失？**
成立 → 草稿；不成立但长期有效 → 偏好；只服务当下 → 临时。

为什么选择类（surface / 模型 / 筛选）不进草稿表：

- ✎ 标记会永远亮着，失去「这里有没发出去的东西」的含义；
- 「发送即清」对选择不成立，草稿表的清理规则会分叉；
- 多窗口下选择互相覆盖，比输入覆盖更烦人；
- 草稿表变成杂物间，没法定 TTL / 级联清理。

## 3. 通用度：设施是通用的，接入是分期的

- **设施通用**：`(owner, field, JSON value)` 的存储 + 防抖 + 提交清空 + ✎ 标记。
- **P1 只接发言框**（本轮要修的那个丢字问题）。
- **P2 接 AskCard**：它今天在 astryx/shadcn 的共享 `AskCard` 和 assistant-ui 的
  `tool-fallback` 里各有一份 `useState`，切面/切房间同样丢；接口按多字段草稿设计，接入不用改表。
- **P3 接对话框表单**（新建任务的描述这种长文本）。这类 owner 还没有实体 id，
  用 synthetic scope（`dlg:<用途>:<roomId>`）+ TTL，不放进 P1。

这样避免「先给 composer 写死一个 draft，下个月 ask 卡再抄一遍」。

## 4. 数据模型

```sql
CREATE TABLE IF NOT EXISTS drafts (
  owner_id   TEXT NOT NULL,              -- 房间 id（P3 的表单可能是 synthetic scope）
  field      TEXT NOT NULL,              -- 'composer' | 'ask:<askId>' | …
  value      TEXT NOT NULL,              -- JSON，由消费方解释
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, field)
);
```

- `value`：v1 发言框 `{ "text": "..." }`；P2 ask 用 `{ selected, fields, text }`（`askDraftOf` 归一化后的定长结构，贴近 `AskAnswer`）。
- 空串 / 空对象 → **删除**，不留空行。
- 单条上限 256KB：超限返回 413，客户端保留输入并提示，不静默截断。
- `deleteRoom` 级联删 `drafts`；ask 答完 / 失效时删 `ask:<id>`。
- 草稿是**状态**不是事件：直接序列化落盘，不写 ops / history（`core-log` 约束）。

为什么不用 `room.data`：`data` 是容器元数据，`GET /rooms` 会把所有草稿正文一起带出来；
`PATCH /rooms/:id` 的 `data` 是整体替换，两个窗口改不同字段会互相覆盖。

为什么不用 localStorage：无备份、无 TTL、别的窗口/表面看不见、清缓存即丢；
草稿是「半编辑数据」，丢了就是用户白打。

## 5. API（diy2 server）

- `GET /api/rooms/:id/drafts`
  → `{ drafts: [{ field, value, updatedAt }] }`（一次取全，composer 与 ask 共用）
- `PUT /api/rooms/:id/drafts/:field`，body `{ value }`
  空值 = 删除；返回 `{ updatedAt }`。幂等。
- `DELETE /api/rooms/:id/drafts/:field`（显式清；语义等同 PUT 空值）
- `GET /api/rooms` 每项附 `hasDraft: boolean`（`drafts` 表按 owner 聚合），供侧栏 ✎。
  这是**响应字段**，不写进 `Room` 领域类型；客户端用 `RoomSummary = Room & { hasDraft?: boolean }` 读。

P3 的 synthetic scope 走另一组路由（不属于任何房间，不能借 `/rooms/:id`）：

- `GET /api/drafts/:owner` → `{ drafts: [...] }`
- `PUT /api/drafts/:owner/:field`，body `{ value }`；`DELETE` 同义
- owner 必须是保留前缀 `dlg:<用途>:<roomId>`（正则白名单），否则 400 —— 这个接口不能变成
  任意键值仓库。房间 id 形如 `project-xxx` / `proj:diy`，撞不上 `dlg:`。
- 这种草稿**不进 `hasDraft`**：侧栏 ✎ 说的是「这个房间里有没发出去的东西」，
  而对话框草稿挂在房间后面、却不属于房间内容（点了房间也看不到它）。
- 清理两条：删房间时按 `dlg:%:<roomId>` 级联删；剩下的（用户再也不打开那个对话框、
  房间 id 已变）由启动时的 TTL 清掉（7 天）。

多窗口：最后写赢。P1 不做草稿变更推送，切换/刷新时重拉；P4 再考虑 SSE。

## 6. 客户端（entity-chat）

新增 `src/drafts.ts`（纯 TS，无 React 依赖，方便单测）：

- 状态：`Map<ownerId, Map<field, Entry>>`，
  `Entry = { value, updatedAt, dirty, loaded, timer, error }`。
- 首次使用某个 owner：`GET /drafts` 一次取全；**本地已有 dirty 值时不覆盖**。
- `setValue(owner, field, value)`：立即写内存并通知；600ms 防抖 PUT；期间再改重置 timer。
- `flush(owner?)`：切房间、组件卸载、`pagehide`（`fetch keepalive`）时立即写。
- 写失败：保留 dirty，指数退避重试（1s/2s/4s… 封顶 30s），composer 下给一条「草稿未保存」细提示。
- `clearIfMatches(owner, field, expected)`：提交成功时只清「还是我发出去那版」的草稿，
  防止运行期间用户新输入的字被清掉。
- React 侧：`useDraft(owner, field)` 返回 `{ value, setValue, clear, status }`。

三个 surface 的接入：

- astryx / shadcn：`useDraft(roomId, 'composer')` 取代组件内 `useState('')`，输入框保持受控。
- assistant-ui：`thread.aui.tsx` 的 `Composer` 需要拿到 `roomId`（`Thread` 传 prop 或 context）；
  mount 时 `aui.composer.setText(draft)`，输入时写 store。
  注意只在 owner 变化时 seed 一次，别每次 render `setText`（会打断输入/光标）。
- 切换 surface 重建组件后从 store 回填，**三个面共用一份**。

## 7. 发送语义

现状 `ConversationStore.send(): void` 没有「已受理」信号，失败只落到 `state.error`。
草稿要「发送成功才清」，需要一个小改动：

- `send()` 返回 accepted promise：HTTP 建流后**首条 SSE 事件**即 resolve；建流失败/拒绝则 reject。
  （`post` 已有 `onEvent`，在 chat-core 内部包一层即可，不用改 transport。）
- UI：`await send(text)` → `clearIfMatches(...)`；reject → 保留输入 + 现有 ErrorBar。
- 等待期（本地几毫秒）给 `submitting` 标志，防连按 Enter 重复发送。
- 不做「先清后发」：离线/后端挂掉时那会把用户打的字静默丢掉。

## 8. UI

- 侧栏房间行：有草稿时名字旁一个小 ✎（`aria-label="有未提交的草稿"`），不抢状态胶囊、不新增未读语义。
- 切回房间：输入框回填，光标置尾。
- 发送成功 / ask 答完：✎ 立刻消失（本地乐观更新，服务端返回后校准）。
- 空草稿不显示；ask 草稿也算「这个房间有未提交输入」。

## 9. 分期

**P1（本轮）**

1. `entity-runtime`：`drafts` 表 + `Store.listDrafts / putDraft / deleteDraft` + `deleteRoom` 级联 + 单测。
2. `apps/diy2/server`：GET / PUT / DELETE + `/api/rooms` 的 `hasDraft`。
3. `entity-chat`：`drafts.ts` + `useDraft` + 三面 composer + `send` accepted promise。
4. Sidebar ✎。
5. 测试：drafts store（防抖 / 清空 / 冲突 / 失败重试）、entity-runtime 表与级联、手测清单。

**P2（已实现）**：AskCard 的输入搬进草稿设施。

- `askDraft.ts`：纯逻辑（归一化 / 勾选 / 必填判定 / 装配 `AskAnswer`），无 React 依赖，单测直接打。
- `AskCard`：`field = ask:<askId>`、`owner = roomId`，三处输入都读写草稿；`busy/error` 仍是本地态。
- 提交成功 `clearIfValueMatches(快照)`：提交期间用户又改过的草稿不清。
- `resolved`（答过 / 失效）时清掉该 ask 的草稿，避免 ✎ 为历史提问常亮。
- owner 为空（assistant-ui 的 meta 没带 roomId）时降级为纯内存，不发 `/rooms//drafts`。
- 好处：三个表面共用同一份 `AskCard`，切 surface / 切房间 / 刷新都不再丢半填的选项与字段。

**P3（已实现）**：对话框表单草稿（synthetic owner + TTL）+ ask 残留清理。

- `CreateTaskDialog`（新建任务的描述）进草稿：owner = `dlg:create-task:<projectId>`、field = `desc`。
  - **只存描述，不存任务名**：任务名几个字就打完，而且默认值是「新任务 N」这种跟着上下文变的
    东西 —— 存下来的旧名字反而会盖掉新的建议。
  - 提交**成功**才清（`createTask` 失败改为 rethrow，对话框据此保留描述并提示）；明确点「取消」清；
    点外面 / Esc 关掉**保留**（那是误关）。
  - 打开时确实捞回了内容才显示「已恢复上次没写完的描述」+「丢弃」。
- `drafts.ts`：`dialogOwner(kind, roomId)` + `draftsPath(owner)` —— `dlg:` 开头走 `/drafts/:owner`，
  其余走 `/rooms/:id/drafts`。synthetic owner 的 ✎ 不落到任何房间上。
- ask 残留自愈：`GET /api/rooms/:id/drafts` 先 `pruneAskDrafts(roomId, 还在等回答的 askId, 30 分钟)`——
  提问从时间线上彻底消失（房间重开、条目被裁）时不再留下永远亮着的 ✎。
- 启动时 `pruneDraftOwners('dlg:', 7 天)`：synthetic scope 不在房间级联范围内，得有自己的 TTL。
- 房间名（`RoomName.tsx`）仍是短文本、只做内存态 —— 它是「改一个字」不是「写一段」，
  不值得为它引入一条草稿。

**P4**：多窗口实时同步（SSE draft 事件）、跨设备（无账号体系，先不做）。

## 10. 不做

- 不把选择/偏好当草稿；
- 不用 localStorage / sessionStorage 存草稿；
- 不为草稿写事件日志 / ops；
- 不做草稿版本历史 / 撤销；
- 不因为「防丢」就把每个受控输入都自动持久化 —— 只接有明确提交语义且内容值得恢复的。

## 11. 验收

- 切房间 / 切 surface / 刷新 / 重启 / 杀进程，草稿都在；
- 发送成功清、失败保留；
- 空输入不产生记录；超限有提示且内容不丢；
- 删房间后草稿级联消失；
- ✎ 准确（P1 发言框；P2 起含 ask）；
- `./sha.sh check` + 相关 vitest 通过；
- `grep -r localStorage pkgs.ts/ui/entity-chat/src/drafts.ts` 无命中。
- 新建任务：描述写一半，点外面 / Esc 关掉 → 再打开还在；创建成功 / 明确取消 → 再打开是空的；
  创建失败 → 描述仍在，对话框里有提示（P3）。
- 删项目后，挂在它下面的 `dlg:create-task:<projectId>` 草稿一起消失（P3）。

## 12. 开放问题（默认值，可改）

- 草稿 TTL：房间草稿**不自动过期**（老 diy-app 也没有），随删房间收敛；
  对话框草稿（synthetic scope）有自己的 7 天 TTL —— 它不随房间级联，没人清就会只增不减。
  ask 草稿按「有结局 + 30 分钟」清。
- ask 半填算不算 ✎：默认算（它就是未提交输入）；提问有结局就清掉，所以不会长期亮。
- 残留（P3 已解）：提问从时间线上彻底消失（房间重开、条目被裁）时 `ask:<id>` 没人清 ——
  现在打开房间就会清掉「30 分钟前、时间线上不再等回答」的 ask 草稿（`pruneAskDrafts`）。
  只清不pending 的：多窗口下另一个窗口刚刚正在填的那条，30 分钟内不会被碰。
- 多窗口冲突：最后写赢，P1 不提示、不合并。
- 输入法组合期：600ms 防抖已覆盖，不做特殊处理。
