# @diy-agent/workbench-dock

**页（page）为一级概念的工作台布局引擎**：一个页围绕一个领域主概念展开，view 落进页里的各个区域。
布局交给 [dockview]（分屏 / tab / 拖拽 / 序列化），本包只负责「模板 → 布局」和「布局 × 模板 → 新布局」。

> 状态：实验包（worktree `exp/workbench-dock`）。**范例在 [`examples/`](./examples/)**（自带 vite 工程，不依赖任何 app）。

## 30 秒

```tsx
import { area, col, definePage, defineView, row, type Scope } from '@diy-agent/workbench-dock';
import { PageWorkbench, usePageApi } from '@diy-agent/workbench-dock/react';

interface TaskScope extends Scope {
    title: string;
}

// ① 页 = 区域树（左 / 中 / 右，下面再来一条跨列的底栏）
const taskPage = definePage<TaskScope>({
    type: 'task-run',
    title: (scope) => scope.title,
    areas: col([
        row([
            area('left', { size: 280, min: 200 }),
            area('center', { size: '1fr', min: 380 }),
            area('right', { size: 280, initial: 'collapsed' }),
        ]),
        area('bottom', { size: 220, initial: 'collapsed' }),
    ]),
});

// ② view = 内容 + 它想进哪个页的哪个区域
const chatView = defineView<TaskScope>({
    id: 'chat',
    title: '对话',
    placement: { 'task-run': { area: 'center', primary: true } },
    render: {
        kind: 'react',
        component: function Chat({ scope }) {
            const api = usePageApi();
            return (
                <div>
                    <b>{scope.title}</b>
                    <button onClick={() => api.toggleArea('right')}>成员</button>
                </div>
            );
        },
    },
});

// ③ 挂载一个页实例
<PageWorkbench
    page={taskPage}
    views={[chatView, detailView, membersView]}
    scope={{ kind: 'task', id: 't-1', title: 'workbench 抽包' }}
    storage={localStorage}
/>;
```

## 三个概念

| 概念 | 是什么 | 代码里 |
|---|---|---|
| **page** | 一个领域主概念的一次呈现（一个任务 / 一个项目 / 一次工作流执行） | `definePage({ type, title, areas })` |
| **area** | 布局上的一个格子（左 / 中 / 右 / 底）；只管位置，不懂业务 | `area('center', { size, min, initial })` |
| **view** | 真正的内容单元（对话 / 详情 / 成员 / 作业） | `defineView({ id, placement, component })` |

**依赖方向是 view → page**：view 声明「我能进哪些 pageType 的哪个区域」，page 一个 view id 都不认识。
加一个 view = 加一个文件；改页的模板不需要知道有哪些 view 存在。

## API

### `definePage(def)` / `defineView(def)`

```ts
interface PageDef<S extends Scope> {
    type: string; // 'task-run' / 'project' …
    title: string | ((scope: S) => string);
    icon?: string;
    areas: AreaNode; // 区域树
}

interface ViewDef<S extends Scope> {
    id: string; // 全局唯一，也是 dockview 的 panel id
    title: string | ((scope: S) => string);
    icon?: string;
    placement: Record<string, Placement>; // pageType → { area, primary?, order? }
    render: ViewRender<S>; // 怎么画：React 组件，或框架无关的 create 函数
}

/** 判别字段是 kind；两条支路都拿到完整 ViewProps（含 api） */
type ViewRender<S extends Scope> =
    | { kind: 'react'; component: ComponentType<ViewProps<S>> } // 写错包名 tsc 报错
    | { kind: 'vanilla'; create(props: ViewProps<S>): VanillaView<S> };

interface ViewProps<S extends Scope> {
    scope: S; // 本页的核心对象
    page: PageInfo; // { type, id（'task-run@task:t-1'）, title, icon }
    areaId: string; // 本 view 所在的区域
    api: PageApi; // 区域控制面
}
```

`definePage` 在**定义时**就把能查的错查掉（运行期不再校验）：

- 区域 id 唯一；
- 区域树的轴必须交替（dockview 的 grid 按嵌套深度换方向，两层 `row` 表达不出来）。

还有两条要**两边对上**才查得出来（`defineView` 不知道页的模板，`definePage` 不知道有哪些 view），
所以放在编译期：

- `placement.area` 必须是该 pageType 里真实存在的区域；
- 同一区域至多一个 `primary`。

写错了不会白屏：`<PageWorkbench>` 会拦下来，在区域里显示这句错误 + 一个「回到模板」按钮。

### 区域：`row([...])` / `col([...])` / `area(id, opts)`

```ts
area('center', { size: '1fr', min: 380, initial: 'collapsed', hideHeader: true });
row([area('left'), area('center')], { size: '1fr' }); // 左右排
col([area('top'), area('bottom')]); // 上下排
```

- `size`：数字 = px；`'1fr'` = 同父兄弟间分剩余空间；
- `min`：落成 dockview 的组约束（拖不到更小）；
- `initial: 'collapsed'`：进页时收起，但**尺寸会记住**（展开时原样回来）。

> 区域是**树**不是网格：`col([row([左,中,右]), 底])` 才能让底栏跨三列。

### `<PageWorkbench>`

| prop | 类型 | 说明 |
|---|---|---|
| `page` | `PageDef<S>` | 页模板 |
| `views` | `ViewDef<S>[]` | 本页用的 view（缺省全部） |
| `scope` | `S extends Scope` | 页的核心对象 |
| `storage` | `{ getItem, setItem, removeItem }` | 传了才持久化布局（localStorage / 后端 KV 都行） |
| `storageKey` | `string` | 缺省 `workbench-dock:<pageType>@<kind>:<id>` |
| `editable` | `boolean` | `true` = L1（允许拖 view 换区）；缺省 L0（结构锁死） |
| `onLayoutChange` | `(saved: SavedLayout) => void` | 布局变化（节流到一帧） |
| `onStorageError` | `(error: unknown) => void` | 布局存不下（配额满 / 隐私模式 / 后端拒写）；页照常用，但下次进来回模板 |
| `theme` / `className` | | 透传给 dockview / 外层容器 |

**一个 page 实例 = 一个组件实例。** 切页就是换 `key`：

```tsx
<PageWorkbench key={scope.id} page={taskPage} views={views} scope={scope} storage={localStorage} />
```

### `usePage()` / `usePageApi()`

view 里想控制布局就调它，不要碰 dockview：

```ts
interface PageApi {
    showArea(areaId: string): void;
    hideArea(areaId: string): void;
    toggleArea(areaId: string): void;
    isAreaVisible(areaId: string): boolean;
    maximizeArea(areaId: string | null): void; // null = 退出最大化
    isAreaMaximized(areaId: string): boolean; // 这个区域是不是最大化（一个区域一个答案）
    skippedAreas(): string[]; // 诊断：模板里有、但没有任何 view 落位的区域
    closeView(viewId: string): void; // 关掉某 view（记进 dismissed，不会自己回来）
    openView(viewId: string): boolean; // closeView 的逆操作；返回有没有真开出来
    resetLayout(): void; // 丢掉用户布局，回到模板
}
```

`skippedAreas()` 读的是**上一次灌进 dockview 的那份编译结果**：一个区域没出现在布局里，
原因只可能是「这个区域声明了，但没有任何 view 落位」（view 没注册 / placement 写错）。
模板本身合法，所以它不是错误 —— 但它是唯一能让你发现「我声明的区域怎么没出来」的线索。

`openView` 三种情况：已经在布局里 → 只激活它；被关掉过 → 从 `dismissed` 里去掉再插回它声明的区域；
这个 view 不属于本页 / 它声明的区域没落进布局 → 返回 `false`。

```ts
// 宿主侧的一个按钮：「把成员列表开回来」
<button onClick={() => api.openView('members')}>成员</button>
```

### 纯函数（单测/工具用，无 React）

```ts
compileLayout({ page, views, scope, viewport }): CompiledLayout
resolveLayout({ page, views, scope, viewport, saved }): CompiledLayout // 旧布局 × 新模板
summarize(layout.grid.root): string // '(left[detail] ; center[chat])'
```

## 行为

**只在一条真源上工作：dockview 的布局快照。** 模板不是第二份布局，它只是编译器的输入。

| 场景 | 行为 |
|---|---|
| 首次进页（storage 空） | `compileLayout`：模板 → 布局 |
| 用户拖分屏线 / 收起展开 / 关 tab / 切 activeView | dockview 自己记；变化节流后写进 `storage` |
| 用户拖分屏线 | 按这次拖动的**位移**记账：数字区记 px（`pinnedSizes`），`1fr` 区记组内比例（`shares`） |
| 窗口变大变小 | 不重建布局：dockview 自己跟着容器重排；`1fr` 下次编译时按新宽度重新分配 |
| 再次进页 | 读 `storage` → `resolveLayout` |
| 模板改了（加/删 view、改区域） | `resolveLayout(旧快照 × 新模板)`：保尺寸/展开/tab 顺序（R1），新 view 按 `order` 插进来（R2/R4），模板删掉的区域丢弃（R3） |
| 用户关掉的 view | 记在 `dismissed[]`，模板重编译时**不会自动加回来**（否则「我关的」和「新加的」分不清） |
| 全都关掉 | 回落到模板（不留空壳） |

**自由度两档**（产品缺省 L0）：

| 档 | 能力 | 实现 |
|---|---|---|
| **L0** | 拖分屏线、收起/展开区域、关/开 tab | `disableDnd` + `disableFloatingGroups` |
| **L1** | 再把 view 拖进它 `allow` 的区域 | `editable` → `disableDnd: false` + `onWillShowOverlay` 拦落点 |

L1 的落点是**有名单**的：`placement.area` 永远允许，额外的写进 `placement.allow`。
`editable` 打开的是「能拖」，不是「能拖到任何地方」——拖进没声明过的区域，这个 view
就再也说不清自己在哪（它的 `params.areaId`、它调 `api` 时的区域都成了假的）。
所以：拖整组、拖到区域边缘（会在模板之外新开一个组）、拖进名单外的区域，一律 `preventDefault`。
真拖成了，`onDidMovePanel` 会把 `params.areaId` 改过来。

L2（自由 docking）/ L3（页面存成可分享透视图）**不做**。

`SavedLayout` 的形状（`storage` 里存的就是它）：

```ts
{
  version: 1,
  pageType: 'task-run',
  scopeKey: 'task:t-1',
  dock: SerializedDockview,          // dockview api.toJSON() 原样
  dismissed: string[],               // 用户关掉的 view id
  maximizedArea?: string,            // dockview 快照不含最大化
  pinnedSizes?: Record<string, number>, // 用户拖出来的 px（只记模板写死数字的区域）
  shares?: Record<string, number>,      // 用户拖出来的比例（只记"整组都是叶子"的组里那些 1fr 区域）
  movedViews?: Record<string, string>   // L1 拖过的落点：view id → 区域 id
}
```

**为什么尺寸要单独记，而不是直接读快照里的 `size`**：快照里的 `size` 是「上一次那次编译」
的产物，混着用户拖拽、dockview 的钳制、以及当时那个窗口的尺寸 —— 事后分不清哪个是用户的意思。
所以规则简化成两条，**按区域是固定还是弹性分工**：

- **模板里写死数字的区域 → 钉 px**（`pinnedSizes`）：用户拖过就按用户拖的 px，没拖过就按模板；
- **模板里写 `'1fr'` 的区域 → 钉比例**（`shares`）：组内按权重分「当前 viewport − 固定区占掉的」。
  `1fr` 表达的就是「我不决定这块多宽」，钉 px 等于把某一刻的窗口尺寸烧进布局；比例换窗口也成立。

**份额整组一起采信**：一组弹性成员里只要有一个没记过份额，全组都回到模板的 `fr`。
一半份额一半 `fr` 是两套权重，混算的结果没法预测。比如模板给这个组新加了一个 `1fr` 区域，
旧快照里的份额就缺一份 —— 这时整组回模板（看得懂，而不是一半保住一半乱分）。

> 边界：份额按**区域 id** 存，而 dockview 的分支节点没有 id，所以只有「整组都是叶子」的组能记比例。
> 嵌套分割（`col(row[a|b] | c)` 里那条横线）拖出来的比例记不下来 —— 那层要么写数字尺寸，要么跟着模板。
> 单看一条组里只剩**一个**弹性成员时也不记：它总是吃剩下的，份额没有第二个解。

**记账按位移，不按「实测 vs 重编」的差**。两个原因，都是实打实踩过的：

- dockview 渲染出来的宽高**不是**编译给它的 px：每组都被扣掉 `theme.gap` 的一份
  （`margin × sashCount / visibleCount`，默认主题 gap 10、三组就是每组 −6.7）。
  拿实测当模板值会记少一点，下次进来再少一批 —— 越拖越窄；
- 容器缩放、收起/展开、最大化、首次 `fromJSON` 之后**都会**来一条 `geometry` 事件，
  「实测 ≠ 重编」在这些情况下天然成立，但一条都不是用户的意思。
  顺带一个坑：`onDidLayoutChange` 是 `AsapEvent`（`queueMicrotask` 合帧），
  `fromJSON` 期间同步置位的 `applying` 标志根本罩不住它。

所以：只有从分屏线（`.dv-sash`）上 `pointerdown` 到 `pointerup` 之间才有「拖动前的实测」基准，
记账 = **上次的逻辑尺寸 + 位移**（差值正好把 gap 份额抵消掉）。没在拖 → 这条事件不记账。
收起 / 最大化的组尺寸是失真的（~0 / 满屏），量出来的「位移」没意义 —— 那种组整个跳过。
比例走同一套位移：拖的是分屏线，所以只会有一个方向真变（两个都变 = 布局重排的余波，不记）。

**编译出来的 px 必须等于渲染出来的 px**（± gap 份额）。所以 `distribute` 最后一步是**归一**：
一组兄弟的尺寸一定拉满父容器。留洞的话 dockview 的 `proportionalLayout` 会替我们做，
于是「模板尺寸」和「屏幕上的尺寸」就是两个数，位移记账、`min` 约束、测试全都跟着错。

**存储读回来先校验**：`version` / `pageType` 对不上，或者 grid 树的形状不是我们写得出来的样子
（用户手改过 localStorage、旧版本写坏过）→ 一律当没存过，回模板。宁可丢掉用户布局，也不把畸形树喂给 `fromJSON`。

## 跑范例

```bash
cd pkgs.ts/ui/workbench-dock
./sha.sh dev        # 例子的 vite（root = examples/），打开打印出的地址
./sha.sh examples   # 只做生产构建（CI / 提交前验证例子没烂）
```

四个例子，按顺序看（索引页 `/index.html`，细节见 [`examples/README.md`](./examples/README.md)）：

| #   | 目录                                                    | 讲什么                                                                                  |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 01  | [`examples/01-basic/`](./examples/01-basic/)            | 一个页实例：区域树 + 三个 view + 布局持久化 + L0/L1                                     |
| 02  | [`examples/02-pages/`](./examples/02-pages/)            | 多页实例：**导航条不属于本包**，页实例身份 = `pageId()`，`key` 决定是不是同一份布局     |
| 03  | [`examples/03-plugin/`](./examples/03-plugin/)          | page 插件化：插件 = 包（`package.json` 的 `contributes`）+ 宿主骨架（`skeletons.ts`） |
| 04  | [`examples/04-vanilla/`](./examples/04-vanilla/)        | 非 React view：`render.kind: 'vanilla'` 的 `create` / `update` / `dispose`              |

四个例子互不 import（一个目录里就 `index.html` + `main.tsx` + `style.css`），任何一段都能
单独抄走；重复的那几十行定义是故意的。

例子是**唯一**的手验场所：改了 UI 层（`src/react/`）就在 `01-basic` 里点一遍，`./sha.sh examples`
验证构建，单测只覆盖纯模型（`tests/`）。

## 不做 / 边界

- **不碰**路由与侧栏（页怎么被打开、导航条、页列表，都在宿主）。多页 = 宿主自己拿一个数组渲染
  若干 `<PageWorkbench>`，例子在 [`examples/02-pages/`](./examples/02-pages/main.tsx)（约 130 行，含两个 view）。
- **不管插件加载**：包只接受 `PageDef` / `ViewDef`；「插件清单 → 这两个东西」是宿主的组装活儿，
  形状见 [`examples/03-plugin/registry.ts`](./examples/03-plugin/registry.ts)。
  清单里**只写「插在哪」**（页类型 + 骨架名 + 槽位名），区域树/尺寸归宿主的骨架 ——
  和 theia 的 `viewsContainers` / `views` 是同一个划分，对照见
  [`examples/README.md` 第二节](./examples/README.md)。
- **不带主题**：dockview 是浅色内置主题，暗色由宿主用 `--dv-*` 变量覆盖（可直接抄
  [`examples/01-basic/style.css`](./examples/01-basic/style.css) 最后一段）。
- **一份快照只属于一个页实例**，不做跨页共享的「工作区」。
- 想同时显示两个页 = 两个 `<PageWorkbench>` 并排（本包的模型里没有「跨页的 dock」）。

[dockview]: https://dockview.dev
