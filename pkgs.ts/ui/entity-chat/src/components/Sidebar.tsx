import {
    Archive,
    ChevronDown,
    ChevronRight,
    Folder,
    ListPlus,
    PanelLeftClose,
    PanelLeftOpen,
    Pencil,
    PenLine,
    Plus,
    Settings,
    Trash2,
} from 'lucide-react';
import * as React from 'react';

import { useHasDraft } from '../drafts';
import { closedAtOf, closedTasksOf, formatClosedAgo, formatClosedAtAbsolute, visibleInTree, type Room } from '../model';
import { actions, useStore } from '../store';
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

/**
 * 历史任务（已关闭）的一行：状态图标 + 名字 + 所属项目 tag。
 *
 * 为什么要有项目 tag：这张表是**跨项目**的（历史任务不挂在某个项目下面，否则
 * 每个项目都得为了“翻旧账”多长一截，而项目树本身是用来干活的）。跨项目列表里
 * 两个项目下都叫「修个 bug」的任务光看名字分不清，所以项目名必须在行上。
 *
 * 状态图标可点 —— 点它就是「重新打开」，任务会回到它所属项目的树里。
 *
 * 行尾是关闭时间：用**相对**说法（「3 小时前」），绝对时刻放悬停。侧栏宽 256px，
 * 名字 + 项目 tag 已经把一行占满，`2026-11-17 06:14` 会把名字挤成省略号。
 */
function HistoryRow({ room, projectName, active }: { room: Room; projectName?: string; active: boolean }) {
    const closedAt = closedAtOf(room);
    const ago = formatClosedAgo(closedAt);
    return (
        <div
            className={`group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted/60'
            }`}
        >
            <StatusIcon room={room} />
            <button
                onClick={() => actions.select(room.id)}
                title={`${projectName === undefined ? '' : `${projectName} / `}${room.name}（点状态图标可重新打开）`}
                className="min-w-0 flex-1 truncate text-left"
            >
                {room.name}
            </button>
            {projectName !== undefined && (
                <span
                    title={`项目：${projectName}`}
                    className="max-w-[45%] shrink-0 truncate rounded border px-1.5 text-[10px] text-muted-foreground/80"
                >
                    {projectName}
                </span>
            )}
            {ago !== undefined && (
                <span
                    title={`关闭于 ${formatClosedAtAbsolute(closedAt)}`}
                    className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70"
                >
                    {ago}
                </span>
            )}
        </div>
    );
}

function RoomRow({
    room,
    active,
    compact,
    collapsed = false,
    openTaskCount,
    onToggleCollapse,
    onCreateTask,
    onRequestDelete,
}: {
    room: Room;
    active: boolean;
    compact: boolean;
    /** 项目行：任务列表是否收起（只有项目有）；收起时行尾显示未关闭任务数 */
    collapsed?: boolean;
    openTaskCount?: number;
    onToggleCollapse?: () => void;
    onCreateTask?: () => void;
    onRequestDelete: (room: Room) => void;
}) {
    const hasDraft = useHasDraft(room.id);
    const [renaming, setRenaming] = React.useState(false);
    const isProject = room.type === 'project';
    const Icon = Folder;

    // 收起态（rail 56px）：**只留一个图标**。任务 = 状态图标（形状即状态，GitHub 读法），
    // 项目 = 文件夹。行本身是 button，所以状态只能画成无交互的形状（StatusGlyph）——
    // 里面再嵌一个能点的 button 就是非法嵌套。
    if (compact) {
        return (
            <button
                onClick={() => actions.select(room.id)}
                title={`${room.type}：${room.name}`}
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
            </button>
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
                value={room.name}
                mode="double"
                editing={renaming}
                onEditingChange={setRenaming}
                onClick={() => actions.select(room.id)}
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

// ── 侧栏宽度（用户：项目导航和聊天之间要能拖）───────────────────────────────
//
// 收起态（rail 56px）没有“可调的宽度”这回事 —— 那是一个图标列的固定尺寸，
// 手柄只在展开态渲染，否则拖了也看不见变化。
const SIDEBAR_W_KEY = 'entity-chat:sidebar-width';
const SIDEBAR_W_DEFAULT = 256;
const SIDEBAR_W_MIN = 200;
const SIDEBAR_W_MAX = 520;
/** 收起态宽度（rail）—— 一个图标 + 内边距，不参与拖拽 */
const SIDEBAR_RAIL_W = 56;

// ── 项目折叠（用户：项目要能折叠）────────────────────────────────
//
// 只存「收起了哪些」（而不是「展开了哪些」）：新项目默认展开才符合预期，
// 而且这份名单会自愈 —— 项目删了只是多一个用不到的 id，不用清理。
const COLLAPSED_KEY = 'entity-chat:collapsed-projects';

/** 历史任务区展开状态：默认展开（用户要的是“方便回头看”，默认收起等于又藏起来了） */
const HISTORY_OPEN_KEY = 'entity-chat:history-open';

function loadHistoryOpen(): boolean {
    try {
        return localStorage.getItem(HISTORY_OPEN_KEY) !== 'closed';
    } catch {
        return true;
    }
}

function loadCollapsed(): ReadonlySet<string> {
    try {
        const raw: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
        if (!Array.isArray(raw)) return new Set();
        return new Set(raw.filter((item): item is string => typeof item === 'string'));
    } catch {
        return new Set();
    }
}

function clampWidth(px: number): number {
    if (!Number.isFinite(px)) return SIDEBAR_W_DEFAULT;
    return Math.min(SIDEBAR_W_MAX, Math.max(SIDEBAR_W_MIN, Math.round(px)));
}

/** 存过的宽度（脏数据/超范围一律夹回合法区间 —— 一个坏值不该让侧栏把聊天挤没） */
function loadWidth(): number {
    try {
        const raw = Number(localStorage.getItem(SIDEBAR_W_KEY));
        return raw > 0 ? clampWidth(raw) : SIDEBAR_W_DEFAULT;
    } catch {
        return SIDEBAR_W_DEFAULT;
    }
}

export function Sidebar({
    open,
    onToggle,
    onCreateProject,
    onCreateTask,
    onRequestDelete,
    onOpenSettings,
}: {
    open: boolean;
    onToggle: () => void;
    onCreateProject: () => void;
    onCreateTask: (projectId: string) => void;
    onRequestDelete: (room: Room) => void;
    onOpenSettings: () => void;
}) {
    const state = useStore();
    const projects = state.rooms.filter((room) => room.type === 'project');
    const projectIds = new Set(projects.map((project) => project.id));
    // 非项目、且没有挂在任何已存在的项目下 → "未归属"（老数据 / projectId 丢了的任务）
    // 已关闭的一律不进树：它们去底部的「历史任务」区（用户：closed 的从项目树隐藏掉）
    const orphans = state.rooms.filter(
        (room) =>
            room.type !== 'project' &&
            visibleInTree(room) &&
            !projectIds.has(String(room.data['projectId'] ?? '')),
    );
    const closedTasks = closedTasksOf(state.rooms);

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

    const [width, setWidth] = React.useState(loadWidth);
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
    // 项目 id → 名字：历史任务是跨项目的（不挂在任何项目下），行上得自己写清楚属于哪个项目
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));
    /** 拖拽中：宽度跟着指针实时变，这时必须**摘掉 width 过渡**，否则宽度在鼠标后面追 */
    const [resizing, setResizing] = React.useState(false);
    const asideRef = React.useRef<HTMLElement | null>(null);
    /** 拖拽结束时落盘（拖的途中每帧都写 localStorage 是白费） */
    const persistWidth = React.useCallback((px: number) => {
        try {
            localStorage.setItem(SIDEBAR_W_KEY, String(px));
        } catch {
            /* 存储不可用：本次运行仍然生效，只是重启回到默认 */
        }
    }, []);

    const onGripDown = React.useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            if (!open) return;
            event.preventDefault();
            const left = asideRef.current?.getBoundingClientRect().left ?? 0;
            // 指针捕获：拖到聊天区上、拖出窗口也不会丢 move 事件（拖选框不跟着断）
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizing(true);
            let latest = width;
            const onMove = (ev: PointerEvent) => {
                latest = clampWidth(ev.clientX - left);
                setWidth(latest);
                // 拖拽时把 select 禁掉，否则指针经过行文字会顺手选一大片
                document.body.style.userSelect = 'none';
            };
            const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
                document.body.style.userSelect = '';
                setResizing(false);
                persistWidth(latest);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);
        },
        [open, width, persistWidth],
    );

    return (
        <aside
            ref={asideRef}
            // `relative` 是给右缘手柄的定位锚（absolute inset-y-0 right-0）：
            // 手柄盖在 border 上，视觉上就是「这条线能拖」。
            className={`relative flex shrink-0 flex-col overflow-hidden border-r ${resizing ? '' : 'transition-[width] duration-200'}`}
            style={{ width: open ? width : SIDEBAR_RAIL_W }}
            data-sidebar-width={open ? width : SIDEBAR_RAIL_W}
        >
            <div className={`flex items-center border-b py-3 ${open ? 'gap-2 px-3' : 'justify-center px-1'}`}>
                {open && (
                    <>
                        <span className="text-sm font-semibold">diy</span>
                        <span className="text-xs text-muted-foreground">容器对话</span>
                    </>
                )}
                <button
                    onClick={onToggle}
                    title={open ? '收起侧栏（⌘B）' : '展开侧栏（⌘B）'}
                    className={`rounded p-1 text-muted-foreground hover:bg-muted ${open ? 'ml-auto' : ''}`}
                >
                    {open ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                {open && (
                    <div className="mb-1 flex items-center justify-between px-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                        项目
                        <button
                            onClick={onCreateProject}
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

                {projects.map((project) => {
                    // 树里只留未关闭的任务（用户：closed 的藏起来 —— closedTasksOf 才是它们的去处）
                    const tasks = state.rooms.filter(
                        (room) => room.data['projectId'] === project.id && visibleInTree(room),
                    );
                    const isCollapsed = collapsed.has(project.id);
                    // 收起态（rail）不折叠：那里是图标快切栏，藏起子项只会让人找不到
                    const shownTasks = open && isCollapsed ? [] : tasks;
                    return (
                        <div key={project.id} className={open ? 'mb-2' : 'mb-1'}>
                            <RoomRow
                                room={project}
                                active={state.selectedId === project.id}
                                compact={!open}
                                collapsed={open && isCollapsed}
                                openTaskCount={tasks.length}
                                onToggleCollapse={open ? () => toggleCollapsed(project.id) : undefined}
                                onCreateTask={() => onCreateTask(project.id)}
                                onRequestDelete={onRequestDelete}
                            />
                            {shownTasks.map((task) => (
                                <div key={task.id} className={open ? 'ml-4' : ''}>
                                    <RoomRow
                                        room={task}
                                        active={state.selectedId === task.id}
                                        compact={!open}
                                        onRequestDelete={onRequestDelete}
                                    />
                                </div>
                            ))}
                            {open && !isCollapsed && tasks.length === 0 && (
                                <button
                                    onClick={() => onCreateTask(project.id)}
                                    className="ml-6 mt-0.5 flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                                >
                                    <ListPlus className="size-3" />
                                    新建任务
                                </button>
                            )}
                        </div>
                    );
                })}

                {/* 历史任务：已关闭的任务从项目树里收起（用户：closed 的藏起来），但“看不见”不等于“没了”
                    —— 它们就在这里，按关闭时间倒序，行上带项目 tag。
                    之前这批任务只能从侧栏底部弹一张表才能看到（一个看不出藏着东西的门），
                    现在它们和项目树是同一个列表读法：就在导航里。 */}
                {closedTasks.length > 0 && (
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
                                onClick={onToggle}
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
                                            projectName={
                                                typeof projectId === 'string' ? projectNames.get(projectId) : undefined
                                            }
                                            active={state.selectedId === task.id}
                                        />
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}

                {/* 没挂到任何项目下的容器（老数据丢过 projectId / 以后别的类型）也要能点开 ——
                    按 projectId 分组的写法会让它们直接消失，数据还在却永远进不去 */}
                {orphans.length > 0 && (
                    <div className={open ? 'mb-2' : 'mb-1'}>
                        {open && <div className="px-2 pb-1 text-[11px] text-muted-foreground">未归属</div>}
                        {orphans.map((room) => (
                            <RoomRow
                                key={room.id}
                                room={room}
                                active={state.selectedId === room.id}
                                compact={!open}
                                onRequestDelete={onRequestDelete}
                            />
                        ))}
                    </div>
                )}
            </div>

            <div className={`flex items-center border-t py-2 ${open ? 'justify-between px-3' : 'justify-center'}`}>
                {open && (
                    <span className="text-[11px] leading-relaxed text-muted-foreground">
                        容器 = 一条对话；成员在容器内
                    </span>
                )}
                <button
                    onClick={onOpenSettings}
                    title="模型设置"
                    className="rounded p-1 text-muted-foreground hover:bg-muted"
                >
                    <Settings className="size-4" />
                </button>
            </div>

            {/* 右缘拖拽手柄（就这样写，不抽组件）：让它在视觉上**盖住那条 border** ——
                「这条线能拖」比在旁边加一个可拖的小块更直接。双击复位到默认宽。
                收起态不渲染：那是一个图标列的固定尺寸，拖了也看不见变化。 */}
            {open && (
                <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="拖动调整侧栏宽度（双击复位）"
                    title="拖动调整侧栏宽度（双击复位）"
                    data-sidebar-grip
                    onPointerDown={onGripDown}
                    onDoubleClick={() => {
                        setWidth(SIDEBAR_W_DEFAULT);
                        persistWidth(SIDEBAR_W_DEFAULT);
                    }}
                    className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-foreground/10 active:bg-foreground/20"
                />
            )}
        </aside>
    );
}
