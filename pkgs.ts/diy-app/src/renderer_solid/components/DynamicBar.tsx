/**
 * **动态菜单条**（DynamicBar）—— 一种可复用的视图元素/技巧：
 *   · 只在"有上下文"时存在（选中了某一段），没有上下文就**完全不渲染**
 *     —— 不做"空条常驻"，否则取消选中后还留一条空横条，看着像坏了
 *   · 内容随上下文变化（↑/↓ 在出现处之间跳焦点 + `1/3` 计数 + 选中项名字 + ✕ 取消）
 *   · 操作都是"针对当前上下文"的（清除 = 取消选中，也就等于关掉这条菜单条）
 * 形态选 find-bar（细条 + join 按钮组 + 计数）而不是 daisyUI 的 alert：
 * alert 的语义是"消息"（role=alert + 彩色块），当工具栏会喧宾夺主，读屏还会当通知播报。
 *
 * 两处共用：提示词页（模版源码 ↔ 预览两侧各一条）与上下文树页（请求预览）。
 */
export function DynamicBar(props: {
    /** 选中的是什么（节点名 / 变量路径） */
    label: string;
    count: number;
    index: number;
    onPrev: () => void;
    onNext: () => void;
    onClear: () => void;
}) {
    return (
        // 底色与"标注色"同系（高亮用 warning）→ 一眼看出这条菜单条是给高亮用的；
        // 将来别的动态菜单条换别的色系即可互相区隔
        <div class="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/15 px-2 py-0.5 text-[11px]">
            <span class="join join-horizontal">
                <button
                    class="btn btn-xs join-item"
                    title="上一个（Shift+↑）"
                    disabled={props.count === 0}
                    onClick={props.onPrev}
                >
                    ↑
                </button>
                <button
                    class="btn btn-xs join-item"
                    title="下一个（Shift+↓）"
                    disabled={props.count === 0}
                    onClick={props.onNext}
                >
                    ↓
                </button>
            </span>
            <span class="badge badge-xs badge-ghost font-mono" title="第几个 / 共几个">
                {`${props.index + 1}/${props.count}`}
            </span>
            <span class="truncate font-mono opacity-70" title={props.label}>
                {props.label}
            </span>
            <button class="btn btn-xs btn-ghost ml-auto" title="清除高亮" onClick={props.onClear}>
                ✕
            </button>
        </div>
    );
}
