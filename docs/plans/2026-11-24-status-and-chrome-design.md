# 状态层级与界面瘦身（2026-11-24）

用户四个诉求：① 临时状态不该进历史；② 三层状态（任务 / bot / 轮次）各有明确落点，轮次状态不许突然空白；③ 时间改绝对时间；④ 删掉成员列表、+成员、任务状态、目录、成员说明，行内按钮收进三点菜单，历史任务加「打开」按钮，标题栏放全会话活动图标。

## 一、临时状态 vs 历史（现状 → 目标）

实测 lab 库 `entity_items` 115 行：chat 23 / tool 87 / notice 5，其中 **2 条是 progress 警告**（"61 秒还没吐出第一个字"、"44 秒没有新内容"）—— 用户抱怨的正是这类。

根因：`protocol/types.ts:331` 明写 `progress` 是 ephemeral（不进快照、不进 items），但 `progressNotice()` 又把同样的阈值转成 **notice 条目**落进 append-only 的 room-log ⇒ **两处判据打架**，过程噪音被迫进了永久历史。

| # | 事件 / 文案 | 现在 | 目标 | 落点 |
|---|---|---|---|---|
| 1 | 正在说话 / typing | ephemeral（快照 speaking + UI 临时造行） | 临时 | 轮次状态位（消息头） |
| 2 | 模型流 44s 无新内容 | **落 notice 进 items** | 临时 | 状态位（琥珀 + 计时） |
| 3 | 61s 没吐第一个字 | **落 notice 进 items** | 临时 | 同上 |
| 4 | 工具跑 3 分钟无输出 | **落 notice 进 items** | 临时 | 同上 |
| 5 | 压缩中 / 压缩慢 | **落 notice 进 items** | 临时 | 同上 |
| 6 | 本轮已跑 30 分钟 | 落 notice | 临时 | 同上 |
| 7 | **stalled：上游静默，已中止** | notice | **历史** | notice 一行 + footer |
| 8 | error（含上游原文） | error 条目 | 历史 | error 框 |
| 9 | max-steps / max-tokens / 用户停止 | notice + footer | 历史 | notice + footer |
| 10 | job-done | notice + JobCard | 历史 | JobCard |
| 11 | ask 提问 / 已答 / 过期 | asks 表 + 卡 | 历史 | ask 卡 |
| 12 | 投递 delivering / 未送达 | 快照 deliveries | 临时 | 房间状态条 |

**判据一句话**：*过程*只活在 ephemeral（刷新即失，合理）；*结局*（中止 / 失败 / 预算用完 / 作业结束）才落盘。改法 = 删 `progressNotice()`，UI 拿 `progress` 事件 + `idleMs` 本地自走计时。代价：刷新后看不见「刚才卡了 5 分钟」，但真出事会留 stalled notice。

## 二、三层状态与显示位置

| 层 | 有哪些状态 | 现在显示在哪（重复 4 处） | 目标（每层一处） |
|---|---|---|---|
| **任务 / 房间** | open/closed、谁在跑、几个待答、最后活动 | 侧栏行图标 + 头部 StatusChip + 底部 RoomStatusBar + 行内小字 | **只留侧栏行**：状态图标 + 在跑呼吸点 + 最后活动时间。头部 StatusChip 删 |
| **bot 成员** | 在跑 / 在等你 / 没动 / 投递挂着 | RoomStatusBar 底部一叠 chips | 保留底部**一条**（房间级唯一收容处），默认静默，非正常态才出声 |
| **轮次 turn** | 发送中 → 调用 bash → 等模型 → 完成（tokens/耗时/步数） | typing 独立条目 + 消息头时间 + footer + RunningIndicator | **一条轮次容器**：头像 + 名字 · 时间 · 状态位，从开轮活到 turn.end，状态位换档绝不空白；结束换成结算摘要；footer 只留给异常 |

**"突然空白"的根因**：typing 是**独立条目**、assistant 消息是另一条目，快照切换时两边都不占位 ⇒ 视觉空档。改法 = 状态挂在轮次容器上（不是凭空造条目），一个 turn 全程只有一行头。

时间：统一 `formatAtAbsolute`（24h，如 `2026-11-24 22:32`）；消息头建议当天 `22:32`、跨天 `11-24 22:32`，hover 出全量（每行都写年份太吵）。

## 三、页面清理

**头部（entity-chat `App.tsx` Header）**
- 删：`StatusChip`、目录 `~/git/diy/diy`、成员 chips（默认应答 + 其他 + 「+成员」）、第二行「N 个成员：@名字…」
- 留：类型标签 + 可编辑标题
- 加：标题旁 kebab（加成员 / 房间设置 / 关闭任务）—— 加成员能力不能没有入口

**侧栏（`RoomRow` + `nav/history.tsx`）**
- hover 三按钮（铅笔 / 新建任务 / 垃圾桶）→ 收进 `⋮` 菜单：重命名 / 新建任务（仅项目）/ 删除
- 每个任务行常驻**打开↔关闭** toggle（open 显示「关闭」，历史显示「打开」），跟 `⋮` 并列 = 用户要的两个按钮
- 历史行不再靠"点状态图标重开"这种隐含交互

**标题栏（workbench `App.tsx:178/184`）**
- `ActiveSessionsGlyph` / `ActiveJobsGlyph` 已在，确认可见 + 可点击跳转即达标（会话那颗 = 在动成员数，作业那颗 = 活着的 run）

## 四、意见与风险

1. **加成员不能真删**：列表可以消失（信息在消息头像上就有），但能力入口收到 kebab。
2. **删头部状态的可发现性**：任务 open/closed 在侧栏两处（项目树 / 历史区）可见，够；但「这个房间是谁在跑」就只能靠底部那条 —— 所以底部条不能也删。
3. **轮次容器是最大一块**：要动 chat-core timeline 的归并 + astryx / assistant-ui 两面。建议单独一刀，先落状态位 + 不空白，再叠结算摘要。
4. **结算数据源已核实：没有**。实测 lab 库的 bot chat 条目 `data` 只有 `{text}`，无 usage / 耗时 / 步数；`turn.end` 也不进快照（`end-reason.ts:242`）。所以「结算显示 token」= 要新增一条链路（收轮时把 `session.lastUsage` 写进 chat item 的 data 或旁挂 turnMeta）。暂不做就先显示耗时 / 步数（UI 侧能从开轮→收轮自算）。
5. **工具条目 87 行**是历史里最大噪音源（比 notice 多 17 倍），但用户本轮没点名；若要折叠，另一刀。

## 五、实现要点（已探好的落点，动手时直接用）

- **开 / 关任务**：`actions.setRoomStatus(id, status)`（`store.tsx:849`），`'closed'` 时自动盖 `closedAt`、重开传 `null` 清掉 —— 侧栏 toggle 直接调它，不需要新接口。
- **行内按钮收进菜单**：`RoomRow.tsx` 的 `RowAction` 三个（重命名 / 新建任务 / 删除）现在是一个绝对定位的 hover 条，包成 `⋮` + 浮层；仓库里**没有** dropdown 组件，需自写（或引 shadcn `dropdown-menu`，看 ui 包现状）。
- **头部要删的元素**：`App.tsx` Header 里的 `<StatusChip>`、`roomDir`/`dirOf` 那段路径、成员 chips 整块，以及它下面第二行 `<div className="mt-1 …">{bots.length <= 1 ? … : `${bots.length} 个成员：@…`}</div>`。
- **成员能力去向**：`onAddMember` 回调已存在，只需挪挂载点（标题旁 kebab / 设置弹窗）。
- **轮次容器**：`chat-core` 的 timeline 现在把 typing 当独立条目，要改成挂在轮次头（`headers.ts` + `timeline.ts` 两侧）；surface 侧 `astryx` 与 `assistant-ui` 各改一处渲染。
