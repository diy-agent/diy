/**
 * **竖列折叠条**（草图 `rail-v3.html` 的 `.gut` × v4 的形态；2026-10-12 用户口径第三次修订）。
 *
 * 它是**一根条**、**一个点击区**：整块高度的一条竖带（v3 的 `top:0;bottom:0`），
 * 尖头图标画在这条带的**首行居中**处（v3 把图标居中在整个块的中间 —— 大块上会飘到内容里去，
 * 用户点名改成首行居中）。条与图标是**同一个元素的两层**，不拆两件：
 *   · 拆两件（R3/R4 的做法）时，贴条锚**块**、图标锚**行头** —— 行头被卡内留白推右 16px，
 *     于是同一行的"竖 bar"与"箭头"错开一格，成了**两个点击区**（用户 R6 点名："很乱"）。
 *
 * 位置全由 **CSS** 定（组件只给 `data-row-band` / `data-row-handle` 钩子，见 `index.css` 皮肤段）：
 *   · 竖 = 贴条 `top:0;bottom:0`（整块高）；图标 `top: var(--diy-gut-top)`（两皮肤同一个常数 = 首行居中）。
 *   · 横 = 块自己的左留白那一列（`--diy-gut-w`）：card 压在左 4px 色条上、rail 贴着贯穿线。
 *
 * 「能不能展开」由 `can` 给（`chat-fold.expandableOf`）：不能展开的行给同格的**静态点**
 * （左列那一串箭头/点才是"这行能展开"的视觉语言，格子不能空）—— 静态条不吃点击
 * （CSS `pointer-events:none`），让事件落到行头自己身上。
 */
import { Show } from "solid-js";
import { IconChevron, IconDot } from "./icons";

export function RowGutter(props: {
    /** 这一行**点开会不会多出东西**（false = 静态点，不承诺可展开） */
    can?: boolean;
    open?: boolean;
    onToggle?: () => void;
    /** 读屏文案（条里只有图标，读屏念不出来） */
    label?: string;
}) {
    const can = () => props.can !== false;
    const tip = () => (props.open ? "收起" : "展开");
    /** 点击**必须** `stopPropagation`：条挂在块里、行头也是开合开关 —— 不拦就"一次点击翻转两下"
     *  （净效果 = 没反应；源码 R17 / 草图 R24⑥ 踩过两次的坑）。 */
    const fire = (e: Event) => {
        e.stopPropagation();
        props.onToggle?.();
    };
    return (
        <span
            class="diy-row-band"
            data-row-band={can() ? "1" : "static"}
            role={can() ? "button" : undefined}
            tabindex={can() ? 0 : undefined}
            title={can() ? tip() : undefined}
            aria-label={can() ? (props.label ?? tip()) : undefined}
            aria-expanded={can() ? !!props.open : undefined}
            aria-hidden={can() ? undefined : "true"}
            onClick={can() ? fire : undefined}
            onKeyDown={
                can()
                    ? (e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          fire(e);
                      }
                    : undefined
            }
        >
            <span class="diy-row-handle" data-row-handle={can() ? "1" : "static"} aria-hidden="true">
                <Show when={can()} fallback={<IconDot class="h-3.5 w-3.5 opacity-20" />}>
                    <IconChevron open={!!props.open} class="h-3.5 w-3.5 opacity-40" />
                </Show>
            </span>
        </span>
    );
}
