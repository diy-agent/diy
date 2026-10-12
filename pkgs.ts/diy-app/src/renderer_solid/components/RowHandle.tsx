/**
 * **竖列折叠手柄** —— 行首 gutter 里那枚把手（草图 `rail-v4.html` 的 `.gut`）。
 *
 * 形状：能展开给 `IconChevron`（收起 ▸ / 展开 ▾），**不能展开给 `IconDot`** —— 同一格占位，
 * 左列才是齐的层级刻度（`expandableOf`：思考只有一行就不给展开能力，但格子不能空）。
 *
 * 为什么单独成列、不跟内容排在一行（2026-10-12 用户口径「竖版折叠条」）：手柄是**结构**，
 * 不是内容 —— 每行都有、位置固定、与内容长短无关。塞在内容里它跟着首行文字飘，
 * 扫不出"哪几行能开"；而 rail 皮肤那条贯穿线要**穿过这一列**（手柄压在线上），
 * 行内的箭头根本做不到。草图 A 皮肤把 `.gut` 钉在 `left:-9px`、与贯穿线同一条竖列上，
 * 就是这件事的字面写法。
 *
 * 位置由 **CSS** 决定（组件只给钩子，见 `index.css` 皮肤段的 `[data-row-handle]`）：
 *   · 竖直 —— **与该行首行垂直居中**（草图 R24①：不是整块顶部，也不浮在块中间）；
 *   · 水平 —— 贴在该皮肤的结构物上（rail = 贯穿线右侧 / card = 左 4px 色条上）。
 * 所以宿主必须 `position: relative`（`[data-row-head]` / `[data-block-tag="text"]` 等已在 CSS 里声明）。
 *
 * 点击**必须** `stopPropagation`：手柄通常挂在行头（`DisclosureHead`）里，而整行头本身就是
 * 一个开合开关 —— 不拦就变成"一次点击翻转两下"（净效果 = 没反应，与源码 R17 / 草图 R24⑥
 * 踩过的"点着像没反应"是同一类坑）。
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
