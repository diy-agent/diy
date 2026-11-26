// RoomRow.tsx —— 侧栏里一行容器（项目 / 任务 / 未归属的其它类型）。
//
// 从 Sidebar.tsx 搬出来是因为它现在被**三个**导航来源共用（项目树 / 历史 / 未归属），
// 留在壳里会让壳重新认识 room 这个概念；壳只知道「有几个来源、按 order 渲染」。

import {
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Folder,
    HelpCircle,
    ListPlus,
    Loader2,
    Pencil,
    PenLine,
    RotateCcw,
    Trash2,
} from 'lucide-react';
import * as React from 'react';

import { formatAddress, roomAddressOf } from '../address';
import { useHasDraft } from '../drafts';
import { formatActivityAgo, formatAtAbsolute, roomTitle, taskNumberOf, taskStatusOf, type Room } from '../model';
import { pendingAskHintOf } from '../pendingAsk';
import {
    actions,
    useIsCurrentRoom,
    useLastActivityOf,
    usePendingAskOf,
    usePendingAskTitlesOf,
    useQueuedOf,
    useBrokenOf,
    useRunningOf,
    useUnreadOf,
} from '../store';
import { isPlainLeftClick } from './link';
import { MenuButton } from './Menu';
import { EditableName, StatusGlyph } from './RoomName';

// 行尾的低频动作收进 `MenuButton`（components/Menu.tsx，与房间头 kebab 共用）：
// 以前是 hover 才浮现的三颗按钮 —— 那是「藏起来的能力」，用户 2026-11-24 明确要收进三点菜单。
// 高频的关闭 / 打开留行上常驻。

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
    // 这个容器此刻在跑几个人（全实例活动流；别的房间起停不重渲这一行）。
    // 只画在**状态图标上**（呼吸点），**不动行的底色**：底色是「当前在看哪一行」的唯一
    // 标记，两者共用一种底色时，一列里会有好几行看着都像被选中（2026-11-25 用户报
    //「选中状态错乱」）。项目行不显示：项目是导航用的壳、自己没有会话 —— 聚合子任务的
    // 运行态会让同一个状态在树上出现两次（子行自己会亮），也被读成「项目在跑」。
    const isProject = room.type === 'project';
    const running = !isProject && useRunningOf(room.id) > 0;
    /**
     * 排队中的投递（含重启后的待续跑）。**无条件调 hook**（`running` 那行的短路写法
     * 在项目/任务切换时会变 hook 数量）；项目行不显示 —— 项目自己没有会话。
     */
    const queued = useQueuedOf(room.id);
    /**
     * 未读条数（打开即算读，见 `useMarkRoomRead`）。
     *
     * 它和 `?`（等你回答）是两件事：那个是“卡在你这”，这个是“有结果了、去看看吧” ——
     * 所以用蓝点而不是天蓝的 ?，也不进标题栏那颗红点。
     */
    const unread = useUnreadOf(room.id);
    /** 上一轮出错的成员数：图标变红（与三级表格同一份事实，见 `StatusGlyph` 的 `broken`） */
    const broken = useBrokenOf(room.id);
    const [renaming, setRenaming] = React.useState(false);
    /** 任务当前是 open（行尾显「关闭」还是「打开」—— 状态只有这一个判据） */
    const openTask = !isProject && taskStatusOf(room) === 'open';
    /** 任务编号（非 task / 没编号 = undefined）。提出来是为了 narrow 后直接用 */
    const number = taskNumberOf(room);
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
                title={`${room.type}：${roomTitle(room)}${broken > 0 ? `（${broken} 个成员上一轮出错）` : ''}${running ? '（正在运行）' : ''}${queued > 0 ? `（排队 ${queued} 条）` : ''}${pendingAsk > 0 ? `（${askHint}）` : ''}${unread > 0 ? `（${unread} 条未读）` : ''}`}
                className={`relative flex w-full items-center justify-center rounded-lg py-2 ${
                    active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted/60'
                }`}
            >
                <span className="relative inline-flex shrink-0">
                    {isProject ? (
                        <Icon className="size-4 text-sky-400" />
                    ) : (
                        <StatusGlyph room={room} iconClass="size-4" running={running} broken={broken > 0} />
                    )}
                    {unread > 0 && <UnreadBadge count={unread} />}
                </span>
                {/* 排队：灰 + 转 —— 跟绿色呼吸的「在跑」分开（它不是同一件事：
                    在跑 = 已经在动；排队 = 马上要动，包括重启后的待续跑） */}
                {queued > 0 && !isProject && (
                    <span
                        title={`排队中 ${queued} 条（含重启后的待续跑）`}
                        aria-label="有投递在排队"
                        className="absolute bottom-1 left-1"
                    >
                        <Loader2 className="size-2.5 animate-spin text-zinc-400" />
                    </span>
                )}
                {hasDraft && (
                    <span
                        title="有未提交的草稿"
                        aria-label="有未提交的草稿"
                        className="absolute right-1 top-1 size-1.5 rounded-full bg-amber-400"
                    />
                )}
                {unread > 0 && (
                    <span
                        title={`${unread} 条未读`}
                        aria-label="有未读消息"
                        className="absolute left-1 top-1 size-1.5 rounded-full bg-blue-400"
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
            className={`group relative flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                // 底色只表「当前在看哪一行」。**运行态不碰底色**（2026-11-25 用户报「选中状态错乱」：
                // 两行共用 bg-accent，一列里看着都像选中）—— 运行只画在状态图标那颗呼吸点上。
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

            <span className="relative inline-flex shrink-0" title={isProject ? '项目' : undefined}>
                {isProject ? (
                    <Icon className="size-3.5 text-sky-400" />
                ) : (
                    // 只画形状，不接点击：状态切换现在有行尾那颗**显式**的关闭/打开按钮。
                    // 一颗图标既当状态又当开关，双击误触就直接把任务关了（用户报过这个隐含交互）。
                    <StatusGlyph room={room} iconClass="size-3.5" running={running} broken={broken > 0} />
                )}
                {/* 未读挂在**图标上**（用户 2026-11-26）：它属于“这个房间”，不属于某一行文字位置；
                    单独占一列会把每一行都拉宽，而它大多数时候是 0。 */}
                {unread > 0 && <UnreadBadge count={unread} />}
            </span>
            {/* 排队（与 compact 态同一颗：灰 + 转）—— 重启后待续跑的投递在这一行看得见了 */}
            {queued > 0 && !isProject && (
                <span
                    title={`排队中 ${queued} 条（含重启后的待续跑）`}
                    aria-label="有投递在排队"
                    className="shrink-0"
                >
                    <Loader2 className="size-3.5 animate-spin text-zinc-400" />
                </span>
            )}

            {/* 任务编号（#14）：紧跟在状态图标后面 —— 它是这一行除了标题之外唯一的**身份**。
                用户要认「#14 那个任务」，标题可能重名 / 被改；编号不会。 */}
            {number !== undefined && (
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">#{number}</span>
            )}

            <EditableName
                value={roomTitle(room)}
                mode="double"
                editing={renaming}
                onEditingChange={setRenaming}
                onClick={() => actions.select(room.id)}
                href={href}
                onCommit={(next) => void actions.renameRoom(room.id, next)}
            />

            {isProject && onCreateTask !== undefined && (
                <button
                    onClick={(event) => {
                        event.stopPropagation();
                        onCreateTask();
                    }}
                    title={`在「${roomTitle(room)}」下新建任务`}
                    aria-label={`在「${roomTitle(room)}」下新建任务`}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                    <ListPlus className="size-3.5" />
                </button>
            )}

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

            {/* 最后活动：紧贴行尾，这样列表里的时间是一列对齐的。
                **紧凑相对式**（用户 2026-11-26：“改回 1m / 1d 这种”）—— 绝对时刻进悬停。
                没聊过的任务显示「—」。 */}
            {!isProject && (
                <span
                    title={
                        activityAt === undefined
                            ? '会话里还没有消息（这个任务没和 agent 说过话）'
                            : `最后活动 ${formatAtAbsolute(activityAt)}`
                    }
                    className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60"
                >
                    {activityAgo ?? '—'}
                </span>
            )}

            {/* 任务行尾两个常驻按钮：关闭/打开与 ⋮；项目行的「新建任务」是行内独立按钮，
                不藏在菜单里。低频的重命名 / 删除留在菜单。 */}
            {!isProject && (
                <button
                    onClick={(event) => {
                        event.stopPropagation();
                        void actions.setRoomStatus(room.id, openTask ? 'closed' : 'open');
                    }}
                    title={openTask ? '关闭这个任务（收进历史，不再挂在项目树下）' : '重新打开这个任务'}
                    aria-label={openTask ? '关闭任务' : '打开任务'}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                    {openTask ? <CheckCircle2 className="size-3.5" /> : <RotateCcw className="size-3.5" />}
                </button>
            )}

            <MenuButton
                items={[
                    {
                        key: 'rename',
                        label: '重命名',
                        icon: <Pencil className="size-3.5" />,
                        onClick: () => setRenaming(true),
                    },
                    {
                        key: 'delete',
                        label: isProject ? '删除项目' : '删除任务',
                        icon: <Trash2 className="size-3.5" />,
                        onClick: () => onRequestDelete(room),
                        danger: true,
                    },
                ]}
            />
        </div>
    );
}

/**
 * 行组件。`memo` 在这里：父级（`App` / `Sidebar` / 三个 nav 块）重渲时，props 没变就
 * 直接跳到本行 —— 而「本行自己那一格变了」靠的是行内的单值订阅，不靠 props。
 */
export const RoomRow = React.memo(RoomRowView);

/**
 * 未读数挂在**图标**右上角的角标（用户 2026-11-26：不要单独一列）。
 *
 * 蓝底白字，与「等你回答」那颗天蓝 `?` 分开：那个是“卡在你这”，这个是“有结果了，去看看吧”。
 * 超过 99 写 `99+`（几百条时那个数字本身没有信息量）。
 */
function UnreadBadge({ count }: { count: number }) {
    return (
        <span
            title={`${count} 条未读`}
            aria-label="有未读消息"
            className="absolute -right-1.5 -top-1 inline-flex min-w-3 items-center justify-center rounded-full bg-blue-500 px-1 text-[9px] font-medium leading-3 text-white"
        >
            {count > 99 ? '99+' : count}
        </span>
    );
}
