import { Bot as BotIcon, Folder, ListTodo, PanelRight, Plus } from 'lucide-react';
import * as React from 'react';

import { SURFACES } from './surfaces/registry';
import { EditableName, StatusChip } from './components/RoomName';
import { SpeakingBar } from './components/SpeakingBar';
import { PendingAskStrip } from './components/PendingAskStrip';
import { ComposerBar } from './components/ComposerBar';
import { TaskPanel } from './components/TaskPanel';
import { Sidebar } from './components/Sidebar';
import { botsOf, dirOf, primaryBotOf, roomTitle, roomTypeLabel, type Room } from './model';
import {
    actions,
    useBots,
    useDefaultModelKey,
    useError,
    useLoaded,
    useRooms,
    useSelectedRoom,
} from './store';
import { useRoomDialogs } from './useRoomDialogs';

function roomDir(room: Room): string | undefined {
    const dir = room.data['dir'];
    return typeof dir === 'string' && dir !== '' ? dir : undefined;
}

/**
 * 头部。`memo` 的意义：`App` 因为「侧栏一行的高亮变了」这类原因重渲时，它不该跟着
 * 整块重画（里面还有成员胶囊、上下文面板）。
 */
const RoomHeader = React.memo(function RoomHeader({
    room,
    onAddMember,
    taskPanelOpen,
    taskPanelShown,
    onToggleTaskPanel,
}: {
    room: Room;
    onAddMember: () => void;
    taskPanelOpen: boolean;
    /** 宿主是否接管了右侧面板（接管后这个按钮不归本层画 —— 点了也没有本层面板可开） */
    taskPanelShown: boolean;
    onToggleTaskPanel: () => void;
}) {
    // 两个窄订阅：bot 表、房间列表（后者只用来把项目的 dir 继承下来）
    const botMap = useBots();
    const rooms = useRooms();
    const bots = botsOf(room, botMap);
    const primary = primaryBotOf(room, botMap);
    const others = bots.filter((bot) => bot.id !== primary?.id);
    const isProject = room.type === 'project';
    const Icon = isProject ? Folder : ListTodo;

    return (
        <header className="border-b px-5 py-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    <Icon className={`size-3 ${isProject ? 'text-sky-400' : 'text-emerald-400'}`} />
                    {roomTypeLabel(room.type)}
                </span>
                <EditableName
                    value={roomTitle(room)}
                    mode="click"
                    // 头部大标题：点了就改。侧栏收起来时这是唯一能看见名字的地方
                    onCommit={(next) => void actions.renameRoom(room.id, next)}
                    className="max-w-[22rem] truncate rounded px-1 text-left text-sm font-semibold hover:bg-muted/60"
                    inputClassName="w-56 rounded border bg-background px-1 text-sm font-semibold outline-none"
                />
                <StatusChip room={room} />
                {roomDir(room) !== undefined && (
                    <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                        <Folder className="size-3" />
                        {dirOf(room, rooms)}
                    </span>
                )}
                <span className="ml-auto flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">成员</span>
                    {primary !== undefined && (
                        <span className="flex items-center gap-1 rounded-full border px-2 py-0.5">
                            <span className="size-2 rounded-full" style={{ background: primary.color }} />
                            {primary.name}
                            <span className="text-[10px] text-muted-foreground">默认应答</span>
                        </span>
                    )}
                    {others.map((bot) => (
                        <span
                            key={bot.id}
                            className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-muted-foreground"
                        >
                            <span className="size-2 rounded-full" style={{ background: bot.color }} />
                            {bot.name}
                        </span>
                    ))}
                    <button
                        onClick={onAddMember}
                        className="flex items-center gap-1 rounded-full border px-2 py-0.5 hover:bg-muted"
                    >
                        <Plus className="size-3" />
                        成员
                    </button>
                    {taskPanelShown && room.type === 'task' && (
                        <button
                            onClick={onToggleTaskPanel}
                            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 hover:bg-muted ${
                                taskPanelOpen ? 'bg-muted' : ''
                            }`}
                        >
                            <PanelRight className="size-3" />
                            任务
                        </button>
                    )}
                </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>
                    {bots.length <= 1
                        ? '只有默认应答，没有 @ 时它自己回'
                        : `${bots.length} 个成员：@名字叫谁谁回，@all 全回（等于开会，token 按人数涨）`}
                </span>
            </div>
        </header>
    );
});

/**
 * 宿主可裁掉哪些「外壳」。默认全开 = 原来的整页形态。
 *
 * `sidebar: false` —— 宿主管导航（工作台把「有哪些房间」画在自己的左栏里，
 *   再让这一层画一遍就是两条侧栏，还各带一套宽度拖拽）；裁掉的是**壳**，
 *   不是能力：房间切换、新建、设置这些仍然由宿主通过 store 的钩子做。
 * `taskPanel: false` —— 宿主管右侧区域（把任务面板放进 dock 的 right area，
 *   尺寸/收起就是布局的一部分，不该在 view 内部再长一个自绘面板）。
 */
export function App({ sidebar = true, taskPanel = true }: { sidebar?: boolean; taskPanel?: boolean } = {}) {
    // 四个窄订阅。这层以前是 `useStore()`（整份快照），于是**每一条** `emit` ——
    // 别的房间来了消息、某个房间多了个待答提问、侧栏换了个高亮 —— 都会把整个 App
    // 连同侧栏、三个 nav 块一起重渲一遍。
    //
    // `useSelectedRoom` 的快照是 `rooms` 数组里的那个元素：rename / 改状态时会换新对象
    // （`refresh` 整份换新），所以「侧栏已改名、头部不动」那个老毛病不会因为去掉整份
    // 快照而回来。
    const loaded = useLoaded();
    const error = useError();
    const room = useSelectedRoom();
    // 弹窗（新建项目 / 建任务 / 加成员 / 设置 / 删房间 / 换模型）整体在 useRoomDialogs 里：
    // 工作台要用同一套，状态不能长在这一层。
    const dialogs = useRoomDialogs();
    // 默认表面：Astryx（虚拟化 + 自带代码高亮，长会话最稳）
    const [surfaceId, setSurfaceId] = React.useState<string>(
        SURFACES.find((surface) => surface.id === 'astryx')?.id ?? SURFACES[0]!.id,
    );

    React.useEffect(() => {
        actions.bootstrap();
    }, []);

    const [sidebarOpen, setSidebarOpen] = React.useState<boolean>(() => {
        try {
            return localStorage.getItem('entity-chat:sidebar') !== 'closed';
        } catch {
            return true;
        }
    });
    /** 右侧「任务」面板（描述 / 正文）：只有 task 房间能开 */
    const [taskPanelOpen, setTaskPanelOpen] = React.useState(false);
    // 传给侧栏的回调必须 stable：`Sidebar` 把它们放进 `useMemo` 的 host，再传给每一行；
    // 每次渲染新建一个函数，行上的 `React.memo` 就永远拦不住（props 比不等）。
    // useRoomDialogs 返回的动作本身已经是 useCallback，直接透传即可。
    const { openProject, openTask, requestDelete, openSettings, openMember, openModel } = dialogs;
    const onCreateProject = openProject;
    const onCreateTask = openTask;
    const onRequestDelete = requestDelete;
    const onOpenSettings = openSettings;
    const onAddMember = openMember;
    const onToggleTaskPanel = React.useCallback(() => setTaskPanelOpen((open) => !open), []);
    const onCloseTaskPanel = React.useCallback(() => setTaskPanelOpen(false), []);
    const roomId = room?.id;
    const onPickModel = React.useCallback(() => {
        if (roomId !== undefined) openModel(roomId);
    }, [roomId, openModel]);

    /**
     * 输入框底栏那一行。**必须 memo**：它是 `SurfaceHost` 的 prop，而 `SurfaceHost` 是
     * `React.memo` 的（切 tab 只有 `visible` 该变）—— 每次 App 重渲都新建一个元素，
     * 那个 memo 就白写了，隐藏着的表面会跟着整块重画。
     */
    const composerExtras = React.useMemo(
        () => (room === undefined ? undefined : <ComposerBar room={room} onPickModel={onPickModel} />),
        [room, onPickModel],
    );

    const toggleSidebar = React.useCallback(() => {
        setSidebarOpen((open) => {
            try {
                localStorage.setItem('entity-chat:sidebar', open ? 'closed' : 'open');
            } catch {
                /* 忽略 */
            }
            return !open;
        });
    }, []);

    React.useEffect(() => {
        // 侧栏不归这一层管时，⌘B 也不该由它接管：宿主自己的收起快捷键会在 window 上撞车
        if (!sidebar) return;
        const onKey = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
                event.preventDefault();
                toggleSidebar();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [sidebar, toggleSidebar]);

    return (
        <div className="flex h-full">
            {sidebar && (
                <Sidebar
                    open={sidebarOpen}
                    onToggle={toggleSidebar}
                    onCreateProject={onCreateProject}
                    onCreateTask={onCreateTask}
                    onRequestDelete={onRequestDelete}
                    onOpenSettings={onOpenSettings}
                />
            )}

            <main className="relative flex min-w-0 flex-1">
                <div className="flex min-w-0 flex-1 flex-col">
                    {!loaded ? (
                        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                            <span className="flex items-center gap-2">
                                <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                                连接 diy2 后端…
                            </span>
                            {error !== undefined && (
                                <span className="text-[11px] text-destructive">上次失败：{error}（正在重试）</span>
                            )}
                        </div>
                    ) : room === undefined ? (
                        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                            左侧选择一个容器
                        </div>
                    ) : (
                        <>
                            <RoomHeader
                                room={room}
                                onAddMember={onAddMember}
                                taskPanelOpen={taskPanelOpen}
                                taskPanelShown={taskPanel}
                                onToggleTaskPanel={onToggleTaskPanel}
                            />
                            <SurfaceTabs value={surfaceId} onChange={setSurfaceId} />
                            <SpeakingBar roomId={room.id} />
                            {/* 待答条在壳层：房间的事实，三个表面共用（跳转按 surfaceId 找各自的 jumper） */}
                            <PendingAskStrip roomId={room.id} surfaceId={surfaceId} />
                            <SurfaceViews
                                surfaceId={surfaceId}
                                targetId={room.id}
                                composerExtras={composerExtras}
                            />
                        </>
                    )}
                    {loaded && error !== undefined && (
                        <div className="border-t border-destructive/40 bg-destructive/10 px-3 py-1 text-[11px]">
                            后端：{error}
                        </div>
                    )}
                </div>
                {taskPanel && taskPanelOpen && room !== undefined && room.type === 'task' && (
                    <TaskPanel room={room} onClose={onCloseTaskPanel} />
                )}
            </main>

            {dialogs.element}

            <div className="pointer-events-none fixed bottom-2 right-3 flex items-center gap-1 text-[10px] text-muted-foreground">
                <BotIcon className="size-3" />
                diy2 · 切片
            </div>
        </div>
    );
}

function SurfaceTabs({ value, onChange }: { value: string; onChange: (id: string) => void }) {
    return (
        <div className="flex items-center gap-1 border-b px-4 py-1.5">
            {SURFACES.map((surface) => (
                <button
                    key={surface.id}
                    onClick={() => onChange(surface.id)}
                    title={surface.hint}
                    className={`rounded-md px-2.5 py-1 text-xs ${
                        value === surface.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted/60'
                    }`}
                >
                    {surface.name}
                </button>
            ))}
            <span className="ml-2 text-[10px] text-muted-foreground">同一份数据，两种表面</span>
        </div>
    );
}

/**
 * 三个表面**都挂载**，只把非当前项隐藏。
 * 之前每次切 tab 都卸载再挂载，长会话要重新渲染几百条 markdown —— 这就是切换卡顿的来源。
 * 用 `display: contents` 让当前项不额外包一层盒子，布局和其他 flex 子项一致。
 */
/** 已挂载的表面用 memo 包住：切 tab 只改显示，不让隐藏的表面跟着重渲染 */
const SurfaceHost = React.memo(function SurfaceHost({
    visible,
    Component,
    targetId,
    composerExtras,
}: {
    visible: boolean;
    Component: React.FC<{ targetId: string; composerExtras?: React.ReactNode }>;
    targetId: string;
    composerExtras?: React.ReactNode;
}) {
    return (
        <div className={visible ? 'contents' : 'hidden'}>
            <Component targetId={targetId} composerExtras={composerExtras} />
        </div>
    );
});

function SurfaceViews({
    surfaceId,
    targetId,
    composerExtras,
}: {
    surfaceId: string;
    targetId: string;
    composerExtras?: React.ReactNode;
}) {
    const [visited, setVisited] = React.useState<ReadonlySet<string>>(() => new Set([surfaceId]));
    React.useEffect(() => {
        setVisited((current) => (current.has(surfaceId) ? current : new Set([...current, surfaceId])));
    }, [surfaceId]);

    return (
        <>
            {SURFACES.filter((surface) => visited.has(surface.id)).map((surface) => (
                <SurfaceHost
                    key={`${surface.id}:${targetId}`}
                    visible={surface.id === surfaceId}
                    Component={surface.Component}
                    targetId={targetId}
                    composerExtras={composerExtras}
                />
            ))}
        </>
    );
}
