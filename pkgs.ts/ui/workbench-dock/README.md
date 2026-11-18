# @diy-agent/workbench-dock

**页（page）为一级概念的工作台布局引擎**：一个页围绕一个领域主概念展开，view 落进页里的各个区域。
布局交给 [dockview]（分屏 / tab / 拖拽 / 序列化），本包只负责「模板 → 布局」和「布局 × 模板 → 新布局」。

> 状态：实验包（worktree `exp/workbench-dock`）。范例页在 `apps/diy2/src/dock-demo.tsx`（`/dock.html`）。

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
    component: function Chat({ scope }) {
        const api = usePageApi();
        return (
            <div>
                <b>{scope.title}</b>
                <button onClick={() => api.toggleArea('right')}>成员</button>
            </div>
        );
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
    component: ComponentType<ViewProps<S>>;
}

interface ViewProps<S extends Scope> {
    scope: S; // 本页的核心对象
    page: PageInfo; // { type, id（'task-run@task:t-1'）, title, icon }
    areaId: string; // 本 view 所在的区域
    api: PageApi; // 区域控制面
}
```

`definePage` 在**定义时**就把能查的错查掉（运行期不再校验）：

- 区域 id 唯一；
- 区域树的轴必须交替（dockview 的 grid 按嵌套深度换方向，两层 `row` 表达不出来）；
- `placement.area` 必须存在；
- 同一区域至多一个 `primary`。

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
    isAreaMaximized(): boolean;
    closeView(viewId: string): void; // 关掉某 view（记进 dismissed，不会自己回来）
    resetLayout(): void; // 丢掉用户布局，回到模板
}
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
| 再次进页 | 读 `storage` → `resolveLayout` |
| 模板改了（加/删 view、改区域） | `resolveLayout(旧快照 × 新模板)`：保尺寸/展开/tab 顺序（R1），新 view 按 `order` 插进来（R2/R4），模板删掉的区域丢弃（R3） |
| 用户关掉的 view | 记在 `dismissed[]`，模板重编译时**不会自动加回来**（否则「我关的」和「新加的」分不清） |
| 全都关掉 | 回落到模板（不留空壳） |

**自由度两档**（产品缺省 L0）：

| 档 | 能力 | 实现 |
|---|---|---|
| **L0** | 拖分屏线、收起/展开区域、关/开 tab | `disableDnd` + `disableFloatingGroups` |
| **L1** | 再把 view 拖到 `allow` 的区域 | `editable` → `disableDnd: false` |

L2（自由 docking）/ L3（页面存成可分享透视图）**不做**。

`SavedLayout` 的形状（`storage` 里存的就是它）：

```ts
{
  version: 1,
  pageType: 'task-run',
  scopeKey: 'task:t-1',
  dock: SerializedDockview,   // dockview api.toJSON() 原样
  dismissed: string[],        // 用户关掉的 view id
  maximizedArea?: string,     // dockview 快照不含最大化
}
```

## 跑范例

```bash
# worktree 里
./sha.sh sync
./apps/diy2/sha.sh lab        # 单端口 dev
# 浏览器打开打印出的 URL + /dock.html
```

范例页演示：四个 view（详情 / 对话 / 成员 / 作业）、两个任务页实例（各自的布局）、L0↔L1 开关、
「展开成员区」调 `api.showArea`、「收起本区域」调 `api.hideArea`。

已验证（headless Chrome，1440×900）：

- 首次进入：成员 / 作业收起（宽 0 / 高 0）；
- 点「展开成员区」→ 成员 280px，对话 1092→812；刷新仍在；
- 拖左/中分屏线 348→458，刷新仍在；
- 关掉作业 tab → `dismissed:["job.runs"]`，刷新不回来；
- 切到任务 B = 另一个 page 实例，布局独立；控制台零报错。

## 不做 / 边界

- **不碰**路由与侧栏（页怎么被打开、tab 条上的页列表，都在宿主）。
- **不带主题**：dockview 是浅色内置主题，暗色由宿主用 `--dv-*` 变量覆盖（见 `apps/diy2/src/dock-demo.css`）。
- **一份快照只属于一个页实例**，不做跨页共享的「工作区」。
- 想同时显示两个页 = 两个 `<PageWorkbench>` 并排（本包的模型里没有「跨页的 dock」）。

[dockview]: https://dockview.dev
