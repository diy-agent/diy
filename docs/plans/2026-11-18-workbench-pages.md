# 工作台：页 / 区域 / 视图（设计推理）

> **实现与 API 在 worktree `exp/workbench-dock`**：包 `pkgs.ts/ui/workbench-dock`，范例页
> `apps/diy2/src/dock-demo.tsx`（`/dock.html`）。**先看那个包的 `README.md`**（有可直接抄的 API 范例），
> 本文只记设计推理与跟 diy1 / vscode / theia 的差异。

# diy2 工作台：page 一级概念下的布局模型（以 dockview 原语为基准重设计）

> 2026-11-18 · 基于 main（`1c243d8e`）· 第三版。前两版错在两处：v1 把 page 当"自由工作区"；
> v2 想「沿用 diy1 模型、只换渲染器」—— diy1 那套是为 CSS Grid 长出来的（全局线 + 跨列矩形 +
> binding 真源），塞进 dockview 必然长补丁。本版**从引擎原语往外推**，只继承词汇与产品判据。

## 0. 结论

1. **page 是一级概念**：`pageType + 核心对象(scope)`。一页的核心唯一（一个任务/一个项目/一次执行），
   其它 view 是围绕它的增量。这是与 VSCode/Theia（核心恒为编辑器）的分野。
2. **先读引擎再定模型**。dockview 的原语是 `panel / group / 组树 / floating / 可序列化布局快照`，
   由此推出 8 条硬约束 C1–C8（§2）。模型逐条对着这些约束写，不对着 diy1 写。
3. **真源只有一份：布局快照**（`SerializedDockview`）。"哪个 view 在哪个区域、什么顺序、哪个是活动 tab、
   哪个区域收起"全都在这份 JSON 里。**废弃 diy1 的 `Binding` 层**——它是这份 JSON 的投影，
   双写必然漂移（v2 我还得补一步"反向同步"，那就是双写的证据）。
4. **模板降级为编译器输入**：`PageType.regions`（声明式区域树）+ `placement`（view 侧声明）
   → `compile()` → 布局快照。模板不再是与运行时并行的第二套布局模型。
5. **收起区域用引擎的 `visible:false`**，不是删组重建：`group.api.setVisible(false)` 会把该组和其 splitter
   一起隐藏，且尺寸缓存进快照（`SerializedGridObject.visible` + `size`）。**这一条要 P0 第一小时实测**，
   它决定"收起"是 3 行代码还是一次重建。
6. **一份真源的代价是 `reconcile()`**：模板升级（加区域/加 view）时要把旧快照合并进新模板。
   diy1 靠 binding 天然免疫，但代价是三份重叠真源。这个交换写清楚并接受（§4.2）。
   唯一必要的额外记账是 `dismissed`（用户显式关掉的 view），因为"缺席"区分不了"用户关的"和"新加的"。
7. **自由度**：L0 发布（结构锁死，只能拖分屏线 + 收起/展开区域 + 关/开 tab），L1（view 在指定区域内换位）
   藏 dev 开关（已定：`?dnd=1` / dev 构建下可开）。**换了真源之后 L0/L1 的持久化代码不分叉**——布局本来就是真源，只是引擎配置不同。

---

## 1. 为什么 page 是一级（与 VSCode / Theia 的分野）

| | VSCode / Theia | 我们 |
|---|---|---|
| 一级单位 | **编辑器/文档**：一切围绕一个文件，别的内容塞 panel / 侧栏 / 扩展视图 | **领域对象**：一页的核心唯一，其它 view 是增量 |
| 多核心并存 | 不能。Theia 用 Perspectives（换布局集合）、VSCode 为 agent 另造会话导航 —— 都是拼凑 | 能。任务页 / 项目页 / 执行页是平级的不同核心，各有固定布局 |
| 布局归属 | 用户随心拖（主编辑区 + 可停靠 panel） | 布局是 page 的附属，按 pageType 固定；用户自由度见 §6 |

三条推论（当约束用）：

- **可寻址**：page 身份 = `pageType@scopeKey`，进 URL 与命令（`openPage('task-run', {taskUri})`）。
  不可寻址的 page 只是"恰好放在一起的面板"，bot 也没法「把这两个任务并排打开」。
- **布局模板归 pageType**：任务页长什么样是代码说了算，用户改的只是这一页的尺寸/开合。
- **view 的 params 从 scope 派生**：任务页里的 chat 不需要参数，它的 target 就是 scope；只有
  局部 UI 状态（选中项/筛选/滚动）归 view。否则 page 退化成"一堆独立面板"。

---

## 2. 先看引擎：dockview 的五个原语与 8 条约束

**原语**（`packages/dockview-core`）：

| 原语 | 形态 | 关键 API |
|---|---|---|
| panel | 一个内容 + 一个 tab（id、component、title、params） | `addPanel({id, component, params, position})`、`removePanel` |
| group | 一组 tab（**布局的叶子**），有稳定 id / header / 尺寸 | `addGroup({id, hideHeader, constraints})`、`group.api.setSize({width,height})` |
| 组树 | `group` 的嵌套 split（`Orientation.HORIZONTAL/VERTICAL`），每个子节点带 px 尺寸 | `toJSON()` 的 `grid.root` |
| floating / popout | 布局树之外的层 | `addFloatingGroup` / `addPopoutGroup` |
| 布局快照 | `SerializedDockview`：组树 + 每组的 `views/activeView` + `panels` 状态 + floating/popout | `toJSON()` / `fromJSON(data, {reuseExistingPanels})` |

**由此推出的约束**（写模型时逐条对照）：

- **C1 布局单位是组的树，不是全局线。** 子节点只能"切一刀"；跨列（diy1 的 `colSpan:3` 底栏）只能靠嵌套表达。
- **C2 尺寸是同父兄弟间的比例**，落盘是 px。模板只该写相对比例（`fr`）+ 最小宽，px 是构建时的换算结果。
- **C3 一个 panel 只属于一个 group；组内是 tab**（顺序 + activeView）。"同一区域里几块同时可见"引擎不支持。
- **C4 group 不能消失式隐藏，但可以 `visible:false`**（`panel.api.setVisible` / 快照里的 `visible` 字段）：
  组和 splitter 一起隐藏，尺寸缓存住，`setVisible(true)` 原样回来。
- **C5 group id 与 panel id 都是字符串、都随快照序列化。** ⇒ 用 area id 当 groupId、viewId 当 panelId，
  **"谁在哪"由快照自己表达**，不需要并行的 binding 表。
- **C6 panel 组件由 `component` 字符串到 `components` 映射解析，且该映射在创建时被闭包捕获。**
  ⇒ registry 必须是模块级常量；params 必须自足（scope 派生 + view 局部状态）。
- **C7 快照是完整状态**（含尺寸、activeView、visible、floating）。⇒ 它是用户态真源，不是"可丢的缓存"；
  模板升级必须 reconcile，不能重建了事。
- **C8 floating / popout 是快照里独立的一层。** ⇒ 模型里给显式开关位，L0 关掉（`disableFloatingGroups`，不外露 popout）。

> 附带发现（影响实现，别踩）：往一个已有区域加 tab **不是** `addPanel({group})`（没这个参数），
> 而是 `addPanel({position:{referenceGroup: areaId, direction:'within', index}})`；
> 组内最大化的 `api.maximizeGroup()` 是**免费**的（不需要 undo/键盘那套收费模块）。

---

## 3. 新模型

### 3.1 三层，各管一件事

```
① 代码层（编译期常量，不可序列化）
   PageTypeDef ──{ id, title, icon?, subject, parent?, regions, version, policy? }
   ViewDef    ──{ id, title, icon?, stateScope, placement: { [pageType]: {area, order?, primary?} } }
   RegionNode ── area{id,title,size?,min?,initial?:'open'|'closed',hideHeader?}
               | split{dir:'row'|'col', children[]}

② 运行层（用户数据，可序列化）—— **只有一份真源**
   PageInstanceDoc = { key: 'task-run@<taskUri>', pageType, scopeKey,
                       layout: LayoutJSON,        // dockview 快照：组树 + 尺寸 + 每组 views/activeView/visible
                       dismissed: string[],       // 用户显式关掉的 view（唯一必要的额外记账，见 §3.3）
                       templateVersion: number, userTouched?: boolean }

③ 派生（选择器，不落盘）
   openAreas(doc) / collapsedAreas(doc)      ← 组树里 visible 的取值
   viewsIn(doc, areaId)                       ← 组的 views，按序
   missingViews(doc)                          ← registry 有、doc 里没有、且不在 dismissed（= 新加的）
```

**为什么砍掉 `Binding`**：diy1 的 `binding: viewKey → areaId` 是"谁在哪"。dockview 的快照里已经有
`group.id = areaId` 和 `group.views = [viewId...]`，再存一份就是双写。v2 之所以还要写
"`onDidLayoutChange` → 写回 binding"，就是双写暴露的症状。新版**布局一变就存快照，别的全是读**。

**为什么砍掉 `hidden` / `hiddenViews` 两层**：区域收起 = 该组 `visible:false`（在快照里），
view 收起 = 它不在任何组的 `views` 里（也在快照里）。diy1 那两层是"投影层"，这里已经不需要。

### 3.2 唯一的动态：`policy`

diy1 里有一处无法用静态表表达的产品规则——"房间成员 > 1 时默认展开成员栏，否则收起，
但用户动过之后程序就不许再动"（##166 §44.1 ②，判据 7）。diy1 把它写在 `TaskRunPage` 里。
新版把它收进模型：`PageTypeDef.policy.autoOpen(scope) => areaId[]`，**只在 `!doc.userTouched` 时生效**，
且它的效果就是 `group.api.setVisible(true)`。规则仍然是代码常量，不进用户数据、不做表达式求值。

### 3.3 唯一的额外记账：`dismissed`

单一真源有个死角：「registry 里有、快照里没有」的 view，可能是**用户关掉的**（要记住，别偷偷开回来），
也可能是**模板新加的**（要开出来）。快照区分不了。所以只多记一条 `dismissed: viewId[]`
——用户显式关 tab 时加进去，显式打开时移除；reconcile 时 `registry − layout − dismissed` 才是"新加的"。
区域不需要这条（`visible:false` 已经把"收起"记在快照里了）。

---

## 4. 两个纯函数（整份模型的算法核心，可无 DOM 单测）

### 4.1 `compile(pageType, views, scope, viewport) → LayoutJSON`

（已落成独立包：`pkgs.ts/ui/workbench-dock`（worktree `exp/workbench-dock`）——
`model.ts` 是类型 + 派生 + 校验，`compile.ts` 是 `compileLayout` / `resolveLayout`。
**API 范例看那个包的 `README.md`**，本文只留设计推理。）

```
区域树 → 组树：
  split{dir:'row'}  → { type:'branch', orientation:HORIZONTAL, data:[...] }   ← 注意方向别写反
  split{dir:'col'}  → { type:'branch', orientation:VERTICAL,   data:[...] }
  area{size}        → { type:'leaf', data:{ id: areaId, views:[...], activeView, hideHeader },
                        size: toPx(size, 同父总和, viewport) }
每组的 views：本 page 里 placement.area === areaId 的 view，按 order 排序；剔除 dismissed。
              initial:'closed' 的区域**照样进树**，只是带 visible:false（尺寸一起算进去，展开时原样回来）。
每组 activeView：primary 优先，否则 order 最小。
单区域页：外面包一层单子 branch（引擎的 grid 以 branch 为根），叶子的 size 取 viewport 主轴。
```

目标快照大致长这样（`task-run` 的四区域，与 diy1 同构）：

```
VERTICAL
├─ HORIZONTAL  (h=1fr=660)
│   ├─ leaf  left   [task.detail]                   w=300   (min 220)
│   ├─ leaf  center [chat]                          w=820   ← 核心（1fr，min 360）
│   └─ leaf  right  [room.members]                  w=320   ← visible:false，成员>1 由 policy 展开
└─ leaf  bottom [job.runs]                          h=240   ← visible:false
```

### 4.2 `reconcile(prevLayout, pageType, views) → LayoutJSON`

| 规则 | 处理 |
|---|---|
| R1 旧组 id 在新模板里 | 保留：尺寸、`visible`、组内顺序、`activeView` |
| R2 新模板有、旧快照没有 | 新建组，尺寸取模板、可见性取 `initial` |
| — 尺寸单位 | 保留旧快照的 px。若 viewport 变了，总和可能与新宽度不符，引擎会归一化；不必自己重算比例 |
| R3 旧快照有、新模板没有 | 丢弃（模板删了该区域） |
| R4 view：`registry − layout − dismissed` | 新增，插进它声明的 area（按 order 的位置） |
| R5 view：在 layout、不在 registry | 丢弃（view 已从代码里删） |
| R6 组变空 | 保留空组但 `visible:false`（不留 tab 条残影；见 §6） |

调用点只有两个：**载入时**（`doc.templateVersion !== pageType.version`）和**重置布局**（丢弃 doc.layout 重新 compile）。
L0 下用户动不了结构，所以运行期不需要 reconcile。

### 4.3 `validate(pageType, views)`（编译期自查，P0 就接上）

- V1 area id 在本 page 内唯一；V2 每个 area 至少 1 个 view；V3 每个 page 恰一个 `primary`；
- V4 split 至少 2 个子；V5 `placement.area` 必须存在于模板；V6 view id 全局唯一；
- V7 `subject !== 'none'` 的 page 必须带 scopeKey；V8 `primary` view 不允许被用户关闭（禁关，不是靠 reconcile 兜）。

---

## 5. 与 diy1 的差异清单（继承什么 / 改什么 / 为什么）

| 项 | diy1（网格） | 新版（dockview） | 理由 |
|---|---|---|---|
| 区域排布 | `cols/rows` 全局线 + `areas[]{col,row,colSpan}` | **区域树**（`split`/`area`） | C1：全局线表达不了嵌套 |
| 区域尺寸 | `TrackSize`（px/fr，同线共享） | 相对比例 + `min`，px 仅构建期换算 | C2 |
| 一个区域多个 view | tab / 折叠框两种呈现 | **只有 tab**；要同时可见的多块 = 一个 view 内部的分块 | C3（diy1 实际上已经这么用：`lab.inspector`/`lab.preview` 都是"一个 view 内部折叠块"，本版把隐含约定变成硬规则） |
| 归属真源 | `Binding`（view→area） | 布局快照（`group.id`/`group.views`） | C5/C7，避免双写 |
| 收起 | `hidden[area]` + `hiddenViews` 两层 | 组 `visible:false`（在快照里）+ 不在 `views` 里 | C4；diy1 两层是投影，这里已被快照吸收 |
| 实例作用域 | `instanceScope: global\|context`（实例数） | `stateScope: shared\|page`（状态归属） | 每个 page 一个 dockview 实例，实例数已无歧义，只剩"状态给谁共享" |
| 最大化 | `maximized: areaId`（写进用户态） | `api.maximizeGroup()`（瞬态，不进 doc） | 免费且无需持久化 |
| 用户是否手改 | `userTouched` | 保留（同名同义） | policy 自动开合必须让位于用户 |
| 模板升级 | binding 按 key 补，天然免疫 | 需 `reconcile()` | 单一真源的交换条件（§4.2） |
| 校验 | 运行时宽松清洗 | 编译期 `validate()` + 载入期 reconcile | 布局错了不该表现为"界面诡异" |

**9 个 diy1 page 的迁移核对**：全部可树化（`task-run`/`lab` = `col[row[3], bottom]`，`ctxlab` = `row[2]`，
`brain` = `row[3]`，`flow` = `row[1fr,380]`，`traffic` = `row[3fr,2fr]`，`task`/`llm`/`settings` = 单叶）。
唯一需要改写法的是 `lab` 左栏那种"一个区域装多个 view、用折叠框并列"的注释口径 —— 实际代码里它已经是
一个 view 内部的可折叠块，跟 C3 一致，只需把注释里的旧说法删掉。

---

## 6. 自由度与交互映射

| 档 | 用户能做什么 | 引擎配置 |
|---|---|---|
| **L0（发布）** | 拖分屏线、收起/展开区域、关/开 tab、组内最大化 | `disableDnd:true`、`disableFloatingGroups:true`、不外露 popout/edge/undo |
| **L1（dev 开关）** | 额外：view 在 `placement.allowAreas` 内换区、组内 tab 重排 | `disableDnd:false` + `dropPositionResolver`/`onWillDrop` 拒绝越界 |
| L2 | 自由切新区域 | 不做 —— 那就是回去做 VSCode |
| L3 | 页面布局存成可分享的"透视图" | 不做 —— Theia perspective 的回头路 |

注意 L0 有一个副作用：`disableDnd` 会连**组内 tab 重排**一起禁掉，tab 顺序就是 `placement.order`。
这是想要的（顺序也是布局的一部分），但要写进验收，别被当成 bug。

收起/展开的落点（全部走 intent，不散落）：

```
collapseArea(pageId, areaId)   → group.api.setVisible(false)          （C4，尺寸自动缓存进快照）
expandArea(pageId, areaId)     → group.api.setVisible(true)
closeView(pageId, viewId)      → removePanel + dismissed.push(viewId)
openView(pageId, viewId)       → addPanel({position:{referenceGroup: placement.area, direction:'within', index}})
resetLayout(pageId)            → 丢 doc.layout，重新 compile
```

前提：`closeEmptyGroups:false` —— 否则关掉最后一个 tab 时组会被引擎销毁，`visible:false` 的收起义就没了。

---

## 7. 与 dockview 8.9.1 的能力对照

- **免费且要用**：快照序列化 + `fromJSON(reuseExistingPanels)`、`group.api.setVisible`（收起区域的关键，
  **文档没写但核心有**）、`api.maximizeGroup`、`addPanel({position:{referenceGroup,direction:'within'}})`、
  `addGroup({id, hideHeader, constraints})`、`onDidLayoutChange({reasons})`、`api.layout(w,h)`、
  `singleTabMode`、`closeEmptyGroups:false`、自定义 tab / 右键菜单 / 主题。
- **收费（别写进验收）**：布局 undo/redo、键盘空间导航与键盘 docking、smart guides、pinned/multi-row tabs、
  overflow 搜索、auto-hide edge groups、DnD compass。
- **没有（自己写）**：page/workspace 概念、page 条与侧栏、命令面板与快捷键表、模板校验与 reconcile、
  跨 page 移 view（只能序列化重建）。
- **实现注意**：`components` 在创建时被闭包捕获 ⇒ registry 必须模块常量；`Orientation.HORIZONTAL` 表示
  **兄弟横向排列**（与 CSS `flex-direction` 的直觉相反，compile 里写个断言）；React Compiler 与命令式桥
  的相互作用在第一小时验证。

---

## 8. UI 落位与事件流（不再赘述，只留结论）

```
┌ page 条：[任务] [项目] [执行·A] … （tab；icon + 核心名 + 状态点）  ← 一级导航
├ 侧栏（page 入口，不进 dockview）│ page 工作区（区域按 pageType 模板）
└───────────────────────────────────────────────────────────────
```

- 实例键去重：`pageType@scopeKey`，同一任务只一个 `task-run` 页；再点只激活。
- 关 page ≠ 停 bot（会话在 server）：在跑的页关了要标"后台运行"。
- ~~**前置阻塞项**：`chat-transport-http.watch()` 每 room 一条常驻 SSE，page 一多必然炸~~
  **已解（##stream-mux）**：`GET /api/stream` 一个 app 一条连接 + 话题（`room:<id>`）订阅，
  帧为 `{topic, event}`；`POST /api/rooms/:id/chat` 改成受理即返，事件一律走那条共用连接。
  连接数 = 标签页数，与开多少 page / 房间无关。服务端 `apps/diy2/server/stream.ts`、
  客户端 `pkgs.ts/ui/chat-transport-http/src/hub.ts`，两侧都有用例锁着这条纪律。

---

## 9. 起步计划

### P0（1.5–2.5 天）：一个 pageType（task-run），L0 自由度

**第一小时先验三件引擎事实**（决定后面写法，验不过就要改设计）：
① `group.api.setVisible(false)` 隐藏后，splitter/尺寸/快照 round-trip 是否干净；
② `fromJSON` 载入带 `visible:false` 的快照是否正常；
③ React Compiler 下 `DockviewReact` 的 portal 桥是否正常。

然后：
1. `pkgs.ts/ui/workbench-dock/`（**独立包**，与 `workbench`/`workbench-ui`/`workbench-plugin` 并列）：`model.ts`（类型 + 派生 + validate）、
   `layout.ts`（compile + reconcile）、`registry.ts`（PAGES/VIEWS: 只 task-run）、
   `Workbench.tsx`（每 page 实例一个 `DockviewReact`；intent；持久化）、`theme.css`（`--dv-*` → 现有令牌）
2. 从 `entity-chat` 抽出 4 个 view：`chat`（核心）/ `task.detail` / `room.members` / `job.runs`
   （导航用的任务列表留在侧栏，不进工作区 —— 否则每个任务页都塞一份树）
3. 事件流多路复用（§8）
4. 持久化：`diy2:workbench.v1 = { version, activePageId, pages: PageInstanceDoc[] }`

区域划分取 **A（与 diy1 同构）**：`left(300, tree) | center(1fr, chat) | right(320, members+detail tabs, 默认收起按 policy) `
+ `bottom(320, jobs, 默认收起)`。它是常量，改起来只动 `registry.ts` 一处。

验收（每条可写成 intent 测试）：点任务 → 开/激活页且不重复开；拖分屏线、收起/展开右栏、最大化 chat；
关 tab 后再打开能回来；刷新后状态原样回来；模板加一个 view 后旧用户数据能 reconcile 出来（不丢尺寸）；
关 page 后 bot 继续跑且标得出；6 个页同开 + 发消息不断流；`resetLayout` 回模板。

**不做**：多 pageType、子页面、L1、popout、快捷键表、undo。

### P1（2–3 天）：第二个 pageType —— 验证"不同核心同屏共存"（这才是分水岭）

项目页（`subject:'project'`）+ 设置页（`subject:'none'`）；page 条完整（关闭/子页面缩进/后台降级）；
不可见页暂停流与昂贵渲染；切页 `api.layout()`。

### P2：子页面（执行页挂 task-run 下）+ 命令面（intent 暴露 HTTP 给 bot）+ 快捷键。

---

## 10. 风险与止损

| 风险 | 止损 |
|---|---|
| `setVisible` 是核心里有、文档没写的口子，行为可能不干净（间隙、splitter、maximized 冲突） | P0 第一小时实测；不干净就退回"删组重建 + 模板决定回位"，模型只改 `collapseArea` 一个 intent |
| 单一真源 + reconcile 的复杂度被低估 | reconcile 是纯函数，先写测试（旧快照 × 新模板的 6 种情形）再接 UI |
| `Orientation` 写反（HORIZONTAL = 兄弟横排） | compile 里 `split.dir==='row' ⇔ HORIZONTAL` 断言 + 快照快照断言 |
| 模板想要"真正交错"的布局（C1 表达不了） | 评审新 pageType 时先画树；表达不了就改页面设计，不改引擎 |
| 快照随 dockview 版本失效 | `layoutVersion` 字段；不匹配就丢快照、按模板重建（模板永远能重建） |
| 隐藏 page 仍在跑（SSE/定时器/虚拟滚动） | 页可见性降级 + 页数上限（先 5） |
| 收费功能被默默当免费 | 验收清单里不写 undo/pinned/edge/键盘 docking |
| 词汇漂移（diy1 的 `instanceScope`/`hidden` 与新版混用） | §5 那张表就是映射表，新增词必须先改表 |

---

## 11. 要改的既有文档 & 缺口

**要改**：`docs/ui-architecture.md` §6（dockview POC → diy2 工作台 P0 进行中，并写明三个 workbench 包不含 diy2）；
`docs/plans/2026-11-13-dockview-integration.md`（补 area 排布改区域树、8.9.1 CSS 随包发布、enterprise 分界）；
`view-registry.ts` 顶部注释加一行指向 `pkgs.ts/ui/workbench-dock/src/model.ts`（谁是权威）。

**缺口**：① 事件流多路复用 ② compile/reconcile/validate ③ 每 page 实例一个 DockviewReact 的切页策略
④ 从 App.tsx 抽 4 个 view ⑤ `--dv-*` 主题映射 ⑥ 深链/intent ⑦ intent 测试 + 拖拽 e2e。
