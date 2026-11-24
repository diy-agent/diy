import { Bot as BotIcon, CheckCircle2, Folder, ListTodo, PanelRight, Plus, Settings } from 'lucide-react';
import * as React from 'react';

import { SURFACES } from './surfaces/registry';
import { MenuButton } from './components/Menu';
import { EditableName } from './components/RoomName';
import { RoomStatusBar } from './components/RoomStatusBar';
import { ComposerBar } from './components/ComposerBar';
import { ContextPanel } from './components/ContextPanel';
import { TaskPanel } from './components/TaskPanel';
import { Sidebar } from './components/Sidebar';
import { roomTitle, roomTypeLabel, taskStatusOf, type Room } from './model';
import { actions, useError, useLoaded, useSelectedRoom } from './store';
import { useRoomDialogs } from './useRoomDialogs';

/**
 * 头部（用户 2026-11-24 商定的瘦身版）：**类型标签 + 可编辑标题 + 右侧能力入口**。
 *
 * 删掉的东西（它们把同一个问题说了三遍，且都是常驻占位）：
 * · `StatusChip` —— 任务 open/closed 已经在侧栏那行（GitHub 语言），这里再来一颗只是重复；
 * · 目录 `~/git/diy/diy` —— 一个几乎不变的路径占了一整段横排；
 * · 成员胶囊 + 「+成员」+ 第二行「N 个成员：@名字…」—— 三个标识说同一件事：谁是成员。
 *   成员信息在每条消息的头像和名字上已经有，能力（加成员 / 房间设置）收进 kebab。
 *
 * `memo` 的意义：`App` 因「侧栏一行的高亮变了」这类原因重渲时，它不该跟着整块重画。
 */
const RoomHeader = React.memo(function RoomHeader({
    room,
    onAddMember,
    onOpenSettings,
    taskPanelOpen,
    taskPanelShown,
    onToggleTaskPanel,
}: {
    room: Room;
    onAddMember: () => void;
    onOpenSettings: () => void;
    taskPanelOpen: boolean;
    /** 宿主是否接管了右侧面板（接管后这个按钮不归本层画 —— 点了也没有本层面板可开） */
    taskPanelShown: boolean;
    onToggleTaskPanel: () => void;
}) {
    const isProject = room.type === 'project';
    const Icon = isProject ? Folder : ListTodo;
    const openTask = !isProject && taskStatusOf(room) === 'open';

    return (
        <header className="flex items-center gap-2 border-b px-5 py-2.5">
            <span className="flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground">
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
            <span className="ml-auto flex shrink-0 items-center gap-1">
                {taskPanelShown && room.type === 'task' && (
                    <button
                        onClick={onToggleTaskPanel}
                        title="任务描述与正文"
                        aria-label="任务面板"
                        className={`rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground ${
                            taskPanelOpen ? 'bg-muted text-foreground' : ''
                        }`}
                    >
                        <PanelRight className="size-3.5" />
                    </button>
                )}
                <MenuButton
                    title="房间操作"
                    items={[
                        {
                            key: 'member',
                            label: '加成员',
                            icon: <Plus className="size-3.5" />,
                            onClick: onAddMember,
                        },
                        {
                            key: 'settings',
                            label: '房间设置',
                            icon: <Settings className="size-3.5" />,
                            onClick: onOpenSettings,
                        },
                        ...(openTask
                            ? [
                                  {
                                      key: 'close',
                                      label: '关闭任务',
                                      icon: <CheckCircle2 className="size-3.5" />,
                                      onClick: () => void actions.setRoomStatus(room.id, 'closed'),
                                  },
                              ]
                            : []),
                    ]}
                />
            </span>
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
                                onOpenSettings={onOpenSettings}
                                taskPanelOpen={taskPanelOpen}
                                taskPanelShown={taskPanel}
                                onToggleTaskPanel={onToggleTaskPanel}
                            />
                            <SurfaceTabs value={surfaceId} onChange={setSurfaceId} />
                            <RoomStatusBar roomId={room.id} surfaceId={surfaceId} />
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
