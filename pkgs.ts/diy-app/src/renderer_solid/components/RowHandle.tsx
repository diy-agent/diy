/**
 * **竖列折叠条** —— 行首 gutter 里那一列把手，拆成两件东西（草图 `rail-v3.html` 的 `.gut`，
 * 2026-10-12 用户口径「折叠条按 v3，但图标放首行居中」）：
 *
 *   · `RowBand` —— **贴条**：`top:0;bottom:0` **整个块的高度**（v3 的 `.gut{top:0;bottom:0}`，
 *     不是 v4 那个只有 20px 的"首行伸缩"），透明底、悬停显形，鼠标点哪一截都开合；
 *   · `RowHandle` —— **图标**：小尖头/静态点，**与该行首行垂直居中**（v3 把图标居中在整个
 *     块的中间 —— 大块上会飘到内容里去，用户点名改成首行居中）。
 *
 * 为什么必须是两件：贴条要"整个块高"、图标要"首行居中"，两者锚点不同 —— 贴条锚**块**
 * （`[data-block-id]`，含展开后的正文），图标锚**行头**（行头恒单行 ⇒ 行头居中 == 首行居中，
 * 不用给每种行算 padding 常数）。所以 `RowBand` 挂在**块级**、`RowHandle` 留在**行头里**；
 * 行头不能是定位上下文（否则贴条会被框在行头那一行里）—— `data-row-head` 的
 * `position:relative` 只留给图标自己。
 *
 * 位置由 **CSS** 决定（组件只给钩子，见 `index.css` 皮肤段）：水平贴在该皮肤的结构物上
 * （card = 左 4px 色条上 / rail = 贯穿线右侧），两者同一条竖列。
 *
 * 点击**必须** `stopPropagation`：手柄挂在行头（`DisclosureHead`）里时整行头本身就是一个
 * 开合开关 —— 不拦就变成"一次点击翻转两下"（净效果 = 没反应，源码 R17 / 草图 R24⑥
 * 踩过两次的坑）。`RowBand` 同理：它与行头是兄弟，点了不该再冒给父级。
 */
import { Show } from "solid-js";
import { IconChevron, IconDot } from "./icons";

export function RowHandle(props: {
    /** 这一行**点开会不会多出东西**（false = 静态点，不承诺可展开） */
    can?: boolean;
    open?: boolean;
    onToggle?: () => void;
    /** 读屏文案（手柄里只有图标，读屏念不出来） */
    label?: string;
}) {
    const can = () => props.can !== false;
    const tip = () => (props.open ? "收起" : "展开");
    const fire = () => props.onToggle?.();
    return (
        <Show
            when={can()}
            fallback={
                <span class="diy-row-handle" data-row-handle="static" aria-hidden="true">
                    <IconDot class="h-3.5 w-3.5 opacity-20" />
                </span>
            }
        >
            <span
                class="diy-row-handle"
                data-row-handle="1"
                role="button"
                tabindex={0}
                title={tip()}
                aria-label={props.label ?? tip()}
                aria-expanded={!!props.open}
                onClick={(e) => {
                    e.stopPropagation();
                    fire();
                }}
                onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    e.stopPropagation();
                    fire();
                }}
            >
                <IconChevron open={!!props.open} class="h-3.5 w-3.5 opacity-40" />
            </span>
        </Show>
    );
}

/**
 * **贴条**（`RowBand`）：整块高度的那条竖带，纯鼠标便利 —— 读屏/键盘入口都在
 * `RowHandle` 的图标上，所以这里 `aria-hidden`，也不进 tab 序。
 */
export function RowBand(props: { onToggle?: () => void }) {
    return (
        <span
            class="diy-row-band"
            data-row-band="1"
            aria-hidden="true"
            onClick={(e) => {
                e.stopPropagation();
                props.onToggle?.();
            }}
        />
    );
}
