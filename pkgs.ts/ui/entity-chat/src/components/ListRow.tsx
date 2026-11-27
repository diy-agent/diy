// ListRow —— 列表行的**唯一形态**（目标列表 / 任务列表共用）。
//
// 2026-11-27 用户：「目标与外部任务的显示形式是否需要同构，即图标、状态，当前及历史的分开、
// 历史可折叠？」—— 结论是**视觉语法同构、结构不同构**：
//   · 同构的：行高 / 图标位 / 状态点 / 标题字号 / 副行 / 右端进度与时间 / 选中环。
//     人在两个列表之间切换时问的是同一个问题「哪些在做、卡在哪」，学两套视觉语法是白交学费。
//   · 不同构的：行**里面**装什么。目标是 accept / 决策 / 步骤 / 来源原话；任务是 cwd / 成员 /
//     会话 / 作业。硬揉成一种会把其中一个塞进假字段。
//
// 所以这里只抽「形状」：leading（状态点 / 图标）+ title + 可选 meta 副行 + trailing。
// 两个列表都从这里拿 className，样式只有一个真源 —— 不再一边 px-1.5 一边 px-2。
import * as React from 'react';

/** 行的外框：与侧栏 `RoomRow` 同一套刻度（2026-11-27 对齐；改这里两边一起动） */
export const LIST_ROW_BASE = 'flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left';
/** 标题：12px、单行省略 —— 两个列表都是它 */
export const LIST_ROW_TITLE = 'min-w-0 flex-1 truncate text-[12px]';
/** 副行 / 旁注：10px、次要色 */
export const LIST_ROW_META = 'text-[10px] text-muted-foreground';

export interface ListRowProps {
    /** 行首：状态点 / 图标（宽度恒定，不然标题会随内容左右跳） */
    leading?: React.ReactNode;
    title: string;
    /** 标题下的副行：进度、来源原话、缺口标记…（可省） */
    meta?: React.ReactNode;
    /** 行尾：进度条 / 计数 / 动作（可省） */
    trailing?: React.ReactNode;
    /** 是不是当前在看的这一行（只影响底色与描边，不碰状态色） */
    active?: boolean;
    /** 点整行 */
    onSelect?: () => void;
    /** 标题的悬停全文（长标题被 truncate 时的兜底） */
    titleText?: string;
    /**
     * 层级缩进的级数（1 = 目标的下一层）。只改左内边距，其余刻度不动 ——
     * 缩进太狠会让 14px 的宽度吃掉半行标题。
     */
    indent?: number;
    /** 有子行时的折叠状态（`undefined` = 这一行没有子行，不画箭头） */
    expanded?: boolean;
    /** 折叠箭头的点击（与 `onSelect` 分开：折叠是「看不看得到」，选中是「看哪一条」） */
    onToggle?: () => void;
}

export function ListRow({
    leading,
    title,
    meta,
    trailing,
    active = false,
    onSelect,
    titleText,
    indent = 0,
    expanded,
    onToggle,
}: ListRowProps): React.JSX.Element {
    // 折叠箭头：只用 `role="button"` 的 span，不用嵌套 <button>（行本身已经是 button）。
    // 点击必须 stopPropagation —— 否则「收起」会先被行选中的 handler 吃掉，变成开详情。
    const chevron =
        onToggle === undefined ? null : (
            <span
                role="button"
                tabIndex={0}
                aria-expanded={expanded === true}
                aria-label={expanded === true ? '收起子项' : '展开子项'}
                onClick={(event) => {
                    event.stopPropagation();
                    onToggle();
                }}
                onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.stopPropagation();
                    event.preventDefault();
                    onToggle();
                }}
                className="flex w-3 shrink-0 cursor-pointer justify-center text-[9px] text-muted-foreground hover:text-foreground"
            >
                <span className={`transition-transform ${expanded === true ? 'rotate-90' : ''}`}>▶</span>
            </span>
        );
    const body = (
        <>
            {chevron}
            {leading !== undefined && <span className="flex w-3 shrink-0 justify-center">{leading}</span>}
            <span className="flex min-w-0 flex-1 flex-col">
                <span className={LIST_ROW_TITLE} title={titleText ?? title}>
                    {title}
                </span>
                {meta !== undefined && <span className={`mt-0.5 flex items-center gap-1.5 ${LIST_ROW_META}`}>{meta}</span>}
            </span>
            {trailing !== undefined && <span className="flex shrink-0 items-center gap-1.5">{trailing}</span>}
        </>
    );

    const padding = indent === 0 ? undefined : { paddingLeft: `${8 + indent * 14}px` };
    if (onSelect === undefined)
        return (
            <div className={LIST_ROW_BASE} style={padding}>
                {body}
            </div>
        );
    return (
        <button
            type="button"
            onClick={onSelect}
            aria-selected={active}
            className={`${LIST_ROW_BASE} hover:bg-muted ${active ? 'bg-sky-500/10 ring-1 ring-sky-500/30' : ''}`}
            style={padding}
        >
            {body}
        </button>
    );
}
