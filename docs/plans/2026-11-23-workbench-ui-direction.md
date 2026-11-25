# 工作台 UI 方向评估：自研 / Astryx / shadcn（2026-11-23）

> 结论先行：**骨架继续自研，控件层补 Radix（shadcn 路线），Astryx 不扩散**。
> 依据不是偏好，而是「workbench 真正重造的是模型与手势（Astryx 没有这个概念），
> 真正缺的是控件 a11y（Radix 有、shadcn 免费拿走）」。
> 另有一条独立结论：**对话 surface 从三套收成一套**，否则视觉与交互一致性永远是空话。

## 0. 先把「UI 方向」拆成两件事

混在一起谈必然失焦，因为两者的判据完全不同：

| | 对话流（chat surface） | 工作台骨架（workbench） |
|---|---|---|
| 现状 | **三套并行**：assistant-ui 面 **2814 行**（161 壳 + 2491 registry 件 + 162 投影）/ Astryx 384 行 / shadcn 383 行 | **一套自研**：2703 行，零组件依赖（只借 Astryx 主题壳） |
| 主要矛盾 | 三套并存 → 视觉、交互、功能各自漂移 | 自研缺控件 a11y（键盘 / 焦点） |
| 换方案的代价 | 低（都在 surface 后面，接口是 `ChatSurface`） | 高（骨架 = 布局 + 手势 + 持久化，换库等于重写） |

## 1. 事实盘点（2026-11-23 核验）

### 1.1 Astryx 是什么

| 项 | 值 | 依据 |
|---|---|---|
| 归属 / 许可 | Meta Open Source，MIT | `node_modules/@astryxdesign/core/package.json` |
| 版本 | `latest 0.7.17`（2026-11-22 更新）；我们锁 **`0.7.17-canary.geeb3d7c`** | `npm view @astryxdesign/core` |
| 成熟度 | **pre-1.0**，canary 通道每天多个构建 | 版本列表 `0.7.18-canary.g*` 十余个 |
| 技术栈 | React 19 + **StyleX**（编译期 CSS-in-JS）+ 自有 token（hct 配色、`defineTheme`） | `src/theme/*` |
| 覆盖面 | **118 个导出**，含 AppShell / SideNav / TopNav / Resizable / TabList / CommandPalette / ContextMenu / DropdownMenu / Dialog / Drawer / Toast / Tooltip / Popover / TreeList / Table / Markdown / Typeahead / Chat 族 | `dist/` 目录 |
| 体积 | `core/dist` 23M、`src` 17M；node_modules 合计约 100M（其中 49M 是 theme-neutral 自己嵌套的 node_modules） | `du -sh` |
| 强项（对我们） | **Resizable 的 handle 是 focusable separator，原生支持方向键 resize + WAI-ARIA + 尺寸持久化**；AppShell 自带 skip-to-content / 移动端 nav / collapsible sidenav | `Resizable.doc.mjs`、`AppShell.doc.mjs` |

### 1.2 shadcn 路线在我们仓库里的真实状态

| 项 | 值 |
|---|---|
| 实际代码 | 有：`pkgs.ts/ui/entity-chat/src/surfaces/shadcn/Surface.tsx`（383 行） |
| 它用了什么 | `lucide-react` + 仓库自有 `Markdown` / `AskCard` / `ErrorBar` / `useDraft`；**没有引 Radix 原语** |
| 底座是否就绪 | Tailwind v4 已接（`apps/diy2` 的 vite 插件 + `index.css` 的 `@layer` / `@source`）；M3 令牌已有（`pkgs.ts/ui/design`，seed → CSS） |
| Radix 是否已装 | 装了但是**传递依赖**（assistant-ui 带进来的 `@radix-ui/*` 全套）；我们自己的 `package.json` 里零声明 |
| 缺什么 | 分屏 resizer、菜单/弹层的键盘与焦点逻辑 —— 就是 shadcn 要落源码的那部分 |

### 1.3 自研 workbench 的现状与真实缺口

规模：`AreaHost 809 / workbench.css 780 / pages 299 / model 298 / App 224 / window 207 / glyphs 86`。

a11y 现状（grep 实测）：

- **已有**：`role=tablist/tab/tabpanel/menu/menuitemradio/separator`、`aria-expanded/selected/orientation/label`
- **缺**：菜单与 tab 的**键盘导航**（全仓 workbench 只有一处 `keydown`，用于 ESC 关菜单）、**焦点管理**（无 `focus()` / `tabIndex` / 焦点环）、**resizer 键盘**（只有 pointer 事件）、skip-to-content
- 交互层另有一条已知债：折叠 / 最大化靠鼠标单双击，触屏与键盘不可达

### 1.4 三套对话 surface 的实测规模与「真实消费」（2026-11-23 二次核验）

上一节把 assistant-ui 面记成「161 行壳」是**低估**：壳之外还有 2491 行从 registry 抄进来的组件与 162 行投影层。

| | assistant-ui 面 | Astryx 面 | shadcn 面 |
|---|---|---|---|
| 代码量 | ChatPanel 161 + `assistant-ui/` 10 文件 **2491** + projection **162** = **2814 行** | Surface 384 + mapping 123（+70 测试） | **383 行** |
| 数据来源 | **二次投影**：`TimelineEntry` → `ThreadMessageLike` | 直吃 `TimelineEntry`（`chat-core.buildTimeline`） | 直吃 `TimelineEntry` |
| 传递依赖 | **10 个**：`@assistant-ui/{core,store,tap}`、`assistant-cloud`、`assistant-stream`、`radix-ui`、`react-textarea-autosize`、`safe-content-frame`、`zod`、`zustand` | `@astryxdesign/{core,lab,theme-neutral}` + `@stylexjs/stylex` | **0**（只有 React + lucide + 仓库共享件） |
| 是默认面？ | 否 | **是**（`App.tsx:173` 缺省 `astryx`） | 否 |

**实测：assistant-ui 的「高级能力」大半没有数据接线**（`rg 'onEdit|onReload|branch|suggestions|adapters'` 在 ChatPanel/projection 里零命中）：

| 能力 | 渲染了 | 有用吗 |
|---|---|---|
| `BranchPickerPrimitive`（消息分支切换） | 是 | ✗ 投影里没有分支/版本概念 |
| `EditComposer`（编辑重发） | 是 | ✗ 只实现了 `onNew`/`onCancel`，`setMessages: () => undefined` |
| `ThreadPrimitive.Suggestions` | 是 | ✗ runtime 未提供 suggestions |
| `ComposerPrimitive.Dictate`（语音听写） | 是 | △ 浏览器 Web Speech，未接我们的模型 |
| `MessagePrimitive.Parts` / `GroupedParts` | 是 | ✓ 分段与工具组确实在用 |
| `ActionBarPrimitive.Copy` / `ScrollToBottom` | 是 | ✓ 在用 |

**与我们的模型打架的四处补丁**（每处都是框架默认假设 ≠ 房间语义）：

1. `isRunning: false` —— 关掉框架的 running 态，否则它禁用输入、把发送换成停止；而**插话是正常操作**（`ChatPanel.tsx:145-147`）
2. `MessageNotSentError` 兜回输入框 —— 框架 dispatch 即清空，而「发出去了」要等后端受理（118-139）
3. `document.querySelector('[data-slot="aui_thread-viewport"]')` 取视口挂滚动 —— 框架不暴露视口（102）
4. ask 卡片塞成 `data-ask` part，到 `thread.aui.tsx` 再由自定义渲染器拆回来（`projection.ts:48`）

**结论**：「assistant-ui 更高级」这个前提在本仓**不成立**。它更完整的是「一对一 chat」的通用形态（分支 / 编辑 / 语音 / 建议），而我们做的是「多成员房间 + 任务 + ask 卡片」—— 那些能力没有对应事实可接。为不消费的能力付出的是 2431 行额外代码、162 行投影、10 个传递依赖、4 处冲突补丁。

**shadcn 面的真实缺口**（诚实列出，合计约 40 行）：无复制按钮、`textarea` 不自动长高（`rows={1}` + `max-h-40`）、无消息编辑（但 assistant-ui 面的编辑也没接线，等于两边都没有）。

**两处命名/归属要纠正**：

- `surfaces/shadcn/Surface.tsx` 实际是**原生 Tailwind 面**，**没用任何 shadcn 组件件**（裸 `div`/`button`）。真要上 shadcn 组件（Button / Textarea / Tooltip / ScrollArea），正好是 `@diy-agent/ui-shadcn` 该验证的事 —— 该包目前只被 entity-chat 的弹窗与 ModelPicker 消费，**没进任何 surface**。
- 三面各自注册一次 `registerAskJumper`（`ChatPanel` / `astryx/Surface` / `shadcn/Surface`）：**每加一个交互要写三遍**，这是三面并存的真实维护成本，不是理论担忧。

## 2. 五层拆分：谁能替哪层

工作台不是「一个组件」，是五层。逐层判，才有意义：

| 层 | 我们现在的实现 | Astryx 能替？ | Radix/shadcn 能替？ |
|---|---|---|---|
| **模型**（5 固定槽位 / 概念 id / 偏好持久化 / 定义期校验） | `model.ts` 298 行 + 15 条单测 | ✗ 没有「槽位」「区域」概念 | ✗ 同左 |
| **手势**（区域头单击折叠 / 双击最大化 / 折叠条 / chrome 两态） | `useBarGesture` + `FoldedArea` + `MaximizedArea` | ✗ 无对应组件 | ✗ 无对应组件 |
| **布局**（骨架、resizer 伸缩、尺寸上下限） | `Skeleton` + `Resizer`（pointer only） | △ **Resizable 只替 resizer 一件**，且是 hook 形态、可带键盘与持久化 | △ `react-resizable-panels`（4.24.1，键盘可达）同理 |
| **控件**（按钮 / 菜单 / 弹层 / tooltip / tab / 焦点） | 自研，`<button>` 仅 6 个，其余 div + onClick | ✓ **这是 Astryx 最强的一层**（focus trap、roving focus、ARIA 全内建） | ✓ Radix 原语（同样是这一层的行业标准），shadcn 负责把源码落进我们仓库 |
| **视觉**（M3 令牌 / 密度 / 暗色） | 13 个 `--wb-*` 变量 + 手写 CSS 780 行 | ✗ **第二套令牌体系**：StyleX token 与 M3 令牌要写映射表；且现在为了让 Astryx 排版生效，`index.css` 已刻意**不引 Tailwind preflight** | ✓ 同源：Tailwind v4 + M3 令牌，`design/src/diy/tailwind.css` 已有映射层 |

**这张表就是结论**：Astryx 的强项（控件层）与我们的缺口（控件 a11y）重合，但它同时带来第二套令牌体系与 pre-1.0 canary 依赖，而它**替不了**我们真正花时间的那两层（模型、手势）。反过来，Radix 只给控件层，不带令牌体系，代价小一个量级。

## 3. 打分（权重按「桌面工具 + 单人 + agent 写码」定）

| 维度 | 权重 | 自研 | Astryx | shadcn(Radix) |
|---|---|---|---|---|
| 模型 / 手势表达力 | 25% | **5** | 2 | 1 |
| 控件 a11y（键盘 / 焦点 / ARIA） | 20% | 2 | **5** | 4 |
| 视觉一致性（M3 令牌说了算） | 15% | 4 | 2 | **5** |
| 依赖稳定性（3 年寿命） | 15% | **5** | 2（0.7.x canary） | 4（Radix 1.8.1 稳定） |
| LLM / 单人可维护性 | 15% | 3 | 4 | **5**（语料最多 + 源码在自己仓） |
| 增量成本（从今天出发） | 10% | **5**（0） | 1（骨架重写） | 3（补控件层） |
| **加权** | | **4.15** | **2.65** | **3.95** |

自研的分数高在「零成本 + 完全贴合」，但 **控件 a11y 那 2 分是实打实的欠账**：一个桌面工具用鼠标单双击承载折叠/最大化，键盘用户无法操作，这不是风格问题。

## 4. 如果要走到确定答案，还差三个可跑的实验

评估不该停在读代码。下面三件都能在一天内量出结论，且互不阻塞：

1. **Astryx 的最小接入成本**：在 lab 页里用 `AppShell + SideNav + useResizable` 拼一个「窄/中/宽 + 折叠条」的假工作台，量三件事 —— 构建是否要额外 StyleX 配置、bundle 增多少 KB、M3 令牌映射要写多少行 token。
2. **Radix 的替换粒度**：把 `AreaHost` 的 `ModeMenu`（`⋯` 菜单）与 `AreaTabs` 换成 Radix `DropdownMenu` / `Tabs`，量「代码减了多少行、键盘是否真的通了」—— 这是自研路线的可行性验证，成本最低（两处组件、不碰骨架）。
3. **对话 surface 收敛**：同一份 fixture 喂三套 surface，比「加一个工具卡」的改动行数与一次通过率 —— 2026-11-13 文档已定义指标，只差执行。

## 5. 推荐与止损

```
骨架       自研（模型 + 手势 + 布局保持不变，继续长）
控件层     Radix（radix-ui 1.8.1）源码落仓库；按需引，不整体搬 shadcn CLI
视觉       M3 令牌（既有）+ Tailwind v4；不再为第二套设计系统让路
对话表面   收敛到一套（建议 shadcn 线：无 pre-1.0 依赖、与令牌同源）
Astryx     隔离在 lab（/astryx-lab.html + entity-chat 的对照 surface），不扩散
```

止损条件（写死在前面，避免事后找理由）：

- 若实验 1 证明 Astryx 接入成本极低（bundle 增量 < 100 KB、令牌映射 < 50 行、构建零配置）→ 重新评估，允许它接管**控件层**（仍不接管骨架）。
- 若实验 2 证明 Radix 换完后键盘仍不通（因为我们的折叠/最大化手势本身没有键盘语义）→ 说明缺的是**交互设计**而不是组件库，先把「键盘如何折叠/最大化」设计出来，再谈选型。
- 若 Astryx 在 3 个月内发 1.0 且保持 API 稳定 → 它的 pre-1.0 风险项消失，重新打分。

## 6. 未决问题（需要拍板）

1. 对话 surface 收敛到哪一套？（建议 shadcn 线）
2. 折叠/最大化的**键盘与触屏**交互怎么定义？（`Enter` 切折叠、`Ctrl+↑` 最大化？）
3. Astryx canary 锁定的版本是否升到 `latest 0.7.17`？
