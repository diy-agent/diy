# workbench-dock

页（page）/ 区域（area）/ 视图（view）的布局引擎。**实验包**，先看 `README.md` 的 API 再动代码。

## 职责

- 模板（区域树）→ dockview 布局（`src/compile.ts::compileLayout`）
- 旧布局 × 新模板 → 新布局（`src/compile.ts::resolveLayout`）
- 一个 page 实例的 React 渲染器 + `PageApi`（`src/react/PageWorkbench.tsx`）

不做：路由、侧栏、页的打开/关闭、主题、后端、业务。

## 硬约束

1. **`src/index.ts` / `src/model.ts` / `src/compile.ts` 不许有 React、DOM、Node 运行时依赖**（`import type` 可以）。
   纯模型是单测的地方（`tests/`），也是将来给别的渲染器复用的地方。
2. **布局只有一份真源**：dockview 快照。不要引入第二份「binding / hidden / hiddenViews」状态；
   要从布局里读什么，就写一个纯函数从快照读。
3. **`fromJSON` 之后必须显式 `setVisible`**：dockview 反序列化时组还没挂进 grid，叶子上的
   `visible:false` 对**组**不可靠（实测四个区域全都显示出来）。见 `applyLayout`。
4. **`components` 的引用必须永远稳定**（`useMemo(..., [])`）：变了 dockview 会重挂所有 panel。
   view 外壳从 `PageContext` 读 scope / page / api（在 `<DockviewReact>` **外面**包 Provider），
   从 ref 读 view 列表（`viewsRef`），不从闭包读。视图要新鲜值 → 靠 context 重渲染，不靠重建布局。
5. **区域树轴必须交替**：dockview 按嵌套深度换方向。`definePage` 已校验，别绕过。
6. 尺寸一律在编译期落成 px：`fr` 的语义是「同父兄弟分剩余空间」，运行期不再换算。
   用户拖出来的 px 只对**模板里写死数字**的区域生效（`SavedLayout.pinnedSizes`）——
   别把 `fr` 钉住，那不是用户的意图，是把当时的窗口宽度烧进了布局。
7. **view 的渲染方式在 `render.kind`**（`'react'` / `'vanilla'`）。非 React view 由 `VanillaHost` 驱动，
   它只有三条契约：`create` 只跑一次、props 变调 `update`、`dispose` 必须幂等（StrictMode 双挂载）。
   不要给它加第四条 —— 它要的就是薄。
8. **不要「为了不依赖 React」去改壳**：壳是 React，`ViewProps` 就是 `PageContextValue` 的超集，
   props 同步继续用 effect 驱动。只有叶子（view）可以换框架。
9. **布局 effect 的依赖只能是 `layoutSignature()` 那个字符串**（实际 deps：`ready` / `sized` / `layoutKey`）。
   容器尺寸尤其不能进依赖：dockview 自己跟着容器重排，我们再 `fromJSON` 一遍就是把所有 panel 重挂
   （`ResizeObserver` 只负责把 `sized` 翻 true，不负责重编）。
   调用方把 `page` / `views` / `scope` 写成内联对象是常态，拿对象身份当依赖同理。
10. **`fromJSON` 之前先把快照验一遍**（`resolveLayout` 里的 `isDockNode`）。快照在 localStorage 里，
   用户手改过、旧版本写坏过都是常态：一律当没存过回模板，宁可丢布局也不要白屏。
   外壳那一层还有 try/catch 兜底 → 区域里显示错误 + 「回到模板」。
11. **快照里的三份用户意图要分开记**：`pinnedSizes`（拖过的尺寸）/ `movedViews`（L1 拖过的落点）/
   `dismissed`（关掉的 view）。它们都是「优先于模板」的输入，但**都必须先校验再用**：
   尺寸只认模板里写死数字的区域，落点只认 `area` + `allow` —— 快照是用户数据，脏了就忽略，不要抛。
12. **存储会拒绝你**：`setItem` 配额满 / 隐私模式 / 后端 KV 拒写都会抛，而它在 rAF 回调里
   （没人接）—— 一律 try/catch 后报 `onStorageError`。页继续用，但不能假装存上了。

## 测试

```bash
./sha.sh check       # typecheck + lint + vitest
```

`tests/compile.test.ts` 覆盖：px 换算 / 收起 / primary / order / 轴交替 / placement 越界 /
`allow` 校验与 L1 落点 / R1–R4 /
dismissed / pinnedSizes（含「快照里的 size 不采信」）/ 坏快照回落 / 回落模板。
UI 层不写单测（它只是把纯函数的结果喂给 dockview）：改动 UI 层就在 `examples/` 里手验 ——
`./sha.sh dev` 起例子的 vite（root = `examples/`），`./sha.sh examples` 验证四个入口都还能构建。

## examples/

范例是**本包自己的**，不寄生在任何 app（`apps/diy2` 里已没有 dock 入口）。
`01-basic` / `02-pages` / `03-plugin` / `04-vanilla` 一个比一个多一层宿主责任；新增能力先加例子再改 API。
`vite.config.ts` 的 input 与 `examples/README.md` 的表格**必须同步**（加例子忘登记 = 没人看得到）。

每个例子**自包含**：`index.html` + `main.tsx`（含自己的 page / view 定义）+ `style.css`，例之间
零 import。改动任何一个例子，不需要去改另一个——这是故意的，代价是几十行重复定义。

`04-vanilla` 里有一个**无框架 view**（手写 DOM）与 React view 同处一页。它自报 create / update
次数 —— 拖 tab 时 create 号不变就证明 dockview 是**移动 DOM** 而不是重建 panel（源码：
`dockview-core/src/dockview/components/panel/content.ts::renderPanel`）。
