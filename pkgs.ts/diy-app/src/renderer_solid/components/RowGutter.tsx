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
 *
 * **默认鼠标专用**：条 `aria-hidden`、不进 tab 序，键盘与读屏只认行头那一个 `role="button"`
 * （review ##253 RV-4：同一行的动作不该有两个 tab 停靠点）。行头**没有**开关的行（正文行）
 * 传 `sole` —— 那时条才是全行唯一的键盘入口。
 */
import { Show } from "solid-js";
import { IconChevron, IconDot } from "./icons";

export function RowGutter(props: {
    /** 这一行**点开会不会多出东西**（false = 静态点，不承诺可展开） */
    can?: boolean;
    open?: boolean;
    onToggle?: () => void;
    /** 本条是该行**唯一**的开关（行头**不是**可点控件，如正文行）—— 只有这时条才可聚焦。
     *  其余行头自己就是 `role="button"`（TurnHeader / 过程 bar / 逐条过程 / 结尾槽 / 现场），
     *  条若也可聚焦就是**同一行动作两个 tab 停靠点**、读屏念两遍（##253 RV-4）。 */
    sole?: boolean;
}) {
    const can = () => props.can !== false;
    /** 条能否进 tab 序 / 带 button 语义：能展开 **且** 行头没别的开关 */
    const focusable = () => can() && !!props.sole;
    const tip = () => (props.open ? "收起" : "展开");
    /** 点击**必须** `stopPropagation`：条挂在块里、行头也是开合开关 —— 不拦就"一次点击翻转两下"
     *  （净效果 = 没反应；源码 R17 / 草图 R24⑥ 踩过两次的坑）。 */
    const fire = (e: Event) => {
        e.stopPropagation();
        props.onToggle?.();
    };
    return (
        // 条的默认姿态 = **只服务鼠标**：行头自己就是开关（`DisclosureHead` 的 role=button），
        // 条再带一次 button 语义 + tabindex，键盘就会在同一行停两次、读屏把同一动作念两遍
        // （##253 RV-4）。**两种结构都存在，且都要治**（CDP 实测）：
        //   · 人物栏 = 条**在行头里面**（`band.closest('[role=button]')` 非空）；
        //   · 过程 bar / 逐条过程 / 正文 / 结尾槽 = 条与行头**同层兄弟**。
        // 无论哪种，"两个停靠点"都成立，而"条退成装饰"对两种结构都够用（不必为此统一结构）。
        // 故：`aria-hidden` + 不进 tab 序 + 不带 role/aria-expanded，点击仍归它（鼠标要能点列）。
        // 静态条（`can=false`）同理不变：本来就不吃点击（CSS `pointer-events:none`）。
        // `sole` 给"行头不是控件"的行（正文行）开一个口子 —— 那时条就是全行唯一的键盘入口。
        <span
            class="diy-row-band"
            data-row-band={can() ? "1" : "static"}
            title={can() ? tip() : undefined}
            role={focusable() ? "button" : undefined}
            tabindex={focusable() ? 0 : undefined}
            aria-label={focusable() ? tip() : undefined}
            aria-expanded={focusable() ? !!props.open : undefined}
            aria-hidden={focusable() ? undefined : "true"}
            onClick={can() ? fire : undefined}
            onKeyDown={
                focusable()
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
