// RoomName.tsx —— 容器名字的「就地改名」与任务状态小胶囊。
//
// 为什么单独一份：名字在**侧栏**和**头部标题**两处出现，两处都要能改
// （之前只有侧栏双击能改 —— 一个没有提示、收起侧栏后就消失的入口，
//  用户报的就是「项目/任务无法修改名称」）。
// 行为统一在这里：回车提交、Esc 取消、失焦提交，提交失败由 store 亮错误。

import * as React from 'react';

import { nextTaskStatus, statusMeta, taskStatusOf, type Room } from '../model';
import { actions } from '../store';

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

    return (
        <button
            onClick={() => {
                onClick?.();
                if (mode === 'click') start();
            }}
            onDoubleClick={() => {
                if (mode === 'double') start();
            }}
            title={title ?? (mode === 'click' ? '点击改名' : '双击重命名')}
            className={className ?? 'min-w-0 flex-1 truncate text-left'}
        >
            {value}
        </button>
    );
}

/** 任务状态胶囊：点一下按 未开始 → 进行中 → 已完成 循环 */
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
    return (
        <button
            onClick={(event) => {
                event.stopPropagation();
                void actions.setRoomStatus(room.id, nextTaskStatus(status));
            }}
            title={`状态：${meta.label}（点击切换）`}
            className={
                compact
                    ? `shrink-0 rounded p-0.5 hover:bg-muted ${className}`
                    : `flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] hover:bg-muted ${className}`
            }
        >
            <span className={`size-1.5 rounded-full ${meta.dot}`} />
            {!compact && <span className={meta.text}>{meta.label}</span>}
        </button>
    );
}
