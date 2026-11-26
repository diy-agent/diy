import { Bot as BotIcon, PanelRight } from 'lucide-react';
import * as React from 'react';

import { SURFACES } from './surfaces/registry';
import { RoomMenu, SurfaceTabs } from './components/ConversationBar';
import { RoomStatusBar } from './components/RoomStatusBar';
import { ComposerBar } from './components/ComposerBar';
import { ContextPanel } from './components/ContextPanel';
import { TaskPanel } from './components/TaskPanel';
import { Sidebar } from './components/Sidebar';
import { type Room } from './model';
import { actions, useError, useLoaded, useMarkRoomRead, useSelectedRoom } from './store';
import { useSurfaceId } from './surface';
import { useRoomDialogs } from './useRoomDialogs';
import { Button } from '@diy-agent/ui-shadcn';

/**
 * 对话区的**唯一一行头**（用户 2026-11-24）：左侧表面切换，右侧能力入口。
 *
 * 删掉的两样（用户原话「项目、diy 这两个字符串删掉，三点操作按钮上移」）：
 * · 类型标签（`☑ 项目`）—— 侧栏那行已经在用图标/位置说同一件事；
 * · 大标题（`diy`）—— 侧栏高亮的行就是它，而顶部窗口标题栏也写着。
 *
 * 于是原来两行（头 + tabs）变成**一行**：表面切换上移到这里，kebab 也跟着上移。
 * 少掉的那一行不是为了好看 —— 它站的位置是视线第一落点，常驻内容却没有任何可操作的东西。
 *
 * `bar="host"`：宿主（工作台的区域标题栏）已经画了表面切换和房间菜单，这一行整条不画。
 *
 * `memo` 的意义：`App` 因「侧栏一行的高亮变了」这类原因重渲时，它不该跟着整块重画。
 */
const ConversationBar = React.memo(function ConversationBar({
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
    return (
        <div className="flex items-center gap-1 border-b px-4 py-1.5">
            <SurfaceTabs />
            <span className="ml-auto flex shrink-0 items-center gap-1">
                {taskPanelShown && room.type === 'task' && (
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={onToggleTaskPanel}
                        title="任务描述与正文"
                        aria-label="任务面板"
                        // 展开态靠 variant 的 aria-expanded 样式（不用再手拼 bg-muted）
                        aria-expanded={taskPanelOpen}
                        className="text-muted-foreground"
                    >
                        <PanelRight className="size-3.5" />
                    </Button>
                )}
                <RoomMenu room={room} onAddMember={onAddMember} onOpenSettings={onOpenSettings} />
            </span>
        </div>
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
export function App({
    sidebar = true,
    taskPanel = true,
    bar = 'self',
}: {
    sidebar?: boolean;
    taskPanel?: boolean;
    /**
     * 对话区顶部那条（表面切换 + 房间菜单）谁来画。
     *
     * `self`（缺省）= 这条组件自己画一行（整页形态）。
     * `host` = 宿主已经画了（工作台把它摆进区域标题栏，跟「对话」那个名字同一行），
     *   这里就**不再占一行** —— 宿主接管的好处正是「少掉一行常驻空白」。
     */
    bar?: 'self' | 'host';
} = {}) {
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
    /**
     * 未读水位：「这个房间开着且页面可见」就报到最后一条（含新到达的）—— 判据在 hook 里。
     * 没挂到别的组件上是因为它是**页面级**的事实（哪一页被看），与具体表面无关。
     */
    useMarkRoomRead(room?.id);
    // 弹窗（新建项目 / 建任务 / 加成员 / 设置 / 删房间 / 换模型）整体在 useRoomDialogs 里：
    // 工作台要用同一套，状态不能长在这一层。
    const dialogs = useRoomDialogs();
    // 选哪一面：状态在 `surface.ts` 的模块 store（宿主也要画那几颗 tab，见那里的注释）
    const [surfaceId] = useSurfaceId();

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
                            {bar === 'self' && (
                                <ConversationBar
                                    room={room}
                                    onAddMember={onAddMember}
                                    onOpenSettings={onOpenSettings}
                                    taskPanelOpen={taskPanelOpen}
                                    taskPanelShown={taskPanel}
                                    onToggleTaskPanel={onToggleTaskPanel}
                                />
                            )}
                            <RoomStatusBar roomId={room.id} surfaceId={surfaceId} />
                            <SurfaceViews surfaceId={surfaceId} targetId={room.id} composerExtras={composerExtras} />
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
