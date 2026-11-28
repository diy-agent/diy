// nav/pinned.tsx —— 内建来源④：被 pin 的任务（侧栏最顶部的「置顶」区）。
//
// 与「历史任务」是**同一种东西的两端**：历史区放已关闭的（翻旧账），置顶区放我天天要看的那几件
// （用户 2026-11-28：像 ChatGPT 那样 pin 到最上面单独一个置顶项里）。两块都是**跨项目**的，
// 所以行上都得写项目名 —— 树里的归属在这里没有位置可依靠。
//
// 位置靠 `order` 而不是改壳：`Sidebar` 只按 order 铺来源，数字最小的在最上面（现在 projects=10）。

import { ChevronDown, ChevronRight, Pin } from 'lucide-react';
import * as React from 'react';

import { RoomRow } from '../components/RoomRow';
import { pinnedTasksOf } from '../model';
import type { NavContext, NavSource } from '../nav';
import { useRooms } from '../store';
import { projectNamesOf } from './projects';
import { Button } from '@diy-agent/ui-shadcn';

/** 置顶区展开态：默认展开（置顶的意义就是一眼看见；默认收起等于又藏起来了，同历史区） */
const PINNED_OPEN_KEY = 'entity-chat:pinned-open';

function loadPinnedOpen(): boolean {
    try {
        return localStorage.getItem(PINNED_OPEN_KEY) !== 'closed';
    } catch {
        return true;
    }
}

function PinnedBlock({ context }: { context: NavContext }) {
    // 只订阅列表：别的房间来了消息（`lastActivity` 变了）不该让这块重铺 —— 行自己订阅了。
    const rooms = useRooms();
    // `rooms` 引用稳定（只在列表真变时换），所以这份排序只在列表变化时重算
    const pinned = React.useMemo(() => pinnedTasksOf(rooms), [rooms]);
    const [pinnedOpen, setPinnedOpen] = React.useState(loadPinnedOpen);
    const togglePinned = React.useCallback(() => {
        setPinnedOpen((current) => {
            const next = !current;
            try {
                localStorage.setItem(PINNED_OPEN_KEY, next ? 'open' : 'closed');
            } catch {
                /* 存储不可用：本次运行仍然生效 */
            }
            return next;
        });
    }, []);

    // 没有 pin 就整块不渲染（与历史区一致）：空分组头只会让人以为「这里坏了」
    if (pinned.length === 0) return null;
    const { open, host } = context;

    // 收起态（rail 56px）：pin 过的东西正是「切得快」的那几个，这里**不折叠**，
    // 直接铺图标行 —— 这也是 pin 最实际的用处。底部一条 border 把它与项目树分开。
    if (!open) {
        return (
            <div className="mb-1 border-b pb-1" data-sidebar-pinned>
                {pinned.map((task) => (
                    <RoomRow key={task.id} room={task} compact onRequestDelete={host.onRequestDelete} />
                ))}
            </div>
        );
    }

    const projectNames = projectNamesOf(rooms);

    return (
        <div className="mb-2 border-b pb-2" data-sidebar-pinned>
            <Button
                variant="ghost"
                size="xs"
                onClick={togglePinned}
                title={pinnedOpen ? '收起置顶' : `展开置顶（${pinned.length}）`}
                aria-expanded={pinnedOpen}
                className="h-auto w-full justify-start gap-2 px-2 py-1 text-xs tracking-wide text-muted-foreground"
            >
                {pinnedOpen ? (
                    <ChevronDown className="size-3 shrink-0" />
                ) : (
                    <ChevronRight className="size-3 shrink-0" />
                )}
                <Pin className="size-3.5 shrink-0" />
                置顶
                <span className="ml-auto rounded-full border px-1.5 text-[10px] tabular-nums">{pinned.length}</span>
            </Button>
            {pinnedOpen && (
                <div className="mt-0.5">
                    {pinned.map((task) => {
                        const projectId = task.data['projectId'];
                        return (
                            <RoomRow
                                key={task.id}
                                room={task}
                                compact={false}
                                // 任务从项目树挪到了这里（去重），归属只能写在行上
                                tag={typeof projectId === 'string' ? projectNames.get(projectId) : undefined}
                                onRequestDelete={host.onRequestDelete}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
}

export const pinnedSource: NavSource = {
    id: 'core:pinned',
    order: 5,
    render: (context) => <PinnedBlock context={context} />,
};
