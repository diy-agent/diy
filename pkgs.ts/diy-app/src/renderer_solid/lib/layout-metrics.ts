/**
 * 布局度量常量 —— 跨组件的**几何契约**。
 *
 * 为什么要有这个文件：同一条水平带上的控件分属两个组件（`ViewGrid` 的 area chrome
 * 浮层 + 各 view 自己的顶栏），各自写 Tailwind 时必然漂移。实测漂移过：
 *   · view 顶栏 `py-2`  → 43px（`py-1.5` 的 37px 又是另一档）
 *   · area chrome      → 20px 裸条，`absolute top-0`，按钮贴顶
 * 两者起点同在 y=69，但一个 43px 一个 20px，于是 chrome 图标看着"贴在右上角"、
 * 和顶栏里的按钮对不齐。统一到常量后，两边各自引同一个值，改一处即全对齐。
 */

/**
 * 视图条（view bar）高度 —— area chrome 与各 view 顶栏共用。
 *
 * 取 32px（`h-8`）：装得下 daisyUI `btn-xs`（24px）+ 上下各 4px，比原来的 43px 明显窄。
 * 用法：容器加 `items-center` + 本常量，**不要再写 `py-*`** —— 一旦写回 padding，
 * 高度就由内容撑开，又回到"每个组件一个高度"的老问题。
 */
export const VIEW_BAR_H = "h-8";

/** 同上，px 数值（测量/断言/文档用；不要拿它去拼 class） */
export const VIEW_BAR_H_PX = 32;
