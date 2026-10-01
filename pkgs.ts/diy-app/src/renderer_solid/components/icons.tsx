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

/**
 * 垃圾桶 —— 语义：删除 / 清空（破坏性，调用方须自备二次确认与 tooltip）。
 * 与同族图标一致：24×24、`fill-current`、尺寸交给调用方。
 */
export function IconTrash(props: { class?: string }) {
    return (
        <svg class={`fill-current ${props.class ?? ""}`} viewBox="0 0 24 24" aria-hidden="true">
            <path
                fill-rule="evenodd"
                clip-rule="evenodd"
                d="M16.5 4.478v.227a48.816 48.816 0 0 1 3.878.512.75.75 0 1 1-.256 1.478l-.209-.035-1.005 13.07a3 3 0 0 1-2.991 2.77H8.084a3 3 0 0 1-2.991-2.77L4.087 6.66l-.209.035a.75.75 0 0 1-.256-1.478A48.567 48.567 0 0 1 7.5 4.705v-.227c0-1.564 1.213-2.9 2.816-2.951a52.662 52.662 0 0 1 3.369 0c1.603.051 2.815 1.387 2.815 2.951Zm-6.136-1.452a51.196 51.196 0 0 1 3.273 0C14.39 3.05 15 3.684 15 4.478v.113a49.488 49.488 0 0 0-6 0v-.113c0-.794.609-1.428 1.364-1.452Zm-.355 5.945a.75.75 0 1 0-1.5.058l.347 9a.75.75 0 1 0 1.499-.058l-.346-9Zm5.48.058a.75.75 0 1 0-1.498-.058l-.347 9a.75.75 0 0 0 1.5.058l.345-9Z"
            />
        </svg>
    );
}

/**
 * 拖拽手柄 —— 语义：按住可拖动该行（列表排序）。
 *
 * 六点（2 列 × 3 行）而不是三横线：三横线在列表里与"汉堡菜单"同形，会被当成可展开的菜单入口；
 * 六点排成两列是这个动作的通行写法（dsh / 各类看板的 drag handle）。
 */
export function IconGrip(props: { class?: string }) {
    return (
        <svg class={`fill-current ${props.class ?? ""}`} viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="9" cy="6" r="1.5" />
            <circle cx="15" cy="6" r="1.5" />
            <circle cx="9" cy="12" r="1.5" />
            <circle cx="15" cy="12" r="1.5" />
            <circle cx="9" cy="18" r="1.5" />
            <circle cx="15" cy="18" r="1.5" />
        </svg>
    );
}

/**
 * 时钟 —— 语义：排队等待（留言默认的"下一轮"状态）。
 *
 * 与闪电配成一对可切换的两态：时钟 = 还得等，闪电 = 立刻插进去。
 * 两态若只用颜色区分（同一箭头换色），一眼扫过去容易漏 —— 形状不同才不需要读 tooltip。
 */
export function IconClock(props: { class?: string }) {
    return (
        <svg
            class={`fill-none stroke-current ${props.class ?? ""}`}
            viewBox="0 0 24 24"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
        >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5V12l3 2" />
        </svg>
    );
}

/** 闪电 —— 语义：立刻插话（加急到下一步）。实心画法，比描边箭头在小尺寸下更醒目。 */
export function IconBolt(props: { class?: string }) {
    return (
        <svg class={`fill-current ${props.class ?? ""}`} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M13.5 2 4.8 13.2h5.4L9.9 22l9-11.4h-5.6L13.5 2Z" />
        </svg>
    );
}
