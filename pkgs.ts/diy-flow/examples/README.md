# `examples/` —— 三个行业工作流范例

三个**同形**的行业工作流（开发 / 视频 / 金融），用代码证明 ##166 §13.3 的那句话：

> **一个新行业 = 换插件 + 换形状 —— 不换拓扑，不写页面。**

三个范例的 **A 层**（拓扑 + 提示词：`nodes` / `edges` / `guard` / `hint`）写法完全一样；
行业差异**只**落在两处：

| 落在哪               | 是什么                                                                                            | 三个范例的实例                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **插件层**（B/C 层） | 引擎查不到的：**读**外部世界（`guard`）· **写**外部世界（`action`）· **译**非文本形状（`render`） | 开发：`ci_green` / `pr_mergeable`；视频：`render_done` / `publish` / `render_board` …；金融：`weight_ok` / `place_order` / `render_bars` … |
| **`anchor` 类型**    | 事件挂在哪种锚点上（这里都挂 `node`，与工作流容器同轴）                                           | `nodeAnchor(节点 id)` —— 三个范例一致                                                                                                      |

## 新增一个行业工作流要写哪些文件

**只有三件套 + 一份测试**（其余全归内核：定义校验 / 单指针推进 / guard 求值 / 打回护栏 / 参数校验 / 状态落盘 / 轨迹投影）：

```
examples/<行业>.ts          ① 泳道图：defineWorkflow 的声明（节点 / 边 / guard / hint / art / params）
examples/<行业>.plugins.ts  ② 插件实现：引擎查不到的那几件事（guard / action / render）—— 唯一写代码处
（宿主侧装配）               ③ 把 ①② 与注册表拼起来：registerXxxPlugins(registry) → createRuntime(def, { registry })
tests/examples.<行业>.test.ts 契约测试：定义 / 轨迹 / view / 事件四条线（照抄 `tests/examples.dev.test.ts`）
```

三条纪律：

1. **只用公开 API**：`examples/**` 从 `@diy/flow` 取东西（像外部工作流包那样写），**不摸 `../src/` 的内部模块**；
   不碰 `fs` / 网络 / 新依赖（真接入是宿主的事，见 ##319）。
2. **先注册齐、再 `createRuntime`**：组合期就按名查 `pred:` / `action:` / `notify`，
   错字（`pred:ci_grenn`）与漏注册当场 `unknown-plugin` —— 不留到「走到那一步」才炸（##166 §13.1）。
3. **测试放 `tests/`**（放 `examples/` 会被 vitest 漏跑）：dev / video / finance 三个范例的测试都走
   「跑完整条轨迹 + 逐步对审计侧重放 + 逐个节点看 view」。

## 通用渲染器契约：`src/view.ts`

**行业不写页面，只写形状翻译**（##166 §14.7）。分工：

```
节点的 art = { raw, renderer, plugin }
                │      │        └── render 插件：把「这个行业的 raw」翻成渲染器要吃的 data（要写代码的唯一处）
                │      └─────────── 引擎侧固定渲染器 id（九种；真源是 src/define.ts 的 RENDERERS）
                └────────────────── 节点产出的原始数据（行业知道长什么样）
```

`src/view.ts`（**纯类型、零运行时代码**）声明**九种渲染器各自吃哪种 `data` 形状**：

| renderer   | data 形状（`src/view.ts`）                                  | 典型行业                        |
| ---------- | ----------------------------------------------------------- | ------------------------------- |
| `doc`      | `{ text }`                                                  | 脚本 / 方案 / 评审正文          |
| `diff`     | `{ lines: { kind, text }[] }`                               | 代码改动                        |
| `table`    | `{ columns?, rows: { cells, tone? }[] }`                    | 键值卡 / 清单 / 检查项 / 委托单 |
| `timeline` | `{ items: { label, start, end, color?, tone? }[], ruler? }` | 分镜 / 排期                     |
| `video`    | `{ src?, poster?, duration?, at? }`                         | 成片预览                        |
| `badge`    | `{ badges: { label, tone }[] }`                             | 状态 / 回执 / 签字              |
| `kline`    | `{ candles: { t, o, h, l, c }[] }`                          | 行情                            |
| `heatmap`  | `{ cells: { value, tint? }[] }`                             | 因子矩阵 / 相关性               |
| `equity`   | `{ nav, drawdown?, markDrawdown? }`                         | 净值曲线 + 回撤                 |

- **不复制 id 清单**：`view.ts` 只有一张**显式形状表** `ShapeMap`（九种 renderer 各一项，见下），
  外加**两道编译期护栏**（`src/view.ts`）：`_ShapeMapIsExhaustive`（`ShapeMap` 的键必须**恰等于** `Renderer`
  全集）+ `ViewShapes`（`Record<Renderer, …>` 映射类型，漏一种就去索引不存在的键）⇒ 内核加 / 删一种渲染器时，
  漏一种 / 多一种都在 `tsc` **当场报错**（真源永远只有 `define.ts` 的 `RENDERERS`，见 ##318 订正 1）。
  ⚠️ **别写成** `ViewShapes extends Record<Renderer, unknown>`：那样漏一种会从基类**继承到 `unknown`**，护栏形同虚设。
- **`tone` 是语义、不是颜色**：行业只说「这行是 ok / warn / danger / muted」，配色归引擎 ——
  行业一给色值，就等于开始写页面了。
- 内核的 `View.payload` 是 `unknown`（内核不认识行业数据）；宿主用 `ViewData<'kline'>` 把形状化。

## 三个范例一览

| 范例         | 泳道 / 节点 | 轨迹                                                                                 | 步数 | 打回              | 插件（`render` + `guard` + `action`） |
| ------------ | ----------- | ------------------------------------------------------------------------------------ | ---- | ----------------- | ------------------------------------- |
| `dev.ts`     | 6           | `clarify→design→implement→review⟲implement→review→ci→merge`                          | 8    | 1（agent 宣布）   | `ci_green` / `pr_mergeable`           |
| `video.ts`   | 9           | `topic→script→storyboard→shoot→cut→render→approve⟲cut→render→approve→checks→publish` | 12   | 1（agent 宣布）   | 6 `render` + 3 `guard` + 1 `action`   |
| `finance.ts` | 7           | `fetch→factor→select→backtest→risk⟲select→backtest→risk→signoff→order`               | 10   | 1（**系统**打的） | 6 `render` + 5 `guard` + 1 `action`   |

—— 同一条泳道图里「`prompt:` 节点由 actor 宣布」「`pred:` / `action:` 节点由系统求值」两种行为共存；
视频的打回是**人 / agent 宣布**的，金融的打回是**系统**打的（`risk` 的 guard 全可观测）：
打回本身也是「可观测性决定谁来推」的另一面。

## 发版时：升为独立包

`@diy/flow` 的 `package.json` 的 `exports` **只有 `"."`** —— 跨包按**子路径** import（`@diy/flow/src/view`）是 hack。因此：

- **通用渲染器契约**（`src/view.ts`）已从 `index.ts` 末尾以 `export type *` **类型导出**：消费者按形状收窄
  `View.payload` 直接 `import type { ViewData, ViewShapes } from '@diy/flow'` —— 纯类型 ⇒ **零运行时代价**
  （不产出运行时成员、不改 `exports` 策略）。宿主 ##320 要按 renderer id 渲染九种 `data`，从这里取形状即可，
  **不必自持第二份形状清单**。
- `examples/**` 目前**只在本包内**被引用：范例自己走 `@diy/flow` 公开面（模拟外部工作流包的写法），
  测试走包内公开面 `../src/index`（含上面这行类型导出）。
- **发版时把 `examples/` 升为独立包**（本仓 `pkgs.ts/*` 一目录一包）：那时行业包按**正式包名**取用，
  子路径（或独立包名）即正式 API，**不必再 hack**。
