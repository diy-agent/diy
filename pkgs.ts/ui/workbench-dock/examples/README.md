# `examples/` —— 五个例子

例子是本包**唯一**的手验场所：纯模型（`src/model.ts` / `src/compile.ts`）有单测，
UI 层（`src/react/`）只在浏览器里看得出来。**加能力先加例子，再改 API。**

每个例子是**自包含**的一个目录：`index.html` + `main.tsx` + `style.css`。`main.tsx` 里连
page / view 定义一起写，例之间零 import —— 任何一段都能整块抄走，也不用先读懂一份公共的
「领域模型」才看得懂第一页。那几个重复的定义是故意的。

```bash
cd pkgs.ts/ui/workbench-dock
./sha.sh dev        # 例子的 vite（root = examples/），打开打印出的地址
./sha.sh examples   # 只做生产构建（验证五个入口都还能构建）
```

vite 的 `input`、本文件的表格、`index.html` 的卡片**三处必须同步**：

| #   | 目录         | 讲什么                                                                     | 一句话结论                                                          |
| --- | ------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 01  | `01-basic`   | 页 = 区域树；view 用 `placement` 落位；布局持久化；L0 / L1                 | 一个页实例 = 一个 `<PageWorkbench>`                                 |
| 02  | `02-pages`   | 同一模板开两份实例；页实例身份 = `pageId()`；`key` 的作用                  | **导航条不属于包** —— 十几行宿主代码，包只管一个页                  |
| 03  | `03-plugin`  | 插件 = 一个包（`package.json` 的 `contributes` + `index.tsx`），骨架归宿主 | 插件说「插在哪」，宿主说「长什么样」—— 所以清单里没有一个尺寸       |
| 04  | `04-vanilla` | `render.kind: 'vanilla'`：`create` / `update` / `dispose`                  | 非 React view 拿到的 props 和 React view **完全一样**，少的只是框架 |
| 05  | `05-board`   | 集合页（任务管理器）：`scope.id` = 集合标识；选中项走 `useShared()`        | 换选中项不是换页实例 —— 不重编译、不丢用户拖的尺寸                  |

---

## 一、多页：谁负责什么

01 讲「一个页的内部布局」，02 讲「宿主怎么同时管好几个页」—— 两层不同的东西：

```
01-basic                            02-pages
┌──────────────────────────┐        ┌────────┬──────────────────────────┐
│ 顶栏：L1 开关            │        │ rail   │ 当前 page（一个实例）     │
├──────────────────────────┤        │ 任务   │ ┌──────────────────────┐ │
│ 一个 <PageWorkbench>     │        │ · t-1  │ │ 详情 │ 对话           │ │
│  center / right / bottom │        │ · t-2  │ └──────────────────────┘ │
└──────────────────────────┘        └────────┴──────────────────────────┘
```

**包的边界是「一个 page 的布局」。** 页的打开 / 关闭 / 切换 / 导航条长什么样，全在宿主 ——
这就是为什么 02 里的 rail 是例子代码而不是某个 `<PageShell>` 组件。宿主可能要点的是：

- 竖导航条（VS Code 风）· 顶栏页签（浏览器风）· 命令面板 · 从对话里开一个新页
- 页实例来自路由 / 会话 / 后端列表 / 用户点 +

这些都是宿主的形态选择，包替它定死 = 又要被绕过。

四个必须自己接的点：

```tsx
// ① 有哪些页实例 —— 例子是数组，真宿主来自路由 / 会话 / 后端
const scopes = [
    { kind: 'task', id: 't-1', title: '…' },
    { kind: 'task', id: 't-2', title: '…' }, // 同模板，另一份布局
];

// ② 页实例的身份 —— 本来就唯一且可寻址，直接当 URL 段用
const id = pageId(taskPage.type, scope); // 'task@task:t-1'

// ③ 切换的记账 —— 例子是一个 useState；真宿主写进 hash / 路由，刷新和分享链接就都对了
const [current, setCurrent] = useState(scopes[0]);

// ④ 渲染（key 必须有：不带 key 就是在同一实例上换 props，dockview 会试图合并两份布局）
<PageWorkbench
    key={pageId(taskPage.type, current)}
    page={taskPage}
    views={views}
    scope={current}
    storage={localStorage}
/>;
```

有一个坑在这四步之外：**`key` 里只能放页实例身份**。放个 `selectedId` 进去，
「列表里换一行」就会变成「换了一个页实例」—— 布局重编译、用户拖的尺寸清空。
选中项这类东西走页内共享状态（`useShared()`，见 [`05-board`](./05-board/main.tsx)）。

### 「任务管理器」算哪一层

一个页实例对应**一组**对象（任务管理器 / 文件浏览器），现在有两种摆法，05 里两层都摆上了：

```
┌────────┬─────────────────────────────┐
│ rail   │ 一个 board 页实例            │
│ 管理器 │ ┌──────┬──────────┬───────┐ │
│ · t-1  │ │ 列表 │ 详情     │ 属性  │ │  ← 这三栏在布局里，能拖、能收
│ · t-2  │ └──────┴──────────┴───────┘ │
└────────┴─────────────────────────────┘
  ↑ 宿主 UI                        ↑ { kind:'board', id:'all' }
```

- **外壳**（页切换、筛选条）归宿主 —— 包不知道「导航」这个概念；
- **内部三栏**是一个 page，`scope.id` 是**集合标识**（`all` / `mine` / `project:p-1`，一个集合一份布局）；
- **当前选中哪条**走 `useShared('selectedTask')`：不换页实例，所以布局不动。

## 二、page 怎么插件化

照抄 theia / VS Code 的边界 —— 它们把「插件」这个词拆得比我们清楚：

|            | 谁写     | 在哪                                | 能来自磁盘 / JSON               |
| ---------- | -------- | ----------------------------------- | ------------------------------- |
| **贡献点** | 插件     | `package.json` 的 `contributes`     | **能** —— 纯数据，加载时校验    |
| **内容**   | 插件     | `index.tsx` 的 `views` 导出         | **不能** —— `render` 装的是代码 |
| **骨架**   | **宿主** | `skeletons.ts`（区域树 + 槽位名）   | 不属于插件                      |
| **装配**   | **宿主** | `main.tsx`：装哪些包 / scope / 存盘 | 不属于插件                      |

**插件说的是「我有什么、插进哪个具名槽位」；宿主说的是「装哪些、何时激活、多大、开哪个实例」。**

### 骨架为什么必须归宿主

theia 的 `sample-plugins/plugin-view-layout` 是最干净的证据：那个插件**一行代码都没有**，
整个插件就是一个 package.json。它声明 4 个 view，每个只带一个标量：

```json
"views": { "plugin-view-layout": [
  { "id": "….small",     "initialSize": 1 },
  { "id": "….large",     "initialSize": 3 },
  { "id": "….collapsed", "visibility": "collapsed" }
] }
```

- `contributes` 里**没有任何键能声明区域树** —— 容器内部怎么排、几行几列、嵌套多深，宿主说了算
- `initialSize` 只是相对比例（1 : 3），不是像素、不是树；README 写明用户拖过之后就被存盘覆盖
- `views` 的 key 可以是**别人的容器**：`"views": { "explorer": [...] }`，README 直说因为
  Explorer 属于别的插件，那里写的 `initialSize` 没有效果

三条我们全抄了。

### 清单长什么样

于是 03 的插件就是一个包 —— `plugins/film/package.json`，20 行，**一个尺寸都没有**：

```json
{
    "name": "film-page",
    "main": "./index.tsx",
    "diy": { "apiVersion": 1 },
    "contributes": {
        "pages": [{ "type": "film", "title": "影片", "icon": "🎬", "skeleton": "three-pane-bottom" }],
        "views": {
            "film": [
                { "id": "film.live", "title": "实时", "area": "main", "primary": true },
                { "id": "film.shots", "title": "分镜", "area": "sidebar" },
                { "id": "film.props", "title": "道具", "area": "aside" },
                { "id": "film.timeline", "title": "时间线", "area": "bottom" }
            ]
        }
    }
}
```

`area` 是**槽位名**（`sidebar` / `main` / `aside` / `bottom`），不是坐标、不是尺寸 —— 名字和大小
都在 `skeletons.ts`，是宿主的词汇表。想加一种布局 = 宿主加一项（要发版）；想加一个业务页 =
插件加一个 package.json（不碰宿主）。

`primary` 留着是因为它有实义：**该槽的默认 tab**。砍掉它，「页一打开激活哪个区域」就退化成
`Object.keys(areas)[0]` —— 骨架内部结构的顺序泄漏出来，比一个布尔更不可控。
`order` 砍了：数组顺序就是顺序，和 theia 一样。

剩下三样同理搬走了：区域树、`size`/`min`/`initial` 进骨架；`view.page` 改成 `views` 的 key。

### 跨插件贡献

`views` 的 key 是**页类型**，不是「我自己的页」。`plugins/insights` 就是一个 14 行清单的插件：
没有 `pages`，只有一行 `views.film = [{ area: "main" }]`。它不知道 film 页有几个区域。

这条能力是插件化的分水岭。清单只能指向自己贡献的页，那插件就永远只能长成
「一个插件 = 一整个页」—— 那不是插件化，是把整页换了个人写。

### 错误也按边界分家

**清单能校验，才配叫清单。** 但校验点跟着边界搬了家：

| 谁写错                                                 | 什么时候炸                                  | 例子里的入口               |
| ------------------------------------------------------ | ------------------------------------------- | -------------------------- |
| 骨架（两层同轴 / 槽位 id 重复）—— **宿主**             | `definePage` 在 `skeletons.ts` 被 import 时 | 宿主自己的 bug，启动就该红 |
| 清单（槽位不存在 / 声明了没实现 / 页不存在 / id 撞车） | `loadPlugins()`                             | 「坏槽位」「没实现」       |
| `apiVersion` 不认识                                    | `loadPlugins()`，整份拒绝                   | —（和旧包同一条规矩）      |

还有两条纪律：

- **scope 永远由宿主给**。插件贡献「页由哪些 view 组成」，`{ kind: 'film', id: 'd-1' }` 是数据、属于宿主。
  插件不许自己造实例（否则「有几个页」就成了插件说了算，宿主没法做导航）。
- **插件之间的 id 不撞车**：`loadPlugins()` 拦 `package.name` / `page.type` / `view.id` 三重重复，
  宿主启动即失败，不静默降级。

### 和 `@diy-agent/workbench-plugin`（旧契约）的关系

旧包贡献的是「视图 + 路由」：`contributes.views[]` 带 `group`（侧栏分组）、`route`、`kind: iframe|builtin`，
**没有 page 概念** —— 每个 view 自己就是一个路由页。新模型把 views 收进页的槽位里：

| 旧 `workbench-plugin`                   | 新 `workbench-dock` + 本 registry                                |
| --------------------------------------- | ---------------------------------------------------------------- |
| `contributes.views[]` + `group`/`route` | `contributes.views{ 页类型: [{ area, primary }] }`               |
| 一个 view = 一个路由页                  | 一个 page = 一个骨架的若干槽位组合，里面多个 view                |
| 只有 iframe / builtin                   | 同仓插件静态链接；外部插件 iframe + RPC（`kind` 的形状照样能用） |
| 清单是独立文件                          | 清单就在包自己的 `package.json` 里（和 theia 一致）              |

两边的 `apiVersion`、清单纯数据、整份拒绝是同一条纪律，将来合并只是补 `contributes.pages`。

## 三、五个例子各自证明什么

**01-basic** —— 布局这件事本身能成立：中心区是「核心 view」，右区和底栏按需展开，
拖分屏线 / 收起区域 / 关 tab 刷新后还在；`editable` 一开就从 L0（结构锁死）变 L1（可拖换区）。

**02-pages** —— 多页是宿主的活儿：同一个 `task` 模板开两份实例（t-1 / t-2），布局互不影响，
但「有几页、叫什么名字」全在宿主（左边那条 rail 是例子代码）。`key` 不给就会变成
「在同一实例上换 props」——dockview 会试图合并两份布局。真宿主把当前页写进 hash / 路由
（`#task@task:t-1`），例子只用一个 `useState`。

**03-plugin** —— 三块插件（film / notes / insights），宿主 `main.tsx` 的加载代码一模一样：

- 加一个业务页 = 一个 `package.json` + 一个 `index.tsx`，**不碰宿主、不碰布局引擎、不发版**
- film 用 `three-pane-bottom` 骨架、notes 用 `two-pane`，差异只有清单里一行 `skeleton`
- insights 只有一行清单：往 film 页的 `main` 槽塞一个 view —— 它连 `pages` 都没有
- 清单写错 → 加载时报错；声明了 view 但代码没实现 → 也报错；view 落在不存在的槽位 → 还报错
- 宿主只提供四样：装哪些包、每个 page 的 scope、骨架长什么样、rail 怎么画

**04-vanilla** —— `render.kind` 是**显式**写在定义里的一次取舍：

```ts
defineView({ id, title, placement, render: { kind: 'vanilla', create(props) { … } } })
//                                                  ↑ react 走 component，vanilla 走命令式契约
```

契约只有三件事：`create` 一次、props 变了调 `update`、销毁调 `dispose`（必须幂等）。
拿到的东西和 React view 完全等价（`scope` / `page` / `areaId` / `api`）。代价也写在那
example 的抬头：子树里没有 `usePage()`，没有错误边界 / Suspense。

**05-board** —— 「任务管理器」这类**集合页**：`{ kind:'board', id:'all' }` 一个实例管四条任务，
列表 / 详情 / 属性三栏在自己的布局里（固定 280 / `1fr` / 收起）。验证三件事：

- 点列表换选中：详情立刻跟着变，但**布局一点没动** —— 拖过的栏宽还在，详情 view 的「挂载 #n」也不变；
- 选中项存在共享状态里（`useShared('selectedTask')`），**不落盘**：刷新 / 切页回来是缺省值，而布局还在 ——
  这正是「布局」和「页面状态」的分界；
- rail 上的 t-1 / t-2 是另一个 pageType（单任务页），换过去 = 换 `key` = 换布局。
  集合页 ↔ 单对象页并存，两者都是页，区别只在 `scope` 指一个集合还是一个对象。
