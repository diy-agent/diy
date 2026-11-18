# workbench-dock × dsh dockkit 架构对照

> 对照对象：`@deepseek-ai/dsh-client-ui-dockkit@0.2.2-rc.1`
> 源码：`~/git-ref/deepseek-harness/packages/client/ui-dockkit`（4613 行，engine 约 2100 行 / components 约 1700 行）
> 我们这边：`pkgs.ts/ui/workbench-dock`（1174 行，compile 406 / model 233 / PageWorkbench 276）

## 0. 一句话结论

**两边不是同类物，重叠只在渲染那一层。**

- 我们做的是**模板编译层**：`page → area(树) → view(tab)` 声明式模型，编译成一份布局快照，然后交给 dockview 去跑。
- dockkit 做的是**可逆操作引擎 + 渲染**：`LayoutOp` 序列 → `applyOp` → (state, inverse) → 线性历史；没有 page，没有模板，`kind` 是它从不解释的字符串。

所以「抄 API」这个动作本身要小心：它的 API 形状默认了「变更是一条条 op」，而我们现在的形状默认了「变更由 dockview 自己发生，我们只读写快照」。

## 1. 模型对照

| 维度 | workbench-dock | dockkit |
|---|---|---|
| 布局真源 | dockview 快照 `api.toJSON()`（`src/react/PageWorkbench.tsx:98`） | `LayoutState`：`nodes` + `rootId` + `floats`（`src/contract/types.ts:104-118`） |
| 层级 | page → area 树 → view | pane 树 → tab；**无 page 概念** |
| 身份 | `view.id` 全局唯一；页实例 `type@kind:id`（`src/model.ts::pageId`） | `TabRecord { id, kind, contentId, title }`，`kind` 不解释、`contentId` 用于去重聚焦 |
| 模板 | 有：`AreaNode`，作者写，`definePage` 校验 A1/A2 | **无**：新格子装什么由 `TabFactory` 决定 |
| 变更 | dockview 内部状态机；我们只 `onDidLayoutChange` 旁观 | 20 种 `LayoutOp`，**每个 op 自带它要用的新 id** |
| 撤销 | 无 | `applyOp` 返回 inverse；`Sequencer` 线性历史；连续 focus-only 段落折叠成一步（`engine/sequence.ts:126-141`） |
| 持久化 | `SerializedDockview` | `LayoutState` + `History`，纯数据 |
| 浮窗 | 没开（dockview 支持 floating group，我们没用） | 一等公民：`float/unfloat/moveFloat/resizeFloat` + `FloatLayer`（spring、视口 clamp、越界 120px 抵抗） |
| 文案 | 组件里写死中文 | 全部经 `DockLabels` 注入，含 ARIA 名 |
| 宿主概念 | 有（page/view 就是 diy 的概念） | 零（自述「Harness 是第一个嵌入方，这里的代码对它一无所知」） |
| 交互上限 | 无（作者模板决定格子数） | `MAX_DOCK_PANES = 4`、`MIN_PANE_FRACTION = 0.12`、`DOCK_EDGE_FRACTION = 0.25`（`engine/constraints.ts:12-24`） |
| 轴约束 | A2：兄弟轴必须交替（dockview grid 按嵌套深度换方向，`model.ts::validateAreas`） | 不需要：真树，任意嵌套同轴都表达得出来 |

## 2. 能力矩阵：我们的 `PageApi` 在 dockkit 里有没有对应物

| 我们的能力（`src/model.ts:146-160`） | dockkit | 说明 |
|---|---|---|
| `showArea` / `hideArea` / `toggleArea` / `isAreaVisible` | **无** | 最近等价物是 `closeTab` + `insertPane(PaneAttachment)` 精确复原（`types.ts:121-129`）。但那是「关闭」语义：body 会卸载，view 内部状态（滚动位置、草稿）丢掉。我们现在 `setVisible(false)` 是保挂载的（`PageWorkbench.tsx:214`）。**这是硬差异。** |
| `maximizeArea` / `isAreaMaximized` | **无** | 只有 surface 级 `mode: 'push' \| 'fullscreen'`（`types.ts:36-45`），不是「某一格最大化」。 |
| `closeView` | `closeTab` ✓ | 且浮动宿主 pane 连带销毁；`canCloseTab` 策略钩子可拦住。 |
| `resetLayout` | 无直接 op | 等价于从头 replay 一份初始 op 序列（需要我们自己写 compile→ops）。 |
| 布局持久化 | ✓ | `LayoutState` 就是 JSON（branded id 运行期是 string）。 |
| 模板增删 view 后的迁移（`resolveLayout`） | **无** | dockkit 没有「模板」这个输入，等价物是一个自写的 reconcile planner。 |
| A2 轴交替校验 | 不适用 | 换引擎的话这条约束可以整条删掉。 |

## 3. 值得抄的三条

1. **op 自带它要创建的 id → 确定性重放。** 这是 undo/redo 能「精确」而不是「近似重建」的唯一原因（`operations.ts:applySplit` 注释与实现）。我们的 `compileLayout` 其实已经是确定性的（区域 id 由模板路径生成：`normalizeAreas` 的 `root.0`），形状上是同一种思想。
2. **一次手势 = 一个 undo 步。** dockkit 把「intent 分组」写进了 `HistoryEntry`，又把连续 focus-only 段落折叠成一步（`sequence.ts:126`）。这条规则比 undo 本身更难写对，**即使引擎不用 dockkit，也建议照抄进我们的语义**。
3. **契约注入。** `DockLabels`（所有文案）/ `TabRenderer`（body）/ `DockIntents`（结算后的手势）/ 三个策略 props（`canSplit` / `canAddTab(paneId)` / `canCloseTab(tabId)`）。我们现在是 React 组件 + `PageApi` 直接耦合，把「文案」和「策略」从组件里抽出来 = 低风险收益。

## 4. 不该抄的两条

1. **`MAX_DOCK_PANES = 4`。** dockkit 是通用套件，冻结一个 4 是合理的 V1；我们的格子数由作者模板决定（典型 3–4，将来某些页 5）。上限属于 `definePage` 的校验，不该进引擎。
2. **用 surface 级 `expanded` 取代 per-area hide。** 见上表：整面收起 ≠ 收起一格但保挂载。这条差异直接决定「能不能直接换引擎」。

## 5. 三条路线

**A. 只借契约（低风险，不解决 undo）**
保留 dockview 与现有快照真源；只把文案/策略抽成 props，把 `PageApi` 收敛成 `Intents` 形状。**不改 AGENTS 硬约束。**

**B. 直接换引擎（大改）**
`PageApi` → `planner` + `DockController`；A2 可删；白得 undo/redo 与浮窗。缺的 hide/maximize 得自己加 op——也就是要 fork 或上游提需求。另外该包自述「内部引擎……导出在任何版本都可能变化」，直接依赖 = 接受这个风险。

**C. 混合：把 op 层拿过来，模板层留下（倾向）**
真源从 dockview 快照换成我们自己的 `LayoutState`（形状借 dockkit 的，实现自写或窄依赖），只实现我们用得到的 op 子集：`openTab / closeTab / moveTab / focusTab / resize / setVisible / setMaximized / setExpanded`；`applyOp` 同时返回 inverse → 免费拿到 undo。渲染层照旧可以是 dockview 的 React API，将来也能换成 dockkit 的 `DockSurface`。
代价：**AGENTS 硬约束 2「布局只有一份真源：dockview 快照」要改写**（这是 C 路线的第一个动作，也是它唯一的架构级让步）。

## 6. 待定的三个点

1. 要不要引入 op 层（= 要不要 undo）—— 这是 A 与 C 的分界。
2. per-area `hide` / `maximize` 是不是硬需求 —— 决定 dockkit 能不能不经修改直接用。
3. 依赖姿态：直接依赖 `@deepseek-ai/dsh-client-ui-dockkit`，还是 clean-room 照抄形状（不带不稳定依赖）。
