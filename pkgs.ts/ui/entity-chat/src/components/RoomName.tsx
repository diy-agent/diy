// RoomName.tsx —— 容器名字的「就地改名」与任务状态小胶囊。
//
// 为什么单独一份：名字在**侧栏**和**头部标题**两处出现，两处都要能改
// （之前只有侧栏双击能改 —— 一个没有提示、收起侧栏后就消失的入口，
//  用户报的就是「项目/任务无法修改名称」）。
// 行为统一在这里：回车提交、Esc 取消、失焦提交，提交失败由 store 亮错误。

import { CircleCheck, CircleDot } from 'lucide-react';
import * as React from 'react';

import { statusMeta, taskStatusOf, type Room } from '../model';
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
 * 形状与颜色都只在这里定义（侧栏行、历史行共用），不会出现「同一个状态两处画法不同」。
 * 颜色取值出自 `model.ts` 的 TASK_STATUSES。
 *
 * **这里只有“画”，没有“切”**（用户 2026-11-24）：切换是行尾那颗显式的「关闭 / 打开」按钮的事。
 * 一颗图标既当状态又当开关，等于把能力藏起来（没人知道它能点），工具里还容易误触。
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
            className={`relative inline-flex shrink-0 ${meta.text} ${className}`}
            title={`${running ? '正在运行 · ' : ''}状态：${meta.label}`}
        >
            <Icon className={iconClass} strokeWidth={2.4} />
            {running && (
                <span
                    aria-label="正在运行"
                    className="absolute -right-0.5 -top-0.5 size-1.5 animate-pulse rounded-full bg-emerald-400 ring-1 ring-background"
                />
            )}
        </span>
    );
}

