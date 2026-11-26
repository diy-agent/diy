// RoomName.tsx —— 容器名字的「就地改名」与任务状态小胶囊。
//
// 为什么单独一份：名字在**侧栏**和**头部标题**两处出现，两处都要能改
// （之前只有侧栏双击能改 —— 一个没有提示、收起侧栏后就消失的入口，
//  用户报的就是「项目/任务无法修改名称」）。
// 行为统一在这里：回车提交、Esc 取消、失焦提交，提交失败由 store 亮错误。

import { CircleCheck, CircleDot, Folder } from 'lucide-react';
import * as React from 'react';

import { statusMeta, taskStatusOf, type Room } from '../model';
import { isPlainLeftClick } from './link';
import { Button, Input } from '@diy-agent/ui-shadcn';

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
            <Input
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
        // 可编辑名称的「非链接」分支：外观完全由调用方的 labelClass 决定（侧栏行 / 面板标题
        // 各不同），所以高度、内边距、对齐、字重全部压回中性，只借 Button 的 focus ring 与
        // disabled/键盘行为。
        <Button
            variant="ghost"
            size="xs"
            onClick={() => {
                onClick?.();
                if (mode === 'click') start();
            }}
            onDoubleClick={() => {
                if (mode === 'double') start();
            }}
            title={label}
            className={`h-auto justify-start p-0 font-inherit hover:bg-transparent ${labelClass}`}
        >
            {value}
        </Button>
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

/**
 * 只画形状（无交互）：收起态 rail 的行本身就是一个 link，里面不能再嵌 button。
 *
 * 形状 = 容器种类所说的那件事：
 *   · 任务 → open / closed（`STATUS_ICON`，GitHub issue 读法）；
 *   · 项目 → 文件夹（它没有 open / closed）。**但状态装饰一样有**（2026-11-26 用户：
 *     「项目也是 bot，也需要有和任务一样的状态图标信息」）—— 项目房间自己也有 bot、
 *     有轮次（`proj:diy` 那行实测跑过 131 轮），所以「上一轮出错」「正在运行」对项目同样成立。
 *     只看**它自己**，不聚合子任务：子行自己会亮，聚合会让同一个状态在树上出现两次
 *     （2026-11-25 用户报的「空会话也有轮次中呼吸」）。
 */
export function StatusGlyph({
    room,
    className = '',
    iconClass = 'size-4',
    running = false,
    broken = false,
}: {
    room: Room;
    className?: string;
    iconClass?: string;
    /** 这个容器此刻真有成员在跑：呼吸一下（**不加新元素**，也不抢状态图标本身的颜色） */
    running?: boolean;
    /**
     * 上一轮有成员出错（`needs-attention`）：图标**变红**。
     *
     * 用户 2026-11-26：“表格说「出错」，左侧导航栏的任务图标也应该变状态”——一个是表格、
     * 一个是侧栏，两处必须读同一份事实（`rooms.list` 的 `broken` 与 `bots.rows` 同源）。
     * 只改颜色不改形状：形状说的是 open / closed（项目是文件夹），那是另一件事。
     */
    broken?: boolean;
}) {
    const isProject = room.type === 'project';
    if (!isProject && room.type !== 'task') return null;
    const meta = isProject ? undefined : statusMeta(taskStatusOf(room));
    const Icon = isProject ? Folder : STATUS_ICON[taskStatusOf(room)];
    // 颜色：出错一律红（盖掉状态色）；项目平时是自己那颗天蓝，任务按 open / closed
    const ink = broken ? 'text-rose-400' : (meta?.text ?? 'text-sky-400');
    return (
        <span
            className={`relative inline-flex shrink-0 ${ink} ${className}`}
            title={`${broken ? '上一轮出错 · ' : ''}${running ? '正在运行 · ' : ''}${isProject ? '项目' : `状态：${meta?.label ?? 'open'}`}`}
        >
            <Icon className={iconClass} strokeWidth={2.4} />
            {running && (
                <>
                    {/* 光晕：6px 的点在已经高亮（选中）的行上根本看不见（2026-11-25 用户报「新任务没有
                        轮次中的效果」—— 点其实画了，只是没人看得见）。一个扩散的光环 + 一颗带背景环的点，
                        不动行底色、不动图标形状，也不占行里新的格子。 */}
                    <span className="pointer-events-none absolute -bottom-0.5 -right-0.5 size-2 animate-ping rounded-full bg-emerald-400/70" />
                    <span
                        aria-label="正在运行"
                        title="正在运行"
                        className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-emerald-400 ring-2 ring-background"
                    />
                </>
            )}
        </span>
    );
}
