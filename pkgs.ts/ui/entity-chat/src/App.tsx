import { Bot as BotIcon, ChevronRight, Cpu, Folder, ListTodo, PanelRight, Plus, X } from 'lucide-react';
import * as React from 'react';

import { SURFACES } from './surfaces/registry';
import { EditableName, StatusChip } from './components/RoomName';
import { SpeakingBar } from './components/SpeakingBar';
import { PendingAskStrip } from './components/PendingAskStrip';
import { ComposerBar } from './components/ComposerBar';
import { ModelPicker } from './components/ModelPicker';
import { TaskPanel } from './components/TaskPanel';
import { Sidebar } from './components/Sidebar';
import { botsOf, dirOf, primaryBotOf, roomTitle, roomTypeLabel, type Room } from './model';
import { modelLabel } from './models';
import {
    actions,
    useBots,
    useDefaultModelKey,
    useError,
    useLoaded,
    useProviders,
    useRoles,
    useRooms,
    useSelectedRoom,
} from './store';
import { useRoomDialogs } from './useRoomDialogs';
import { roles } from './roles';

/** 推理强度固定档位（模型配置页同款；effort 候选数据未进契约前先用这张表） */
const EFFORTS: ReadonlyArray<{ value: string; label: string }> = [
    { value: '', label: '跟随全局' },
    { value: 'minimal', label: 'minimal' },
    { value: 'low', label: 'low' },
    { value: 'medium', label: 'medium' },
    { value: 'high', label: 'high' },
];

/**
 * 房间头部那个模型胶囊。
 *
 * 房间**没选过**模型时（空串）跟着目录的 `defaultModel` 走：显示成「默认 · <模型名>」。
 * 这比显示空白或占位 key 强 —— 一眼看得出「它会用哪个」且「我没显式选过」。
 *
 * 点它不是「原地换模型」，而是展开下面的 `RoleConfigPanel`（2026-11-24 用户定）：
 * 这颗胶囊是「当前类型 bot 配置」的入口，换模型 / 调推理 / 改人格都在那张面板里。
 */
function ModelChip({ value, onClick, open }: { value: string; onClick: () => void; open: boolean }) {
    const providers = useProviders();
    const defaultKey = useDefaultModelKey();
    const inherited = value.trim() === '';
    const shown = inherited ? (defaultKey ?? '') : value;
    const label = modelLabel(providers, shown);
    const short = label.split(' · ')[0];
    return (
        <button
            onClick={onClick}
            aria-expanded={open}
            title={inherited ? `跟随默认：${label} · 点击查看配置` : `${label} · 点击查看配置`}
            className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted ${
                open ? 'bg-muted' : ''
            }`}
        >
            <Cpu className="size-3" />
            {inherited && shown.trim() !== '' ? `默认 · ${short}` : short}
        </button>
    );
}

/**
 * 模型胶囊 / 「角色」按钮点开的**二级配置面板**（2026-11-24 用户定，三级披露的中间一层）。
 *
 * L1 = 头部那颗胶囊（只看当前用啥）；L2 = 这张面板（当前类型 bot 的**重要**配置：
 * 模型 / 推理 + 一句「当前类型」的说明）；L3 = 设置页角色段（改名字 / 人格等全部属性，
 * 深链 `/settings/roles/<type>` 定位到这一类型）。
 *
 * 为什么只放模型 + 推理：用户明确「去掉那些乱七八糟的信息描述，简要为主」—— 优先级说明、
 * 价格、上下文窗口那一大段都归 L3 的角色页，这里只留在房间最常要看的两项。
 * 面板显示的是**该类型角色的配置**（成员由类型派生，改一处全类型生效），不是某个具体 bot。
 */
function RoleConfigPanel({
    room,
    onManageRoles,
    onClose,
}: {
    room: Room;
    /** 去设置页角色段（带房间类型深链）—— 面板的最后一步 */
    onManageRoles?: (() => void) | undefined;
    onClose: () => void;
}) {
    const defaultKey = useDefaultModelKey();
    const allRoles = useRoles();
    // 当前类型、primary 优先的那个角色（面板改的是「这类 bot 的全局配置」，不是某个房间私有 bot）
    const role = allRoles.find((item) => item.type === room.type && item.primary) ?? allRoles.find((item) => item.type === room.type);
    const modelValue = role?.modelKey?.trim() ?? '';
    const inherited = modelValue === '';
    const shown = inherited ? (defaultKey ?? '') : modelValue;
    // 会话页只显模型 id（`account@provider/model` 的 `/` 后一段），不显全称与价目。
    const modelId = shown.split('/').pop() ?? '';
    const modelText = shown.trim() === '' ? '未配置' : inherited ? `默认 · ${modelId}` : modelId;
    const effort = role?.reasoningEffort?.trim() ?? '';

    /** 模型 / effort 就地改：直接写回该类型的角色（= 任务 bot 全局），不绕房间级、不跳配置页 */
    const [editingModel, setEditingModel] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string>();

    const saveModel = React.useCallback(
        async (key: string): Promise<void> => {
            if (role === undefined) return;
            setBusy(true);
            setError(undefined);
            try {
                await roles.update({ id: role.id, modelKey: key });
            } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
                setBusy(false);
            }
        },
        [role],
    );
    const saveEffort = React.useCallback(
        async (value: string): Promise<void> => {
            if (role === undefined) return;
            setBusy(true);
            setError(undefined);
            try {
                await roles.update({ id: role.id, reasoningEffort: value === '' ? null : value });
            } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
                setBusy(false);
            }
        },
        [role],
    );

    return (
        <div
            className="mt-2 rounded-md border bg-popover p-2.5 text-xs text-popover-foreground shadow-md"
            role="dialog"
            aria-label="当前类型配置"
        >
            <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">
                    {roomTypeLabel(room.type)}类型 · 所有{roomTypeLabel(room.type)}共享
                </span>
                <button onClick={onClose} aria-label="关闭配置" className="rounded p-0.5 hover:bg-muted">
                    <X className="size-3" />
                </button>
            </div>

            {error === undefined ? null : (
                <p className="mb-2 text-[11px] text-destructive">{error}</p>
            )}

            {/* 模型：点名字就地展开选择器（L2 内的细项），选完写回该类型角色 */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <span className="flex items-center gap-1.5">
                    <Cpu className="size-3 text-muted-foreground" />
                    模型
                    <button
                        type="button"
                        disabled={busy || role === undefined}
                        onClick={() => setEditingModel((value) => !value)}
                        aria-expanded={editingModel}
                        title="点开选择模型"
                        className="rounded border border-border px-1 py-0.5 font-mono hover:bg-muted disabled:opacity-50"
                    >
                        {modelText}
                    </button>
                </span>
                {/* effort 与模型分开放，方便各改各的 */}
                <label className="flex items-center gap-1.5">
                    推理
                    <select
                        aria-label="推理强度"
                        value={effort}
                        disabled={busy || role === undefined}
                        onChange={(event) => void saveEffort(event.target.value)}
                        className="rounded border border-border bg-card px-1 py-0.5 text-[11px] outline-none disabled:opacity-50"
                    >
                        {EFFORTS.map((item) => (
                            <option key={item.value} value={item.value}>
                                {item.label}
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            {editingModel && role !== undefined ? (
                <div className="mt-2 border-t pt-2">
                    <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">选择模型（改完对该类型所有房间生效）</div>
                    <ModelPicker
                        value={modelValue}
                        onChange={(key) => void saveModel(key)}
                    />
                </div>
            ) : null}

            {onManageRoles !== undefined && (
                <div className="mt-2.5 border-t pt-2">
                    <button
                        onClick={onManageRoles}
                        className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                        全部设置 <ChevronRight className="size-3" />
                    </button>
                </div>
            )}
        </div>
    );
}

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
    onManageRoles,
    taskPanelOpen,
    taskPanelShown,
    onToggleTaskPanel,
}: {
    room: Room;
    /** 去设置页的「角色」那一段（配置面板里的「全部设置」用它）。不传就不画面板里那一步 */
    onManageRoles?: (() => void) | undefined;
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
    // 二级配置面板的开关。模型胶囊与「角色」按钮都开同一张面板；切换房间时由 key 重挂载关掉。
    const [configOpen, setConfigOpen] = React.useState(false);
    const toggleConfig = React.useCallback(() => setConfigOpen((open) => !open), []);
    const closeConfig = React.useCallback(() => setConfigOpen(false), []);

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
                <ModelChip value={room.modelKey} onClick={toggleConfig} open={configOpen} />

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
                    {onManageRoles !== undefined && (
                        <button
                            onClick={toggleConfig}
                            aria-expanded={configOpen}
                            title="成员来自「角色表」：按房间类型共享，展开面板看配置"
                            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 hover:bg-muted ${
                                configOpen ? 'bg-muted' : ''
                            }`}
                        >
                            <Plus className="size-3" />
                            角色
                        </button>
                    )}
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
            {configOpen && (
                <RoleConfigPanel
                    room={room}
                    onManageRoles={onManageRoles}
                    onClose={closeConfig}
                />
            )}
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
export function App({
    sidebar = true,
    taskPanel = true,
    onManageRoles,
}: {
    sidebar?: boolean;
    taskPanel?: boolean;
    /** 房间头配置面板里的「全部设置」：宿主给一个「去角色页」的动作（本包不认识设置页的地址） */
    onManageRoles?: () => void;
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
    const { openProject, openTask, requestDelete, openSettings, openModel } = dialogs;
    const onCreateProject = openProject;
    const onCreateTask = openTask;
    const onRequestDelete = requestDelete;
    const onOpenSettings = openSettings;
    const onToggleTaskPanel = React.useCallback(() => setTaskPanelOpen((open) => !open), []);
    const onCloseTaskPanel = React.useCallback(() => setTaskPanelOpen(false), []);
    // 底栏模型行（ComposerBar）点开房间级换模型对话框 —— 与房间头的只读面板是两回事：
    // 这里改的就是 room.modelKey（房间级），真源一致。
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
                                key={room.id}
                                room={room}
                                onManageRoles={onManageRoles}
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
