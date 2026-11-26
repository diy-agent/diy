# diy 的设计规范（DESIGN.md）

> **这份文件是给写 UI 的人和 agent 读的**：它说「该长什么样」，不说「怎么实现」。
> 值的真源永远是代码 —— 色彩/圆角的真源是 `pkgs.ts/ui/shadcn/src/styles.css`，
> 组件的真源是 `pkgs.ts/ui/shadcn/src/components/ui/*`。**本文与代码冲突时以代码为准，并把本文改对。**
>
> 建它的理由很实际：`surfaces/shadcn` 曾经是 600 行裸 Tailwind，每个页面各自决定圆角、间距、状态色；
> agent 每次改动都在凭感觉选 class，同一个交互在两面各写一遍。规范写下来，判断才有依据。

---

## 0. 现状（先知道我们在什么地基上）

| 项 | 事实 | 影响 |
|---|---|---|
| 主题 | **dark-first**：`apps/diy2/index.html` 写死 `<html class="dark">`，无切换 | 只用 `.dark` 那套变量；不要写死浅色假设 |
| 色板 | shadcn 官方 **neutral** 基准（oklch），未做品牌覆盖 | 想换品牌 → 按同名变量覆盖，**不改包内 styles.css** |
| 字体 | `system-ui` 栈（`apps/diy2/src/index.css` 的 `body`）；包内 `--font-inter` 未真正加载 | 别在组件里指定字族 |
| Preflight | **刻意不引**（当时 Astryx 与 shadcn 共用一页只能留一套 reset；Astryx 面已于 2026-11-26 删除，这条约束仍按保守留用） | `<a>` 会回到 UA 默认蓝字+下划线 —— 见 §7 |
| 组件层 | `@diy-agent/ui-shadcn`，22 个 base-nova 组件（Base UI 原语） | 写 UI 先从这里取，别手写 |
| 已验证的 showcase | `diy-research/pkgs.ts/ui-shadcn/std-lab`（63/63 组件有展示，`showcase-coverage.mjs` 通过） | 想知道「这个组件长什么样」去那里看 |

---

## 1. 色彩：只用语义角色，不用颜色名

**规则：写 `bg-background` / `text-muted-foreground` / `border-border`，永不写 `bg-slate-800` / `text-[#888]` / `bg-white/5`。**

理由不只是「一致性」：Tailwind 缺 `--color-*` 映射时**不报错、只是不生成规则**（静默失效）。任意色值绕过这套机制，暗色下就只剩你自己记得的那一处是对的。

| 角色 | 变量 | 用在哪 |
|---|---|---|
| 画布 | `--background` / `bg-background` | 页面底、面板底 |
| 主文本 | `--foreground` / `text-foreground` | 正文、标题 |
| 卡片/浮层底 | `--card`、`--popover` | 卡片、菜单、弹窗 |
| 次级文本 | `--muted-foreground` / `text-muted-foreground` | 说明、时间戳、占位 |
| 弱底 | `--muted` / `bg-muted` | 代码块、分区带、禁用底 |
| 主操作 | `--primary` / `--primary-foreground` | 主按钮、选中态实心 |
| 次操作 | `--secondary` | 次按钮填充 |
| 悬停/选中洗色 | `--accent` / `bg-accent` | 菜单项 hover、tab 选中、行 hover |
| 结构线 | `--border` / `border-border` | 分隔线、卡片描边 |
| 输入描边 | `--input` | 输入框边框 |
| 焦点环 | `--ring` / `ring-ring` | `focus-visible` 环 |
| 错误 | `--destructive` | 错误文字/危险按钮 |
| 图表 | `--chart-1` … `--chart-5` | 仅图表 |

**半透明**：允许 `bg-foreground/5`、`border-foreground/10` 这类**同色带透明度**的写法（它是语义色的变形，不是任意色值）。

### 状态色（四档，只这四档）

语义变量不够表达「工具跑成功了 / 模型在问你」这类状态，所以另外固定四个调色板色 —— **只用 Tailwind 的名字，不写 hex**：

| 状态 | 色 | 典型用法 |
|---|---|---|
| 成功 / 已答 | `emerald` | `text-emerald-500`、进度点 `bg-emerald-500/60` |
| 进行中 / 人在问你 | `sky` | 待答卡的提交键 `border-sky-500/40 bg-sky-500/10` |
| 警告 / 待处理 | `amber` | 待确认、临界阈值 |
| 失败 | `destructive`（语义变量，不是调色板） | 错误文字、危险操作 |

超过四档就说明在拿颜色当状态机，应该改用图标或文字。

---

## 2. 字体与字号

- 字族：继承 `body` 的 `system-ui` 栈。**组件里不指定字族**（等宽除外：`font-mono`，用于代码、ID、路径）。
- 字号阶梯（只用这几档，不写 `text-[13px]`）：

| 用途 | class | 说明 |
|---|---|---|
| 正文/对话 | `text-sm`（14px） | 缺省尺寸，行高 1.5 |
| 辅助说明 | `text-xs`（12px） | 时间、元信息、徽标 |
| 区块标题 | `text-sm font-medium` | 不要用 `text-lg` 撑场面 |
| 页面主标题 | `text-base font-semibold` | 整个 app 里少见 |
| 代码/路径 | `text-xs font-mono` | 路径、token 数、命令 |

- 字重只用 `font-normal` / `font-medium` / `font-semibold`，**不用 `font-bold`**（14px 下过重）。

---

## 3. 圆角

`--radius: 0.625rem`（10px）。只用这五档：

| class | 值 | 用在哪 |
|---|---|---|
| `rounded-sm` | 6px | 徽标、小色块 |
| `rounded-md` | 8px | 菜单项、tab 触发器、chip |
| `rounded-lg` | 10px | **按钮、输入框、select、卡片**（最常用） |
| `rounded-xl` | 14px | 弹窗、大容器 |
| `rounded-2xl` | 18px | 消息气泡（对话流的用户气泡） |
| `rounded-full` | — | 头像、圆形图标按钮、状态点 |

不要 `rounded-[7px]` 这类任意值。控件（按钮/输入）统一 `rounded-lg`，除非它在菜单里（`rounded-md`）。

---

## 4. 控件高度：32px 一族，改就一起改

**缺省控件高 `h-8`（32px）**，图标按钮 `size-8`，小号 `size-7`，大号 `size-9`。

这条是硬约束，因为它散落在很多文件里 —— 只改按钮会导致表单错位：

```
button.tsx  h-8 / size-8（icon）
input.tsx   h-8
select.tsx  data-[size=default]:h-8
tabs.tsx    group-data-horizontal/tabs:h-8
textarea.tsx  min-h-16（多行不跟这条）
```

要改控件高度：先 `rg -n '\bh-8\b|size-8' pkgs.ts/ui/shadcn/src/components/ui/` 看全，再一起改，然后在 std-lab 里过一遍表单区。

---

## 5. 间距与布局

- 间距只用 Tailwind 刻度（`1/2/3/4/6/8`），**不写 `gap-[7px]`**。
- 面板内边距：`p-3`（紧凑，如对话流）或 `p-4`（常规面板）。
- 区块之间：`space-y-4` 或 `gap-4`；列表项之间：`space-y-1`。
- **flex/grid 子项默认 `min-width: auto`，内容长就横向溢出** —— 凡是「里面可能有长路径 / 长单词 / 表格」的容器，加 `min-w-0`；需要横向滚动就 `overflow-x-auto`。这是 375px 溢出最常见的成因。
- 行距放进**行内 padding**，不要用容器 `gap` 撑对话消息（`ChatVirtualizer` 这类虚拟列表靠 `offsetHeight` 量行高，容器 gap 它看不见，会一行漂一格）。

---

## 6. 组件：先用组件层，别手写

**任何 `button` / `input` / `textarea` / `select` / 弹窗 / 菜单 / tab，都从 `@diy-agent/ui-shadcn` 取。** 手写一次就是一份要单独维护的焦点管理、键盘导航和 aria。

| 要做的 | 用 |
|---|---|
| 按钮（含图标按钮） | `Button`（`variant="ghost|outline|secondary|destructive"`、`size="sm|icon"`） |
| 文本输入 / 多行 | `Input` / `Textarea` + `Label` |
| 下拉选择 | `Select`（三段式选择器也用它，别用原生 `<select>`） |
| 弹窗 | `Dialog`（`DialogHeader/Title/Footer/Close`） |
| 确认危险操作 | `AlertDialog` 或 `Dialog` + `destructive` 按钮 |
| 侧滑面板 | `Sheet` |
| 菜单 | `DropdownMenu` / `ContextMenu`（**`*MenuLabel` 必须在 `*MenuGroup` 内**，见 §8） |
| 提示 | `Tooltip` / `Popover` / `HoverCard` |
| 分段切换 | `Tabs`（显式 `orientation`，见 §8） |
| 折叠 | `Collapsible` / `Accordion` |
| 反馈 | `Alert` / `Badge` / `Skeleton` / `Progress` |
| 滚动区 | `ScrollArea`（别自己写 `overflow-y-auto` + 伪滚动条） |
| 头像/分隔/开关 | `Avatar` / `Separator` / `Switch` / `Checkbox` / `RadioGroup` |

**反向约束**：`@diy-agent/ui-shadcn` 只收**原样 registry 组件**。带业务语义的组合件（`ConfirmDialog`、`ModelPicker`、消息气泡）留在消费方包 —— 否则 CLI 更新组件会覆盖我们的改动，这个包也会退化成垃圾场。

---

## 7. 交互态

- `hover`：**必须给**，包括 ghost 按钮和菜单项（即使设计稿没写）。
- `focus-visible`：用 `ring-2 ring-ring ring-offset-2 ring-offset-background`；不要用 `outline`。
- `disabled`：`disabled:opacity-50 disabled:pointer-events-none`。
- 选中态：实心用 `bg-accent text-accent-foreground`（或 `--primary`），描边用 `border-ring`。
- 链接：宿主不引 preflight ⇒ `<a>` 会回到 UA 蓝字下划线。正文里的链接要显式 `text-foreground underline underline-offset-2`，或依赖 `entity-chat/styles.css` 的 `a { color: inherit; text-decoration: inherit }` 兜底后自己给样式。

---

## 8. Do & Don't（收尾逐条自查）

**Do**

1. 颜色、圆角、间距、字号，只用 §1–§5 列出的那些。
2. 控件高度改了就一起改（`h-8` 一族）。
3. 长内容容器加 `min-w-0` / `overflow-x-auto`。
4. 弹窗/菜单/选择器一律用组件层，别手写。
5. 只做在 shadcn 面 —— astryx 面已于 2026-11-26 **删除**（不是冻结），历史见 `docs/plans/2026-11-24-surface-parity.md` §7。
6. 改完验宽度：**diy2 主壳按 1200×800（缺省窗口）与 1280 验无横向溢出**；组件/面板级的窄屏行为在 std-lab 验 375（主壳本身不响应式：侧栏 + 区域是桌面布局）。

**Don't**

1. 不写任意色值：`bg-[#1a1a1a]`、`text-[rgb(...)]`、`bg-white/5`（用 `bg-foreground/5`）。
2. 不写任意尺寸：`h-[38px]`、`rounded-[7px]`、`text-[13px]`、`gap-[7px]`。
3. 不手写 `button` / `input` / `select` / 弹窗壳。
4. 不用 `font-bold`。
5. 不在 `@diy-agent/ui-shadcn` 里放业务组合件。
6. 不改包内 `styles.css` 的变量值来「适配某个页面」（要换主题就按同名变量覆盖）。
7. 不引 Tailwind preflight（`@import 'tailwindcss'` 全量那种）：它会把各组件件的排版 reset 与语义变量一起打断，且历史上是为了与 Astryx 共用一页。

---

## 9. Known Gaps（已知坑，都是踩过的）

| 坑 | 症状 | 处置 |
|---|---|---|
| `DropdownMenuLabel` / `*MenuLabel` 放在 `*MenuGroup` 外 | tsc/build 全过，**一点开就整页 React 崩成白屏**（Base UI `MenuGroupLabel` 要求有 Group 上下文） | 永远包进 `*MenuGroup` |
| base-nova 模板缺 `data-horizontal` / `data-vertical` variant | 分隔线永远竖着、`Tabs` 永远横排、滚动条方向错（**不报错**，规则压根不生成） | **已修**（2026-11-25）：变体定义进了 `pkgs.ts/ui/shadcn/src/styles.css`，消费方不要再定义一份 |
| Base UI 的 `Tooltip` popup 无 `role="tooltip"` | 断言 `getByRole('tooltip')` 找不到 | 断言打 `[data-slot=tooltip-content]` |
| `Command` 内联在页面里 | cmdk 挂载时把首项 `scrollIntoView`，整页被拽走 | 受控：`value={v} onValueChange={setV}`，初值 `'none'` |
| Tailwind 缺 `--color-*` | 类名不报错、规则不生成，**静默失效** | 语义变量跟着组件走（已在 `ui-shadcn/styles.css`）；新组件先跑一遍变量比对 |
| `npx shadcn add` 落盘 | `from "cn"` 被当 npm 包、`IconPlaceholder` 残留、aliases 不吃相对路径 | 用 `pkgs.ts/ui/shadcn/AGENTS.md` 里的一次性脚本替换三处占位 |
| 自由类名拼错（`px-4x` / `bg-primry`） | 构建通过、产物里被静默丢弃 | 没有编译期保护；靠 §8 的自查清单 + 375/1280 两档看一眼 |

---

## 10. 怎么验证（每次 UI 改动）

1. `./sha.sh check`（tsc + lint + 护栏）。
2. 起 `./sha.sh lab --app diy2`（**单端口、无 Electron**，浏览器直开 `app.port`）。
3. 无横向溢出：`document.documentElement.scrollWidth <= innerWidth`。**diy2 主壳验 1200 / 1280**（它是桌面 workbench，侧栏 + 区域不响应式，375 下溢出属既有布局，不是本次改动的回归）；**组件级在 std-lab 验 375**。
4. console 零错误；页面加载时 `scrollY === 0`（有组件偷滚动就不对）。
5. 组件的视觉基准：`diy-research/pkgs.ts/ui-shadcn/std-lab`（`node .../showcase-coverage.mjs src/components/ui src` 应为 `N/N components shown`）。
6. 交互态过键盘：Tab 能到、focus 环可见、Esc 关最上层、关闭后焦点回到触发元素。

---

## 11. Iteration Guide（要改规范时）

- **改值**（色/圆角/控件高）：改 `pkgs.ts/ui/shadcn/src/styles.css` 与组件源文件 → 跑 §10 → 回来改本文对应表格。
- **加组件**：走 `pkgs.ts/ui/shadcn/AGENTS.md` 的落盘脚本 → 加进 `src/index.ts` → 在 std-lab 补 showcase（覆盖率要回到 N/N）。
- **改规则**：先看它是不是「已经踩过的坑」（§9），是就加进 §9 而不是新开一节。
- 本文与代码冲突时：**以代码为准**，并立刻把本文改对 —— 一份过期的规范比没有规范更坏。
