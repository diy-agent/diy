# shadcn 设计使用审计（对照官方参考库，2026-11-28）

> 参考库：`/Users/ccc/git-ref/shadcn-ui/ui`（shadcn 官方 v4，base-nova / shadcn 官方 themes）
> 我们：`pkgs.ts/ui/shadcn`（组件）、`apps/diy2/src/workbench/workbench.css`（工作台壳）、`pkgs.ts/ui/entity-chat/src/nav/*`（侧栏）
> 本报告只评估、不改代码。每条都带代码出处 + 官方做法 + 可执行建议。

## 结论摘要

我们的 `DESIGN.md` 本身写得相当完整（语义色、字号阶梯、圆角、控件高度、Do/Don't 都有），问题不在「规范缺失」，而在**三件事**：

1. **规范没被执行**：任意字号 `text-[10px]/[11px]` 出现 100+ 次，硬编码颜色散落多处——正是规范明令禁止的。
2. **官方有、我们没用的一整套能力**：`sidebar-*` 语义 token 组（官方专门给侧栏的 surface），我们完全没有，侧栏只能拿通用 token 硬凑 → 这就是「没有 mui 那种一致性」的结构性根因。
3. **默认状态的视觉语义错位**：「历史任务」分组标题因默认展开，`aria-expanded:bg-muted` 让它永久套着选中态底色 → 用户说「默认就像选中态」。

主题「差异太弱」不是搬错了：我们逐值照搬官方 12 套，色值与官方一字不差；但官方前 6 套（zinc/slate/stone/gray/neutral 等）本来就是灰阶、primary 近黑——选了它们本来就几乎看不出差别。这是官方设计，不是 bug，但我们的选择器没有引导用户选真正的彩色主题。

---

## 问题一：「历史任务」默认像选中态 —— 已定位根因

**出处**：`pkgs.ts/ui/entity-chat/src/nav/history.tsx:24-33, 147-165`
- `loadHistoryOpen()` 默认返回 `true`（注释：「默认展开，用户要的是方便回头看」）。
- 分组标题是 `<Button variant="ghost">`，官方 Button 自带 `aria-expanded:bg-muted aria-expanded:text-foreground`。

**实测**（生产 5192，房间 `01a208ee`）：
```
按钮 class 含：aria-expanded:bg-muted aria-expanded:text-foreground
渲染结果：  bg   = oklch(0.967 0.001 286.375)   ← 就是 --muted（选中/悬停洗色）
            color= oklch(0.141 0.005 285.823)   ← 就是 --foreground（主文本）
```
一个「分组折叠标题」，因为默认展开，`aria-expanded` 永远为真，于是**永久显示成选中行的样子**。这不是数据 bug，是 `aria-expanded` 的视觉规则被用在了「默认就展开」的元素上——语义冲突。

**官方做法**：官方没有「默认展开的分组标题」这个模式；`aria-expanded` 只用于用户可切换、且有明确收起态的控件。侧栏分组用 `sidebar-accent` 表达选中，与 background 分离。

**建议**（三选一，按代价递增）：
1. 分组标题不用 `variant="ghost"` 的自带 `aria-expanded` 样式——改成自定义 class，`aria-expanded` 只驱动箭头方向，不驱动底色；展开态给一个比 `muted` 更弱的底（如 `bg-muted/40`）或干脆无底。
2. 或者分组标题默认收起（`loadHistoryOpen()` 改 false），展开态才有底——但那违背「方便回头看」的产品决定。
3. 引入 `sidebar-accent` token 后，把「选中行」与「分组标题」用不同 token，从根上分开两者的视觉。

---

## 问题二：文字对比度 —— `muted-foreground` 当正文用

**出处**：`pkgs.ts/ui/entity-chat/src/nav/history.tsx:68-70, 88, 113`
- 历史任务行：非选中态 `text-muted-foreground`，项目 tag `text-muted-foreground/80`，关闭时刻 `text-muted-foreground/70`。

**实测**：
```
行文字   color = oklch(0.552 0.016 285.938)  = --muted-foreground
页面底色 background = oklch(1 0 0) = 白
项目 tag = oklab(... / 0.8)  —— 在 muted-foreground 基础上再乘 0.8 透明度
```
`muted-foreground` L=0.552 在白底上对比度约 **4.6:1**，刚过 WCAG AA 正文门槛（4.5:1）；再叠 `/80`、`/70` 透明度后掉到 **~3.4:1 / ~3.0:1**，低于 AA。加上项目 tag 和关闭时刻都是 `text-[10px]` 小字——小字 + 低对比，正是「看着费劲」。

**官方语义**：`muted-foreground` 官方用途是「descriptions, placeholders, empty states, helper text, and subdued surfaces」——**辅助信息**，不是列表主标题。官方表格里「列表主标题」应该用 `foreground`。

**建议**：
- 历史行的**房间名**（`roomTitle`）改成 `text-foreground`，只有项目 tag / 时间维持 `muted-foreground`。
- 不要对 `muted-foreground` 再叠 `/70`、`/80` 透明度——直接用一个固定的更浅语义档，或者就保持 `muted-foreground` 不叠。
- 小字 `text-[10px]` 至少提到 `text-xs`（12px），这也是 DESIGN.md §2 的规定。

---

## 问题三：主题「差异太弱」—— 不是 bug，是默认选了灰阶 + 无引导

**证据**：我们 `themes.css` 767 行，12 套主题的 primary 与官方逐值一致：
```
theme-blue   → hsl(221.2 83.2% 53.3%)   （官方：221.2 83.2% 53.3%）  ✓
theme-orange → hsl(24.6 95% 53.1%)     （官方：24.6 95% 53.1%）    ✓
theme-zinc   → hsl(240 5.9% 10%)       （官方：240 5.9% 10%）      ✓
```
官方 12 套里 **zinc / slate / stone / gray / neutral 这 5 套是灰阶**，primary 都是近黑（L≈0.1），亮色主题之间几乎只有色温微差。选这些主题本来就看不出变化——这是官方设计（它们叫 neutral base colors）。真正有色彩的是 red / rose / orange / green / blue / yellow / violet 这 7 套。

**我们的问题不是搬错，是选择器没引导**：`ThemePicker.tsx`（116 行）把 12 套平铺，没有区分「灰阶基准」和「彩色主题」，用户随手选到前几套灰阶，自然觉得「只有底色文字稍有区别」。

**建议**：
- 在 ThemePicker 里把灰阶组和彩色组分区，标一句「灰阶主题色彩差异很小，想要明显变化请选彩色主题」。
- 或默认主题直接用一套有辨识度的彩色（如 blue），而不是 neutral 灰阶。

---

## 问题四：没有 mui 那种一致性 —— 结构性根因：缺 `sidebar-*` token

**证据**：
- 官方 theming 文档明确列了一整组 `sidebar-*` token：`sidebar` / `sidebar-foreground` / `sidebar-primary` / `sidebar-accent` / `sidebar-border` / `sidebar-ring`，专供侧栏 surface 用。官方 `$` 有 Sidebar 组件的项目（如 `templates/react-router-monorepo/.../globals.css`）都定义了这组。
- 我们的 `pkgs.ts/ui/shadcn/src/styles.css`：`--sidebar` 出现 **0 次**。侧栏（`workbench.css` 875 行自写样式 + `entity-chat/src/nav/*`）全靠通用 token（`bg-accent` / `text-muted-foreground` / `border-border`）硬凑。

**后果**：侧栏不是一个有独立语义的 surface，它的选中态、hover、文字色都跟主内容区共用同一套 token。这就是「各部分看着不统一」的根——mui / 官方 shadcn 的做法是侧栏自成一套 surface token，选中、悬停、文字各有专用档。

**建议**：
- 在 `styles.css` 补 `sidebar-*` 六个 token（亮暗两套），workbench 壳和 nav 行改用它。
- 代价：要动 `workbench.css`（875 行）里所有侧栏相关的颜色引用，属于中等改造，建议单独排期，不要混在小修里。

---

## 问题五：规范没被执行 —— 任意值泛滥

**证据**（违反我们自己 DESIGN.md §2/§8「不写任意值」）：
```
text-[11px]  66 处
text-[10px]  34 处
text-[9px]    3 处
text-[13px]   3 处
（硬编码颜色）#7f1d1d 5、#78350f 4、#14532d 3、#b42318 2、#4ade80 2、
              #0d1117/#161b22/#21262d/#0b0f14 各 2 …
```
- `DESIGN.md §2` 明定字号阶梯只有 `text-sm / text-xs / text-base` 等，`text-[10px]/[11px]` 一律不允许。
- `DESIGN.md §8 Don't` 明定「不写任意色值」。
- 注意：`#0d1117` 那组正是上一轮主题修复从 `workbench.css` 的 `:root` 清掉的，但别处仍有残留；`#7f1d1d/#78350f/#14532d` 等是错误/警告色的硬编码。

**为什么重要**：DESIGN.md §9 自己记了坑——「Tailwind 缺 `--color-*` 时类名静默失效，构建通过但规则不生成」。任意值绕过了这套唯一的编译期保护，是「看着不一致又查不出原因」的常见来源。

**建议**：
- 把高频的 `text-[10px]`/`text-[11px]` 收成语义档（`text-xs` 及一个新「更弱」档），批量替换。
- 硬编码色按语义归类：`#7f1d1d` 之类归到 `destructive` / 状态色，`#0d1117` 之类是 workbench 残留，确认无引用后清掉。

---

## 优先级建议

| 优先级 | 问题 | 代价 | 见效 |
|---|---|---|---|
| P0 | 问题一（历史任务默认像选中） | 小（几行 class） | 直接 |
| P0 | 问题二（主标题对比度） | 小（几个 class） | 直接 |
| P1 | 问题三（主题选择器引导） | 小 | 直接 |
| P1 | 问题五（任意值收敛） | 中（批量替换 + 回归） | 中 |
| P2 | 问题四（sidebar-* token） | 大（875 行壳样式改造） | 结构性问题，治本 |

先做两个 P0，立刻能解决用户眼前「看着不对」的抱怨；P2 是治本，单独排期。
