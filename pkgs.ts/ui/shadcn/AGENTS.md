# @diy-agent/ui-shadcn — shadcn 组件层

纯展示组件（props 进 DOM 出，不碰 store / RPC / 业务词表）+ `cn` 工具 + 语义变量 `styles.css`。
**全仓 shadcn 组件的唯一真源** —— 不要在别的包里再放一份 `button.tsx`。

## 内容

- `src/components/ui/*.tsx` —— 来自 shadcn registry 的 `base-nova` 风格（Base UI 原语 `@base-ui/react`），22 个
- `src/lib/cn.ts` —— `clsx` + `tailwind-merge`
- `src/styles.css` —— 23 个语义变量（`--background` / `--ring` / `--border` …）+ `@theme inline` 映射 + Border 基线
- `components.json` —— 记录风格（`base-nova`），供 CLI 与后来人对照

## 怎么加组件（别用 CLI 直接 add）

`npx shadcn add`（4.23.0）会把 registry 里的 `from "cn"` 当成 npm 包去装，并在 `EALLOWSCRIPTS`
下失败；它的 aliases 也不吃相对路径。落盘用一次性脚本：

1. 拉 `https://ui.shadcn.com/r/styles/base-nova/<名>.json`
2. 取 `files[].content`，替换三处占位：
   - `from "cn"` → `from '../../lib/cn'`
   - `@/registry/base-nova/ui/X` → `./X`
   - `<IconPlaceholder lucide="XIcon" …/>` → `<XIcon />`，并删掉那条 import，改 `lucide-react`
3. **不要**把双引号统一改成单引号 —— 会打断 `[&_svg:not([class*="size-"])]` 这类任意值
4. 新增文件要加进 `src/index.ts` 的导出；跑 `oxfmt` 再 `tsc`

## 已知坑（组件用法，不是包的 bug）

| 坑 | 症状 | 怎么办 |
|---|---|---|
| `*MenuLabel` 放在 `*MenuGroup` 外 | tsc / build **全过**，浏览器一点开菜单就 `error in <MenuGroupLabel>`，**整页 React 树崩成白屏** | 永远包进 `*MenuGroup`（Base UI 相对 Radix 新增的隐式契约） |
| `Select` 不给 `items`（Base UI 版） | 触发器里显示原始 value 而不是标签 | 传 `items`，或自己渲染 `SelectValue` 的子节点 |
| 直接 `render={<Button/>}`（Radix 习惯） | 不生效，这是 Base UI | Base UI 用 `render` 属性 + `nativeButton={false}` 做「按钮外壳 + 链接语义」 |
| 少了 `data-horizontal` / `data-vertical` 变体 | 分隔线永远竖着、`Tabs` 永远横排、滚动条方向错，**不报错** | 已在 `src/styles.css` 定义（2026-11-25 补），不要在消费方再定义一份 |

## 方向变体为什么在包里

`separator` / `tabs` / `scroll-area` 的类名里写着 `data-horizontal:*` / `data-vertical:*`，但 registry 的 base-nova 模板**不带这两个变体定义**。变体与组件分开维护，就是「不报错、只是不生成规则」这类 bug 的温床 —— 所以它们和语义变量一样，跟着组件走。

## 边界：这里只放「原样组件」

`src/components/ui/*` 只放从 registry 落的**原样**组件 —— 它们要能被上面的脚本重跑覆盖。
**我们的组合件不放这里**：带业务语义的（`ConfirmDialog` / `ModelPicker` / 待办卡 / 消息气泡）留在消费方包。
理由有两条，都是会真实发生的：① CLI 更新组件会覆盖掉我们在同文件里的改动；② 这个包一旦开始收组合件，
就会变成第二个「什么都往里塞」的垃圾场，而它的价值恰恰在于「薄、可整包重生成」。

## 变量为什么在这里

组件用 `bg-background` / `ring-ring` 这类语义类，Tailwind 缺对应 `--color-*` 时**不报错、只是不生成规则**
（静默失效）。所以变量跟着组件走。宿主想换主题（M3 配色 / 暗色策略）就按同一批变量名覆盖，
**不要改本包的 styles.css**。
