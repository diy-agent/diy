// nav/history.tsx —— 内建来源②：已关闭的任务（跨项目的「回头看看」区）。

import { Archive, ChevronDown, ChevronRight } from 'lucide-react';
import * as React from 'react';

import { formatAddress, roomAddressOf } from '../address';
import { isPlainLeftClick } from '../components/link';
import { StatusIcon } from '../components/RoomName';
import {
    closedAtOf,
    closedTasksOf,
    formatClosedAgo,
    formatClosedAtAbsolute,
    formatCompactAgo,
    type Room,
} from '../model';
import type { NavContext, NavSource } from '../nav';
import { actions, isCurrentRoom, useStore } from '../store';
import { projectNamesOf } from './projects';

/** 历史任务区展开状态：默认展开（用户要的是“方便回头看”，默认收起等于又藏起来了） */
const HISTORY_OPEN_KEY = 'entity-chat:history-open';

function loadHistoryOpen(): boolean {
    try {
        return localStorage.getItem(HISTORY_OPEN_KEY) !== 'closed';
    } catch {
        return true;
    }
}

/**
 * 历史任务（已关闭）的一行：状态图标 + 名字 + 所属项目 tag。
 *
 * 为什么要有项目 tag：这张表是**跨项目**的（历史任务不挂在某个项目下面，否则
 * 每个项目都得为了“翻旧账”多长一截，而项目树本身是用来干活的）。跨项目列表里
 * 两个项目下都叫「修个 bug」的任务光看名字分不清，所以项目名必须在行上。
 *
 * 状态图标可点 —— 点它就是「重新打开」，任务会回到它所属项目的树里。
 *
 * 行尾是**关闭时刻**，不是最后活动：这张表按 `closedAt` 倒序（`closedTasksOf`），
 * 显示别的字段会让列表的时间不单调（3h、2d、5h…），看着像没排序。最后活动放悬停 ——
 * 「关了之后又说过话」是个值得知道的例外，但它不该占这一列。
 */
function HistoryRow({ room, projectName }: { room: Room; projectName?: string }) {
    const address = useStore().address;
    const active = isCurrentRoom(address, room);
    const closedAt = closedAtOf(room);
    const activityAt = useStore().lastActivity[room.id];
    const closedAgo = formatCompactAgo(closedAt);
    const detail: string[] = [];
    if (closedAt !== undefined) {
        const absolute = formatClosedAtAbsolute(closedAt);
        const ago = formatClosedAgo(closedAt);
        detail.push(`关闭于 ${absolute ?? ''}${ago === undefined ? '' : `（${ago}）`}`);
    }
    if (activityAt !== undefined) detail.push(`最后活动 ${formatCompactAgo(activityAt)}`);
    return (
        <div
            className={`group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted/60'
            }`}
        >
            <StatusIcon room={room} />
            <a
                href={formatAddress(roomAddressOf(room))}
                onClick={(event) => {
                    if (!isPlainLeftClick(event)) return;
                    event.preventDefault();
                    actions.select(room.id);
                }}
                title={`${projectName === undefined ? '' : `${projectName} / `}${room.name}（点状态图标可重新打开）`}
                className="min-w-0 flex-1 truncate text-left"
            >
                {room.name}
            </a>
            {projectName !== undefined && (
                <span
                    title={`项目：${projectName}`}
                    className="max-w-[45%] shrink-0 truncate rounded border px-1.5 text-[10px] text-muted-foreground/80"
                >
                    {projectName}
                </span>
            )}
            {/* 只有一个时间单元（256px 侧栏里名字 + 项目 tag 已经占满一行）：
                显示关闭时刻（= 排序键），其余细节进悬停。没有 closedAt 的老数据是「—」。 */}
            <span
                title={detail.length === 0 ? '没有关闭时刻（老数据）' : detail.join('\n')}
                className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70"
            >
                {closedAgo ?? '—'}
            </span>
        </div>
    );
}

function HistoryBlock({ context }: { context: NavContext }) {
    const state = useStore();
    const [historyOpen, setHistoryOpen] = React.useState(loadHistoryOpen);
    const toggleHistory = React.useCallback(() => {
        setHistoryOpen((current) => {
            const next = !current;
            try {
                localStorage.setItem(HISTORY_OPEN_KEY, next ? 'open' : 'closed');
            } catch {
                /* 存储不可用：本次运行仍然生效 */
            }
            return next;
        });
    }, []);

    const closedTasks = closedTasksOf(state.rooms);
    if (closedTasks.length === 0) return null;
    const { open } = context;
    const projectNames = projectNamesOf(state.rooms);

    return (
        // 历史任务：已关闭的任务从项目树里收起（用户：closed 的藏起来），但“看不见”不等于“没了”
        // —— 它们就在这里，按关闭时间倒序，行上带项目 tag。
        <div className={open ? 'mt-1 border-t pt-2' : 'mt-1'} data-sidebar-history>
            {open ? (
                <button
                    onClick={toggleHistory}
                    title={historyOpen ? '收起历史任务' : `展开历史任务（${closedTasks.length}）`}
                    aria-expanded={historyOpen}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground hover:bg-muted/60"
                >
                    {historyOpen ? (
                        <ChevronDown className="size-3 shrink-0" />
                    ) : (
                        <ChevronRight className="size-3 shrink-0" />
                    )}
                    <Archive className="size-3.5 shrink-0" />
                    历史任务
                    <span className="ml-auto rounded-full border px-1.5 text-[10px] tabular-nums">
                        {closedTasks.length}
                    </span>
                </button>
            ) : (
                <button
                    onClick={context.host.onExpandSidebar}
                    title={`历史任务（${closedTasks.length}）—— 点开展开侧栏`}
                    aria-label={`历史任务（${closedTasks.length}）`}
                    className="flex w-full items-center justify-center rounded-lg py-2 text-muted-foreground hover:bg-muted/60"
                >
                    <Archive className="size-4" />
                </button>
            )}
            {open && historyOpen && (
                <div className="mt-0.5 max-h-72 overflow-y-auto">
                    {closedTasks.map((task) => {
                        const projectId = task.data['projectId'];
                        return (
                            <HistoryRow
                                key={task.id}
                                room={task}
                                projectName={typeof projectId === 'string' ? projectNames.get(projectId) : undefined}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
}

export const historySource: NavSource = {
    id: 'core:history',
    order: 20,
    render: (context) => <HistoryBlock context={context} />,
};
