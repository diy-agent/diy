/**
 * DynamicBar — **动态菜单条**：一条"只在有上下文时存在"的工具栏。
 *
 * 为什么独立成文件：本形态已被两处使用（提示场的出现处跳转、任务树的搜索结果跳转），
 * 原来它是 PromptLabV4Page 里的私有函数，第二个使用方只能复制一份 —— 复制出来的
 * 两条会各自演化（本项目已因同类原因吃过对齐漂移的亏，见 lib/layout-metrics.ts）。
 *
 * 约定（形态本身即契约，改这里会影响所有使用方）：
 *   · 只在"有上下文"时存在，没有上下文就**完全不渲染** —— 不做"空条常驻"，
 *     否则上下文消失后还留一条空横条，看着像坏了
 *   · 内容随上下文变化：↑/↓ 在候选项之间跳 + `i/n` 计数 + 当前项名字 + ✕ 清除
 *   · 操作都是"针对当前上下文"的（清除 = 取消上下文，也就等于关掉这条菜单条）
 * 形态选 find-bar（细条 + join 按钮组 + 计数）而不是 daisyUI 的 alert：
 * alert 的语义是"消息"（role=alert + 彩色块），当工具栏会喧宾夺主，读屏还会当通知播报。
 */

export function DynamicBar(props: {
    /** 当前上下文是什么（节点名 / 变量路径 / 搜索词） */
    label: string;
    /** 候选项总数（0 = 无命中：两个方向键都禁用，计数显示 0/0） */
    count: number;
    /** 当前落在第几个（0 基） */
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
                    title="上一个"
                    disabled={props.count === 0}
                    onClick={props.onPrev}
                >
                    ↑
                </button>
                <button
                    class="btn btn-xs join-item"
                    title="下一个"
                    disabled={props.count === 0}
                    onClick={props.onNext}
                >
                    ↓
                </button>
            </span>
            <span class="badge badge-xs badge-ghost font-mono" title="第几个 / 共几个">
                {/* 空集显示 0/0：`index + 1` 在没候选项时会渲染成「1/0」，
                    读起来像"有一个但总数是零"。0 与「第几个」无关，是另一种状态。 */}
                {props.count === 0 ? "0/0" : `${props.index + 1}/${props.count}`}
            </span>
            <span class="truncate font-mono opacity-70" title={props.label}>
                {props.label}
            </span>
            <button class="btn btn-xs btn-ghost ml-auto" title="清除（关闭这条菜单条）" onClick={props.onClear}>
                ✕
            </button>
        </div>
    );
}

