/**
 * 界面图标（内联 SVG，`currentColor`）—— 不引第三方图标库。
 *
 * 为什么必须同族：面积类操作（最大化 / 还原 / 最小化）原先用三个字符 `⛶` / `🗗` / `—`，
 * 字重、占位、深浅主题下的颜色都不一致（emoji 走字体渲染，不受 `currentColor` 控制），
 * 并排放在 area 右上角时视觉上不像一组控件。这里统一成 24×24、`fill-current` 的一套。
 *
 * 尺寸交给调用方（`class="h-4 w-4"`），图标本身不带尺寸 —— 同一图标在不同 chrome
 * 高度下要能复用（area chrome 是 h-5，输入框是 btn-xs）。
 */

/** 四角向外 —— 语义：最大化 / 展开 */
export function IconExpand(props: { class?: string }) {
    return (
        <svg class={`fill-current ${props.class ?? ""}`} viewBox="0 0 24 24" aria-hidden="true">
            <path
                fill-rule="evenodd"
                clip-rule="evenodd"
                d="M15 3.75a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0V5.56l-3.97 3.97a.75.75 0 1 1-1.06-1.06l3.97-3.97h-2.69a.75.75 0 0 1-.75-.75Zm-6 16.5a.75.75 0 0 1-.75.75h-4.5a.75.75 0 0 1-.75-.75v-4.5a.75.75 0 0 1 1.5 0v2.69l3.97-3.97a.75.75 0 1 1 1.06 1.06l-3.97 3.97h2.69a.75.75 0 0 1 .75.75Z"
            />
        </svg>
    );
}

/** 四角向内 —— 语义：还原（从最大化回到网格） */
export function IconCompress(props: { class?: string }) {
    return (
        <svg class={`fill-current ${props.class ?? ""}`} viewBox="0 0 24 24" aria-hidden="true">
            <path
                fill-rule="evenodd"
                clip-rule="evenodd"
                d="M3.28 2.22a.75.75 0 0 0-1.06 1.06L5.44 6.5H2.75a.75.75 0 0 0 0 1.5h4.5A.75.75 0 0 0 8 7.25v-4.5a.75.75 0 0 0-1.5 0v2.69L3.28 2.22Zm13.5 9.28a.75.75 0 0 0 0 1.5h2.69l-3.22 3.22a.75.75 0 1 0 1.06 1.06l3.22-3.22v2.69a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5Z"
            />
        </svg>
    );
}

/**
 * 收进角落 —— 语义：最小化 / 收起该区域（单向动作，不是开关，故不配 swap）。
 * 只用 rect 画（外框 + 右下实心块）：几何可推理，不依赖手写 path 的曲线控制点。
 * 描边走 `stroke`，实心块走 `fill` —— 故这个 svg 同时用两种 paint，不能只挂 `fill-current`。
 */
export function IconCollapse(props: { class?: string }) {
    return (
        <svg
            class={`fill-none stroke-current ${props.class ?? ""}`}
            viewBox="0 0 24 24"
            stroke-width="1.6"
            aria-hidden="true"
        >
            <rect x="2.8" y="2.8" width="18.4" height="18.4" rx="2.6" />
            <rect x="12.6" y="12.6" width="5.6" height="5.6" rx="1.2" class="fill-current stroke-none" />
        </svg>
    );
}
