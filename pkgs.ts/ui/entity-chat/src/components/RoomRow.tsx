// RoomRow.tsx —— 侧栏里一行容器（项目 / 任务 / 未归属的其它类型）。
//
// 从 Sidebar.tsx 搬出来是因为它现在被**三个**导航来源共用（项目树 / 历史 / 未归属），
// 留在壳里会让壳重新认识 room 这个概念；壳只知道「有几个来源、按 order 渲染」。

import { ChevronDown, ChevronRight, Folder, HelpCircle, ListPlus, Pencil, PenLine, Trash2 } from 'lucide-react';
import * as React from 'react';

import { formatAddress, roomAddressOf } from '../address';
import { useHasDraft } from '../drafts';
import { formatActivityAgo, formatAtAbsolute, roomTitle, type Room } from '../model';
import { pendingAskHintOf } from '../pendingAsk';
import { actions, useIsCurrentRoom, useLastActivityOf, usePendingAskOf, usePendingAskTitlesOf } from '../store';
import { isPlainLeftClick } from './link';
import { EditableName, StatusGlyph, StatusIcon } from './RoomName';

/** hover 才出现的行内小按钮：重命名 / 删除。键盘 Tab 也能到（focus-visible 展开） */
function RowAction({
    title,
    onClick,
    children,
    danger = false,
}: {
    title: string;
    onClick: () => void;
    children: React.ReactNode;
    danger?: boolean;
}) {
    return (
        <button
            onClick={(event) => {
                event.stopPropagation();
                onClick();
            }}
            title={title}
            aria-label={title}
            className={`shrink-0 rounded p-0.5 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 ${
                danger ? 'text-muted-foreground hover:bg-destructive/15 hover:text-destructive' : 'hover:bg-muted'
            }`}
        >
            {children}
        </button>
    );
}

export interface RoomRowProps {
    room: Room;
    compact: boolean;
    /** 项目行：任务列表是否收起（只有项目有）；收起时行尾显示未关闭任务数 */
    collapsed?: boolean;
    openTaskCount?: number;
    onToggleCollapse?: () => void;
    onCreateTask?: () => void;
    onRequestDelete: (room: Room) => void;
}

/**
 * 行的本体（未包 `memo`）。
 *
 * 单独导出只是为了能被替换成一个**计数**版本做渲染粒度测试（`tests/rerender.test.tsx`）：
 * 包装如果再套一层 `memo(RoomRow)`，行的内层渲染就数不到了 —— 量到的永远是“父级穿透”
 * 那一半，而真正要证的恰恰是「这一行自己该不该进 render」。
 */
export function RoomRowView({
    room,
    compact,
    collapsed = false,
    openTaskCount,
    onToggleCollapse,
    onCreateTask,
    onRequestDelete,
}: RoomRowProps) {
    // 细粒度订阅：这一行只关心「是不是当前那一行」「自己的草稿 / 待答提问 / 最后活动」。
    // 用 `useStore()` 拿整份快照的话，别的房间来了消息、一条错误冒出来，整张侧栏都重渲。
    //
    // 拿到的每个快照都是**单值**（一个布尔 / 一个数字 / 一个毫秒数）：`emit` 之后 React 用
    // `Object.is` 比，没变就不重渲这一行。再配上外层的 `React.memo`，父级（`App` / `Sidebar`
    // / 三个 nav 块）重渲的时候，只要 props 和这些值都没变，这一行连 render 都不会进来。
    const active = useIsCurrentRoom(room.id);
    // 行上两个标记，两件事：
    //   ✎ = 这里有**没发出去的字**（发言框 / 对话框草稿；提问填了一半不算，那有自己的卡片）
    //   ? = 这里有**提问在等你答**（服务端投影 + 当前房间的会话流，答完立刻灭）
    // 别合并成一个：一个是「我欠它一句」，一个是「它等我一句」，混着显示说不清是谁的事。
    const hasDraft = useHasDraft(room.id);
    const pendingAsk = usePendingAskOf(room.id);
    // `?` 的 tooltip 带上题干：只说「2 个提问等你回答」，进房间还得自己翻（用户报过这条）
    const askTitles = usePendingAskTitlesOf(room.id);
    const askHint = pendingAskHintOf(pendingAsk, askTitles);
    // 最后活动（这个容器里最后一条消息的时刻；服务端投影，见 store.tsx 的 lastActivity）。
    // 项目行不显示：项目不是干活的容器，它“活动不活动”是下面那堆任务的事 —— 每行都
    // 挂一个「—」只会多一列噪音。
    const activityAt = useLastActivityOf(room.id);
    const activityAgo = formatActivityAgo(activityAt);
    const [renaming, setRenaming] = React.useState(false);
    const isProject = room.type === 'project';
    const Icon = Folder;
    // 真地址：中键新标签页 / 右键复制链接由浏览器提供，别再拿 onClick 假装
    const href = formatAddress(roomAddressOf(room));

    // 收起态（rail 56px）：**只留一个图标**。任务 = 状态图标（形状即状态，GitHub 读法），
    // 项目 = 文件夹。行本身是链接，所以状态只能画成无交互的形状（StatusGlyph）——
    // `<a>` 里再嵌一个能点的 button 就是非法嵌套。
    if (compact) {
        return (
            <a
                href={href}
                onClick={(event) => {
                    if (!isPlainLeftClick(event)) return;
                    event.preventDefault();
                    actions.select(room.id);
                }}
                title={`${room.type}：${roomTitle(room)}${pendingAsk > 0 ? `（${askHint}）` : ''}`}
                className={`relative flex w-full items-center justify-center rounded-lg py-2 ${
                    active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted/60'
                }`}
            >
                {isProject ? <Icon className="size-4 text-sky-400" /> : <StatusGlyph room={room} iconClass="size-4" />}
                {hasDraft && (
                    <span
                        title="有未提交的草稿"
                        aria-label="有未提交的草稿"
                        className="absolute right-1 top-1 size-1.5 rounded-full bg-amber-400"
                    />
                )}
                {pendingAsk > 0 && (
                    <span
                        title={askHint}
                        aria-label="有提问等你回答"
                        className="absolute bottom-1 right-1 size-1.5 rounded-full bg-sky-400"
                    />
                )}
            </a>
        );
    }

    return (
        <div
            className={`group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted/60'
            }`}
        >
            {/* 状态图标在**标题前**（用户：像 GitHub 的 open / closed）：行里唯一的前缀图标。
                原先这里同时有「文件夹/清单图标 + 行尾状态胶囊 + 行尾默认应答色点」三件套，
                同一个问题说了三遍 —— 用户报「信息太多」。
                文件夹只留给项目（它没有状态）；任务的类型已经由“能点出状态”这件事自己说清了。 */}
            {/* 项目行最前面是折叠箭头：它在**行首**而不是行尾 —— 这里表示的是「下面那一堆子项」，
                和 GitHub / 文件树一个读法。收起时行尾补一个未关闭任务数，否则看不出里面还有东西。 */}
            {isProject && onToggleCollapse !== undefined && (
                <button
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleCollapse();
                    }}
                    title={collapsed ? '展开这个项目的任务' : '收起这个项目的任务'}
                    aria-label={collapsed ? '展开' : '收起'}
                    aria-expanded={!collapsed}
                    className="-ml-1 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
                >
                    {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                </button>
            )}

            {isProject ? <Icon className="size-3.5 shrink-0 text-sky-400" /> : <StatusIcon room={room} />}

            <EditableName
                value={roomTitle(room)}
                mode="double"
                editing={renaming}
                onEditingChange={setRenaming}
                onClick={() => actions.select(room.id)}
                href={href}
                onCommit={(next) => void actions.renameRoom(room.id, next)}
            />

            {isProject && collapsed && (openTaskCount ?? 0) > 0 && (
                <span
                    title={`${openTaskCount} 个未关闭任务`}
                    className="shrink-0 rounded-full border px-1.5 text-[10px] tabular-nums text-muted-foreground"
                >
                    {openTaskCount}
                </span>
            )}

            {hasDraft && (
                <span title="有未提交的草稿" aria-label="有未提交的草稿" className="shrink-0 text-amber-500">
                    <PenLine className="size-3" />
                </span>
            )}

            {/* 提问在等你答：颜色跟提问卡上的 HelpCircle 一致（天蓝），形状也一样 ——
                看见行上的 ? 就知道房间里那张卡长什么样。数字只在多于一个时显示。 */}
            {pendingAsk > 0 && (
                <span
                    title={askHint}
                    aria-label="有提问等你回答"
                    className="flex shrink-0 items-center gap-0.5 text-sky-400"
                >
                    <HelpCircle className="size-3" />
                    {pendingAsk > 1 && <span className="text-[10px] tabular-nums">{pendingAsk}</span>}
                </span>
            )}

            {/* 最后活动：紧贴行尾（hover 才出现的行内按钮之前），这样列表里的时间是一列对齐的。
                没聊过的任务显示「—」（侧栏的状态图标已经说「未运行」，这一格回答的是「多久没动静」）。 */}
            {!isProject && (
                <span
                    title={
                        activityAt === undefined
                            ? '会话里还没有消息（这个任务没和 agent 说过话）'
                            : `最后活动 ${formatAtAbsolute(activityAt)}（${activityAgo}）`
                    }
                    className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60"
                >
                    {activityAgo ?? '—'}
                </span>
            )}

            <RowAction title="重命名" onClick={() => setRenaming(true)}>
                <Pencil className="size-3.5" />
            </RowAction>

            {isProject && onCreateTask !== undefined && (
                <RowAction title="在本项目下新建任务（并直接对话）" onClick={onCreateTask}>
                    <ListPlus className="size-3.5" />
                </RowAction>
            )}

            <RowAction
                title={`删除${isProject ? '项目（连带其任务）' : '任务'}`}
                onClick={() => onRequestDelete(room)}
                danger
            >
                <Trash2 className="size-3.5" />
            </RowAction>
        </div>
    );
}

/**
 * 行组件。`memo` 在这里：父级（`App` / `Sidebar` / 三个 nav 块）重渲时，props 没变就
 * 直接跳到本行 —— 而「本行自己那一格变了」靠的是行内的单值订阅，不靠 props。
 */
export const RoomRow = React.memo(RoomRowView);
