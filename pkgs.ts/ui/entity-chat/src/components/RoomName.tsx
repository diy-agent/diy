// RoomName.tsx —— 容器名字的「就地改名」与任务状态小胶囊。
//
// 为什么单独一份：名字在**侧栏**和**头部标题**两处出现，两处都要能改
// （之前只有侧栏双击能改 —— 一个没有提示、收起侧栏后就消失的入口，
//  用户报的就是「项目/任务无法修改名称」）。
// 行为统一在这里：回车提交、Esc 取消、失焦提交，提交失败由 store 亮错误。

import { CircleCheck, CircleDot } from 'lucide-react';
import * as React from 'react';

import { statusMeta, taskStatusOf, toggleTaskStatus, type Room } from '../model';
import { actions } from '../store';
import { isPlainLeftClick } from './link';

/**
 * 就地改名的文本。`mode`：
 *  - `double`：单击选中（侧栏行），双击进入编辑
 *  - `click`：单击直接进入编辑（头部大标题 —— 那里单击原本没有别的含义）
 *
 * 编辑态可受控（`editing` + `onEditingChange`）：侧栏行要把「铅笔按钮」也接进同一个
 * 编辑态，否则按钮只能是装饰（早期版本正是这么写的：按钮在、点了没反应）。
 */
export function EditableName({
    value,
    onCommit,
    mode = 'double',
    className,
    inputClassName,
    onClick,
    href,
    title,
    editing: controlledEditing,
    onEditingChange,
}: {
    value: string;
    onCommit: (next: string) => void;
    mode?: 'double' | 'click';
    className?: string;
    inputClassName?: string;
    onClick?: () => void;
    /**
     * 给了就渲染成真正的 `<a>`（侧栏导航项）：中键新标签页、右键复制链接、悬停看地址
     * 这些都是浏览器白给的，用 `<button>` + onClick 得自己写一遍且永远差一截。
     * 非左键 / 带修饰键的点击**不拦**，交给浏览器。
     */
    href?: string;
    title?: string;
    editing?: boolean;
    onEditingChange?: (editing: boolean) => void;
}) {
    const [innerEditing, setInnerEditing] = React.useState(false);
    const editing = controlledEditing ?? innerEditing;
    const setEditing = React.useCallback(
        (next: boolean) => {
            setInnerEditing(next);
            onEditingChange?.(next);
        },
        [onEditingChange],
    );
    const [draft, setDraft] = React.useState(value);
    /** 已提交过就不再提交：回车会先提交、再触发 input 卸载带来的 blur */
    const committed = React.useRef(false);

    // 外部改名（另一个窗口 / 后端回写）时同步草稿；正在编辑时别抢用户输入
    React.useEffect(() => {
        if (!editing) setDraft(value);
    }, [value, editing]);

    /**
     * 每次**进入**编辑态都要把 `committed` 复位。
     *
     * 坑：早先只在 `start()`（双击路径）里复位，而侧栏的铅笔按钮走的是外部受控路径
     * （直接改 `editing` prop，不经过 `start()`）。于是第一次提交后 `committed` 永远停在
     * true，之后每次回车都在 commit 第一行 return —— 连 `setEditing(false)` 都不执行，
     * 输入框卡住、名字也没保存。表现就是「改完回车，还是编辑状态」。
     * 复位挂在 `editing` 上，两条入口都覆盖。
     */
    React.useEffect(() => {
        if (editing) committed.current = false;
    }, [editing]);

    const start = (): void => {
        committed.current = false;
        setDraft(value);
        setEditing(true);
    };

    const commit = (): void => {
        if (committed.current) return;
        committed.current = true;
        setEditing(false);
        if (draft.trim() !== '' && draft.trim() !== value) onCommit(draft.trim());
    };

    const cancel = (): void => {
        committed.current = true;
        setDraft(value);
        setEditing(false);
    };

    if (editing) {
        return (
            <input
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                onBlur={commit}
                onKeyDown={(event) => {
                    // 中文输入法还在组合态时，回车是「选词」不是「提交」
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        commit();
                    }
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        cancel();
                    }
                }}
                onClick={(event) => event.stopPropagation()}
                className={inputClassName ?? 'min-w-0 flex-1 rounded border bg-background px-1 text-sm outline-none'}
            />
        );
    }

    const label = title ?? (mode === 'click' ? '点击改名' : '双击重命名');
    const labelClass = className ?? 'min-w-0 flex-1 truncate text-left';
    const onLinkClick = (event: React.MouseEvent<HTMLAnchorElement>): void => {
        // 新标签页 / 新窗口 / 下载：留给浏览器，别 preventDefault
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        onClick?.();
        if (mode === 'click') start();
    };

    if (href !== undefined) {
        return (
            <a
                href={href}
                onClick={onLinkClick}
                onDoubleClick={() => {
                    if (mode === 'double') start();
                }}
                title={label}
                className={labelClass}
            >
                {value}
            </a>
        );
    }

    return (
        <button
            onClick={() => {
                onClick?.();
                if (mode === 'click') start();
            }}
            onDoubleClick={() => {
                if (mode === 'double') start();
            }}
            title={label}
            className={labelClass}
        >
            {value}
        </button>
    );
}

/**
 * 状态图标：**GitHub issue 的 open / closed 语言**（用户：状态改成一个 title 前的图标）。
 *
 * 两态两个形状：空心圆点 = open（还在手上，绿）→ 打勾圆 = closed（收工，紫）。
 * 颜色 + 形状缺一不可 —— 只靠颜色，色弱用户读不出区别。
 *
 * 侧栏行里原来的「彩色圆点 + 文字胶囊 + 默认应答色点」三件套占满了行尾，
 * 用户报「信息太多」。图标只占 14px，且**放到标题前面**（GitHub 列表的读法：状态在左）。
 *
 * 形状与颜色都只在这里定义：侧栏行（StatusIcon）与头部胶囊（StatusChip）共用，
 * 不会出现「同一个状态两处画法不同」。颜色取值出自 `model.ts` 的 TASK_STATUSES。
 */
const STATUS_ICON = {
    open: CircleDot,
    closed: CircleCheck,
} as const;

/** 只画形状（无交互）：收起态 rail 的行本身就是一个 button，里面不能再嵌 button */
export function StatusGlyph({
    room,
    className = '',
    iconClass = 'size-4',
    running = false,
}: {
    room: Room;
    className?: string;
    iconClass?: string;
    /** 这个容器此刻真有成员在跑：呼吸一下（**不加新元素**，也不抢状态图标本身的颜色） */
    running?: boolean;
}) {
    if (room.type !== 'task') return null;
    const status = taskStatusOf(room);
    const meta = statusMeta(status);
    const Icon = STATUS_ICON[status];
    return (
        <span
            className={`inline-flex shrink-0 ${meta.text} ${className} ${running ? 'animate-pulse' : ''}`}
            title={`${running ? '正在运行 · ' : ''}状态：${meta.label}`}
        >
            <Icon className={iconClass} strokeWidth={2.4} />
        </span>
    );
}

/** 只画图标（不画文字）：侧栏行展开态用。点一下 open ↔ closed */
export function StatusIcon({
    room,
    className = '',
    running = false,
}: {
    room: Room;
    className?: string;
    /** 有成员在跑：图标呼吸（与 open / closed 那颗开关并排，但不合并 —— 那是人写的，这是事实） */
    running?: boolean;
}) {
    if (room.type !== 'task') return null;
    const status = taskStatusOf(room);
    const meta = statusMeta(status);
    const next = toggleTaskStatus(status);
    return (
        <button
            onClick={(event) => {
                event.stopPropagation();
                void actions.setRoomStatus(room.id, next);
            }}
            title={`${running ? '正在运行 · ' : ''}${meta.label}（点击${next === 'closed' ? '关闭，并从项目树收起' : '重新打开'}）`}
            aria-label={`状态：${meta.label}（点击切换）`}
            className={`shrink-0 rounded p-0.5 hover:bg-muted ${className}`}
        >
            <StatusGlyph room={room} iconClass="size-3.5" running={running} />
        </button>
    );
}

/**
 * 图标 + 文字胶囊（头部标题用：那里空间够，文字帮得上忙）。
 * `compact` = 只要图标，与 StatusIcon 同一个形状（收起态 rail 装不下文字）。
 */
export function StatusChip({
    room,
    compact = false,
    className = '',
}: {
    room: Room;
    compact?: boolean;
    className?: string;
}) {
    if (room.type !== 'task') return null;
    const status = taskStatusOf(room);
    const meta = statusMeta(status);
    const Icon = STATUS_ICON[status];
    return (
        <button
            onClick={(event) => {
                event.stopPropagation();
                void actions.setRoomStatus(room.id, toggleTaskStatus(status));
            }}
            title={`${meta.label}（点击${toggleTaskStatus(status) === 'closed' ? '关闭' : '重新打开'}）`}
            aria-label={`状态：${meta.label}（点击切换）`}
            className={
                compact
                    ? `shrink-0 rounded p-0.5 hover:bg-muted ${meta.text} ${className}`
                    : `flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] hover:bg-muted ${className}`
            }
        >
            <Icon className={compact ? 'size-3.5' : 'size-3'} strokeWidth={2.4} />
            {!compact && <span className={meta.text}>{meta.label}</span>}
        </button>
    );
}
