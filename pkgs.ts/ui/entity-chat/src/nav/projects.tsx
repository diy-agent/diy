// nav/projects.tsx —— 内建来源①：项目树（项目 → 它下面未关闭的任务）。
//
// 三块内建来源都长这样：导出一个 `NavSource`，注册在 `nav/index.ts`。它们和将来插件
// 贡献的来源**没有任何区别**（同一个 render 契约），所以这条路一直被走着 —— 插件那条
// 路才不会在某个改动里悄悄烂掉。

import { ListPlus, Plus } from 'lucide-react';
import * as React from 'react';

import { RoomRow } from '../components/RoomRow';
import { roomTitle, visibleInTree, type Room } from '../model';
import type { NavContext, NavSource } from '../nav';
import { useRooms } from '../store';

// 只存「收起了哪些」（而不是「展开了哪些」）：新项目默认展开才符合预期，
// 而且这份名单会自愈 —— 项目删了只是多一个用不到的 id，不用清理。
const COLLAPSED_KEY = 'entity-chat:collapsed-projects';

function loadCollapsed(): ReadonlySet<string> {
    try {
        const raw: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
        if (!Array.isArray(raw)) return new Set();
        return new Set(raw.filter((item): item is string => typeof item === 'string'));
    } catch {
        return new Set();
    }
}

function ProjectsBlock({ context }: { context: NavContext }) {
    // 只订阅列表：别的房间来了一条消息（`lastActivity` 变了）时这个引用不变，
    // 块本身不重渲 —— 那一行的「最后活动」由行自己订阅。
    const rooms = useRooms();
    const { open, host } = context;
    const projects = rooms.filter((room) => room.type === 'project');

    const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(loadCollapsed);
    const toggleCollapsed = React.useCallback((id: string) => {
        setCollapsed((current) => {
            const next = new Set(current);
            if (!next.delete(id)) next.add(id);
            try {
                localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
            } catch {
                /* 存储不可用：本次运行仍然生效 */
            }
            return next;
        });
    }, []);

    return (
        <>
            {open && (
                <div className="mb-1 flex items-center justify-between px-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                    项目
                    <button
                        onClick={host.onCreateProject}
                        title="从本机目录新建项目"
                        className="rounded p-0.5 hover:bg-muted"
                    >
                        <Plus className="size-3.5" />
                    </button>
                </div>
            )}

            {open && projects.length === 0 && (
                <p className="mx-2 rounded-lg border border-dashed px-2 py-2 text-[11px] leading-relaxed text-muted-foreground">
                    还没有项目。点上面的 <Plus className="inline size-3" /> 从本机目录建一个。
                </p>
            )}

            {projects.map((project) => (
                // 每个项目一行组件：它自己算子任务、自己包回调。
                // 不这样做的话，下面那三个 `() => …` 每次块重渲都是新函数 —— 行上的
                // `React.memo` 因此永远视为 props 变了，一道都拦不住。
                <ProjectRow
                    key={project.id}
                    project={project}
                    rooms={rooms}
                    compact={!open}
                    collapsed={open && collapsed.has(project.id)}
                    onToggleCollapse={toggleCollapsed}
                    onCreateTask={host.onCreateTask}
                    onRequestDelete={host.onRequestDelete}
                />
            ))}
        </>
    );
}

/**
 * 一个项目（包含它下面未关闭的任务）。
 *
 * `rooms` 整份传进来而不是传算好的 `tasks`：每次渲染新 filter 出来的数组会是一个
 * 新引用，`memo` 就失效了。这里 props 只跟「列表变了 / 展开态变了 / 回调变了」走。
 */
const ProjectRow = React.memo(function ProjectRow({
    project,
    rooms,
    compact,
    collapsed,
    onToggleCollapse,
    onCreateTask,
    onRequestDelete,
}: {
    project: Room;
    rooms: Room[];
    compact: boolean;
    /** 展开态下的「任务列表收起」（rail 不折叠，此时恒 false） */
    collapsed: boolean;
    onToggleCollapse: (projectId: string) => void;
    onCreateTask: (projectId: string) => void;
    onRequestDelete: (room: Room) => void;
}) {
    const { id } = project;
    // 树里只留未关闭的任务（用户：closed 的藏起来 —— 历史任务区才是它们的去处）
    const tasks = rooms.filter((room) => room.data['projectId'] === id && visibleInTree(room));
    // 行上的回调要 stable：`RoomRow` 是 `memo` 的，props 每轮都新的话等于没包
    const toggle = React.useCallback(() => onToggleCollapse(id), [onToggleCollapse, id]);
    const create = React.useCallback(() => onCreateTask(id), [onCreateTask, id]);
    // 收起态（rail）不折叠：那里是图标快切栏，藏起子项只会让人找不到
    const shownTasks = compact ? tasks : collapsed ? [] : tasks;
    return (
        <div className={compact ? 'mb-1' : 'mb-2'}>
            <RoomRow
                room={project}
                compact={compact}
                collapsed={!compact && collapsed}
                openTaskCount={tasks.length}
                onToggleCollapse={compact ? undefined : toggle}
                onCreateTask={create}
                onRequestDelete={onRequestDelete}
            />
            {shownTasks.map((task) => (
                <div key={task.id} className={compact ? '' : 'ml-4'}>
                    <RoomRow room={task} compact={compact} onRequestDelete={onRequestDelete} />
                </div>
            ))}
            {!compact && !collapsed && tasks.length === 0 && (
                <button
                    onClick={create}
                    className="ml-6 mt-0.5 flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                >
                    <ListPlus className="size-3" />
                    新建任务
                </button>
            )}
        </div>
    );
});

export const projectsSource: NavSource = {
    id: 'core:projects',
    order: 10,
    render: (context) => <ProjectsBlock context={context} />,
};

/** 项目 id → 名字：历史任务是跨项目的（不挂在任何项目下），行上得自己写清楚属于哪个项目 */
export function projectNamesOf(rooms: Room[]): Map<string, string> {
    return new Map(rooms.filter((room) => room.type === 'project').map((project) => [project.id, roomTitle(project)]));
}
