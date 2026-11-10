# diy-app UI 框架评估（重新开发视角，不考虑迁移成本）

> 2026-11-10 · 任务 ##518 · 结论先行：**React 19 略优（4.35 / 5），Solid 紧随（4.20）**；
> 差距落在「生态 / LLM 写代码正确率」这两项，不在性能上 —— 因为本项目卡顿的根因在主进程（见 §4），
> 换任何框架都治不了它。组件层建议独立于框架：**Web Components（@material/web + Web Awesome）**。

## 1. 应用画像（决定权重的依据）

| 维度 | 现状 |
|---|---|
| 规模 | 149 文件 / 44,096 行（renderer_solid） |
| 形态 | Electron 桌面工具：密集表格、任务树、聊天流、表单、面板 |
| 数据 | 本地 rpc（`@diy-agent/rpc`）+ 事件流；23 个轮询定时器（1–3 s） |
| 交互 | 拖动 / 快捷键 / 虚拟滚动（`lib/chat-virtual.ts`）/ 富文本流 |
| 团队 | 单人 + LLM agent 写码 |
| 插件 | 需要 VS Code 式插件 UI（插件不能碰宿主 DOM） |

## 2. 评估维度与权重

| 维度 | 权重 | 为什么这个权重 |
|---|---|---|
| LLM / 单人可维护性 | 25% | 代码主要由 agent 写：框架越「一个写法」、类型越强，生成正确率越高，返工越少 |
| 更新粒度 / 运行时开销 | 20% | 大表格 + 流式消息；粗粒度重渲染会直接体现为掉帧 |
| 生态与现成组件 | 20% | 表格/虚拟滚动/表单/图标/测试，自研的每一件都是长期负债 |
| 与 Web Components 互操作 | 15% | 已定 @material/web + Web Awesome，组件层要是 WC |
| 跨进程 / 插件 UI | 10% | 插件隔离（iframe / 数据树）与框架无关，但要有配套 |
| 长期风险（活跃度 / 弃坑） | 10% | 桌面工具的生命周期 ≥ 3 年 |

## 3. 打分（1–5）

| 框架 | LLM 25% | 粒度 20% | 生态 20% | WC 15% | 插件 10% | 风险 10% | **加权** |
|---|---|---|---|---|---|---|---|
| **React 19** | 5 | 3 | 5 | 4 | 4 | 5 | **4.35** |
| **Solid 1.9** | 4 | 5 | 3.5 | 4 | 5 | 4 | **4.20** |
| Vue 3.5 | 4 | 4 | 4.5 | 4 | 4 | 4.5 | 4.15 |
| Svelte 5 (runes) | 3.5 | 5 | 3.5 | 4 | 4 | 4 | 3.98 |
| Lit + 自研壳 | 3 | 4 | 3 | 5 | 5 | 4.5 | 3.85 |
| Angular 18 | 3 | 3 | 4.5 | 3.5 | 3 | 4.5 | 3.53 |

打分说明（关键几条，其余同理）：

- **粒度**：React 需要 memo / useMemo / 手动切片才接近 Solid；44k 行规模下这层纪律很难长期守住 →
  React 3 分、Solid 5 分。Svelte 5 runes 与 Solid 同级。
- **LLM 可维护性**：训练语料里 React 占比压倒性；Solid 的 `createStore` / `batch` / `untrack` 这类
  边界 agent 常写错（本项目里已经出现过「信号读到 effect 外」的问题）。Vue 居中。
- **生态**：表格/虚拟滚动/富文本/图表，React 全有成熟件；Solid 需要移植或自研。
- **WC 互操作**：所有候选都能用 `<md-*>`/`<wa-*>`；差别在「props 传对象」的便利度 —— React 有
  `ref` + `useEffect` 一套明确手法，Solid 也支持但生态例子少。
- **插件 UI**：iframe webview（VS Code 模型）与框架无关；只有「Spec 数据树」这条路需要自研运行时
  （diy-ui 的强项），任何框架都得自己接。

## 4. 卡顿与框架无关（这条比框架选择更重要）

证据：`main/services/**` + `main/core/**` 有 **146 处同步 fs**；`local-agent.ts` 里整份
`readFileSync` + `JSON.parse` 读会话 jsonl（源码注释：266 会话实测 274 MB，"秒级同步阻塞"）。
主进程被按死的那些毫秒里，renderer 的每次 rpc 都停摆 —— 细粒度响应式也救不了一帧都送不上来。

因此重新开发时，架构上必须先立三条：

1. **主进程不许有超过 ~5 ms 的同步 IO**：大文件一律流式 / 分页 / `worker_threads`；
2. **数据推而不是拉**：事件流 + 增量 patch，轮询只做兜底（现在 23 个定时器，实际需要 ≤5 个）；
3. **可观测**：主进程阻塞探针（>50 ms 落日志）+ renderer 长任务探针，卡顿必须能定位到具体 handler。

## 5. 推荐栈（重新开发）

```
壳        React 19（并发渲染 + Suspense；表格/表单生态最全）
组件层    Web Components：@material/web（M3 控件）+ Web Awesome（card/tree/split-panel）
          —— 组件层不绑框架，将来换壳不用重写组件
样式      M3 令牌（seed 生成的 CSS 变量）+ Tailwind v4 @theme 映射
数据      @diy-agent/rpc（typed client）+ TanStack Query（缓存/失效）+ 事件流做增量
表格/树   TanStack Table + TanStack Virtual；树用 Web Awesome 的 wa-tree
插件 UI   iframe webview + postMessage（VS Code 模型）；需要「零 DOM 访问」时才上 Spec 数据树
测试      组件层 happy-dom；交互层 @diy-agent/ui-testing + CDP
```

若团队偏好「运行时最省、写法最简」，**Solid 是并列可选项**（4.20 vs 4.35，差距在噪声内）；
真正不该选的是 Angular（DI/Zone 负担、agent 生成正确率低）和纯 Lit 自研壳（状态管理会自己长成一门框架）。

## 6. 什么情况下会推翻这个结论

- 若确定**只做单人用的内部工具**且永远不招人：Solid 的写法更短，LLM 的弱点可以用本地规则/模板补，
  这时 Solid 反超；
- 若插件 UI 要走「宿主渲染插件产出的数据树」这条深水区（即插件完全不能有 DOM）：需要先把
  Spec 运行时做成产品级，这会抵消 React 的生态优势，此时框架选择退居第二位，运行时协议才是主轴。

## 7. 复核：组件层不该被 Solid 时代的选择绑住（2026-11-10 用户指出）

§5 把 `@material/web + Web Awesome` 写进推荐栈，但那是**当时为了绕开「Solid / diy-ui 不能用 JSX 生态」**
才做的选择：Web Components 是唯一能跨框架复用的组件 ABI。如果壳换成 React，这条约束消失，组件层要重挑。

重挑的关键事实：**React 19 已原生支持 custom elements**（props 直接写 property、事件走 on*、SSR 可用），
所以「WC 在 React 里别扭」这个理由不再成立 —— M3 组件库仍是候选，而不是默认。

| 方案 | 上手/密度 | 表格/树 | 与 M3 观感 | 生态/人才 | 风险 |
|---|---|---|---|---|---|
| **Radix + Tailwind + M3 令牌**（shadcn 路线） | 高（自己长，密度随便调） | TanStack Table / Virtual 自接 | 高（令牌一出即为 M3 皮肤） | 极强 | 组件要自己长，前 2 周慢 |
| **MUI + MUI X** | 中（默认密度偏松，需 theme 压） | 最强（DataGrid / TreeView 商业级） | 中（MD2 血统，M3 要改主题） | 极强 | Pro 版收费；主题改造有成本 |
| **@material/web + Web Awesome** | 中 | WA 有 card/tree，无数据表 | 高（就是 M3） | 中 | WC 调试链路长；表格仍缺 |
| **Mantine** | 高（密度可调） | 中（自接 TanStack） | 中（需重皮） | 强 | 生态比 Radix 小 |
| **Ant Design** | 高（企业级密集） | 强（Table/Tree 原生） | 低（不是 M3，重改观感成本高） | 极强 | 观感与 M3 目标冲突 |

结论（仅当壳=React）：

1. **首选 Radix + Tailwind + M3 令牌**：组件是 headless 的，密度/观感全由 M3 令牌决定（令牌已经是我们自己的生成物），
   不需要为了视觉去对抗组件库默认值；表格用 TanStack Table + Virtual（IDE 类必须虚拟化）。
2. **保底 MUI + MUI X**：如果时间紧、需要马上有 DataGrid / TreeView，用它换开发速度，代价是给 M3 主题做一层映射。
3. **@material/web 不是必选项**：M3 观感可以靠令牌 + 自长组件达成；保留 WA 只为我们确实需要它的成品件（card / split-panel）。
4. 不变的是**分层**：组件层只依赖令牌与 CSS，不依赖具体库 —— 这样将来换库的代价局限在组件层。

## 8. 复核两份外部评估（ChatGPT / Gemini，2026-11 组件库选型）

两份都指向同一方向，与我们 §7 的结论一致（headless 原语 + 自有设计系统），差异在细节与可信度。

### 8.1 共识（可信，采纳）

1. **分层：行为 / 视觉 / 布局三件事分开**。headless（Base UI / Radix / React Aria）管行为与 a11y；
   shadcn 是**源码分发**（组件代码落进自己仓库，可改）；Workbench 布局（分屏 / Tab 拖拽）另找专门方案。
2. **不要指望任何组件库给出现成的 IDE 工作台**：Tree / Tabs / Command Palette / 分屏必须自研或拼装。
3. **密度是 Token**，不是到处写 `p-2`：Compact / Comfortable / Spacious 三档，业务 View 只写语义组件。
4. **重活交专用件**：编辑器 Monaco、终端 xterm.js、大列表 TanStack Virtual。

### 8.2 需要打折扣 / 待核实

| 说法 | 评价 |
|---|---|
| 「shadcn 已把 Base UI 设为新项目默认」 | 方向可信，**版本事实待核实**（不影响结论：两者都是 headless，可替换） |
| 「Base UI 零运行时 DOM 开销」 | 夸大。headless 只是不带样式，JS 照样跑 |
| 「shadcn 在极致高频 Mount/Unmount 下不如 Base UI 轻量」 | 无数据支撑，属推测；桌面工具的真实开销不在这一层 |
| 「AI 写 shadcn 代码准确率最高」 | **可信且权重高**：我们的「LLM/单人可维护性」占 25% |
| 「几十万行数据必须上 AG Grid Enterprise」 | 过度。IDE 里这类区域通常是日志/表格，TanStack Table + Virtual 足够；AG Grid 留作最后手段 |

### 8.3 两份都漏掉的、对我们最关键的两点

1. **视觉真源归属**：我们已经有一套**自己生成的 M3 令牌**（`pkgs.ts/ui/design`，seed → CSS）。
   选组件库的第一判据是「它是否允许令牌说了算」——
   shadcn 的默认视觉是 zinc + Tailwind 调色板，必须**换掉**：把 `@theme inline` 映射到 `--md-sys-color-*`
   （`design/src/diy/tailwind.css` 已经有这一层），否则就是两套设计语言互相打架。
   带自建主题系统的（MUI / Mantine / AntD）在这条上天然吃亏。
2. **卡顿与组件库无关**：主进程 146 处同步 fs（含 274MB `readFileSync`）才是我们实测的病根。
   换任何组件库都不改善首屏与交互延迟。

### 8.4 定稿（React 路线下的组件层）

```
行为/无障碍   Radix（今天）→ 迁移到 Base UI（生态稳定后）   ※ shadcn 源码模式，组件落自己仓库
视觉          M3 令牌（生成物）+ Tailwind @theme 映射；禁用组件库自带调色板
密度          compact / comfortable / spacious 三档 Token
布局          Dockview（分屏 + Tab 拖拽）先做 POC；不合用再自研
重活          Monaco / xterm.js / TanStack Virtual / TanStack Table
```
