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

/**
 * 聊天输入区（composer）的封顶高度 —— **view 高度的 1/3**（任务 257 R5）。
 *
 * 主语是**整个输入框**（`rounded-field` 盒子 = 正文 + 底部工具条），不是只算正文宿主：
 * review2-2 实测只封宿主时整体比 view/3 高出 50px。调用方把它挂到盒子的 `max-height` 上，
 * 由 `flex flex-col` + 正文 `flex-auto` / 工具条 `shrink-0` 去分配（见 LocalChatPage 输入框）。
 *
 * 口径为什么是"实测 view 高度"而不是 `33vh`：多 view 并排时页面比视口矮，
 * `33vh` 会明显超出一档（实测差 ~32px）。所以由调用方量宿主 `clientHeight` 后传进来。
 *
 * `viewH <= 0`（首帧 ResizeObserver 尚未回调）→ 兜 `33vh`：此时**不能返回空串/NaN**，
 * 那等于不封顶（长文本会把对话区挤没）；`33vh` 是同一口径的近似值，只活一帧。
 */
export function chatInputMaxHeight(viewH: number): string {
    return viewH > 0 ? `${Math.round(viewH / 3)}px` : "33vh";
}
