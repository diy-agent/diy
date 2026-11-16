import { Bot as BotIcon, Cpu, Folder, ListTodo, Plus } from 'lucide-react';
import * as React from 'react';

import { SURFACES } from './surfaces/registry';
import {
    AddMemberDialog,
    ConfirmDeleteDialog,
    CreateProjectDialog,
    CreateTaskDialog,
    ModelDialog,
    SettingsDialog,
} from './components/Dialogs';
import { EditableName, StatusChip } from './components/RoomName';
import { SpeakingBar } from './components/SpeakingBar';
import { ContextPanel } from './components/ContextPanel';
import { Sidebar } from './components/Sidebar';
import { botsOf, dirOf, primaryBotOf, roomTypeLabel, type Room } from './model';
import { modelLabel } from './models';
import { actions, useStore } from './store';

function ModelChip({ value, onClick }: { value: string; onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            title={`${modelLabel(value)} · 点击切换`}
            className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted"
        >
            <Cpu className="size-3" />
            {modelLabel(value).split(' · ')[0]}
        </button>
    );
}

function roomDir(room: Room): string | undefined {
    const dir = room.data['dir'];
    return typeof dir === 'string' && dir !== '' ? dir : undefined;
}

function RoomHeader({
    room,
    onAddMember,
    onPickModel,
}: {
    room: Room;
    onAddMember: () => void;
    onPickModel: () => void;
}) {
    const state = useStore();
    const bots = botsOf(room, state.bots);
    const primary = primaryBotOf(room, state.bots);
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
                    value={room.name}
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
                        {dirOf(room, state.rooms)}
                    </span>
                )}
                <ModelChip value={room.modelKey} onClick={onPickModel} />

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
                </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>
                    {bots.length <= 1
                        ? '只有默认应答，没有 @ 时它自己回'
                        : `${bots.length} 个成员：@名字叫谁谁回，@all 全回（等于开会，token 按人数涨）`}
                </span>
                <ContextPanel room={room} />
            </div>
        </header>
    );
}

export function App() {
    const state = useStore();
    // ⚠️ 用内联 find 而不是 `roomOf(state.selectedId)`：React Compiler 会把
    // 「参数没变的外部函数调用」整个 memo 住，于是 `state.rooms` 变了、`selectedId` 没变时
    // 拿到的还是旧 room —— 表现是侧栏已改名/改状态，头部标题与状态胶囊一动不动。
    // 内联箭头函数里的 `state.rooms` 是编译器看得见的依赖，不会被缓存。
    const room = state.rooms.find((item) => item.id === state.selectedId);
    // 弹窗状态：新建项目 / 新建任务（记住在哪个项目下）/ 加成员 / 设置 / 删除确认
    const [dialog, setDialog] = React.useState<
        | null
        | { kind: 'project' }
        | { kind: 'member' }
        | { kind: 'settings' }
        | { kind: 'task'; projectId: string }
        | { kind: 'delete'; roomId: string }
    >(null);
    // 默认表面：Astryx（虚拟化 + 自带代码高亮，长会话最稳）
    const [surfaceId, setSurfaceId] = React.useState<string>(
        SURFACES.find((surface) => surface.id === 'astryx')?.id ?? SURFACES[0]!.id,
    );
    const [modelTarget, setModelTarget] = React.useState<string | null>(null);
    const activeRoom = room;
    const taskProject =
        dialog?.kind === 'task' ? state.rooms.find((item) => item.id === dialog.projectId) : undefined;
    const deleteTarget =
        dialog?.kind === 'delete' ? state.rooms.find((item) => item.id === dialog.roomId) : undefined;
    const modelRoom = modelTarget === null ? undefined : state.rooms.find((item) => item.id === modelTarget);

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
        const onKey = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
                event.preventDefault();
                toggleSidebar();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [toggleSidebar]);

    return (
        <div className="flex h-full">
            <Sidebar
                open={sidebarOpen}
                onToggle={toggleSidebar}
                onCreateProject={() => setDialog({ kind: 'project' })}
                onCreateTask={(projectId) => setDialog({ kind: 'task', projectId })}
                onRequestDelete={(target) => setDialog({ kind: 'delete', roomId: target.id })}
                onOpenSettings={() => setDialog({ kind: 'settings' })}
            />

            <main className="relative flex min-w-0 flex-1 flex-col">
                {!state.loaded ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                        <span className="flex items-center gap-2">
                            <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                            连接 diy2 后端…
                        </span>
                        {state.error !== undefined && (
                            <span className="text-[11px] text-destructive">上次失败：{state.error}（正在重试）</span>
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
                            onAddMember={() => setDialog({ kind: 'member' })}
                            onPickModel={() => setModelTarget(room.id)}
                        />
                        <SurfaceTabs value={surfaceId} onChange={setSurfaceId} />
                        <SpeakingBar roomId={room.id} />
                        <SurfaceViews surfaceId={surfaceId} targetId={room.id} />
                    </>
                )}
                {state.loaded && state.error !== undefined && (
                    <div className="border-t border-destructive/40 bg-destructive/10 px-3 py-1 text-[11px]">
                        后端：{state.error}
                    </div>
                )}
            </main>

            {dialog?.kind === 'project' && (
                <CreateProjectDialog
                    onClose={() => setDialog(null)}
                    onSubmit={(input) => actions.createProject(input)}
                />
            )}
            {dialog?.kind === 'task' && taskProject !== undefined && (
                <CreateTaskDialog
                    project={taskProject}
                    suggestedName={`新任务 ${
                        state.rooms.filter((item) => item.data['projectId'] === dialog.projectId).length + 1
                    }`}
                    onClose={() => setDialog(null)}
                    onSubmit={(input) => void actions.createTask(dialog.projectId, input.name, {
                        ...(input.desc === undefined ? {} : { desc: input.desc }),
                    })}
                />
            )}
            {dialog?.kind === 'delete' && deleteTarget !== undefined && (
                <ConfirmDeleteDialog
                    room={deleteTarget}
                    taskCount={state.rooms.filter((item) => item.data['projectId'] === dialog.roomId).length}
                    onClose={() => setDialog(null)}
                    onConfirm={() => void actions.deleteRoom(dialog.roomId)}
                />
            )}
            {dialog?.kind === 'member' && activeRoom !== undefined && (
                <AddMemberDialog
                    room={activeRoom}
                    onClose={() => setDialog(null)}
                    onPickExisting={(botId) => actions.addExistingBot(activeRoom.id, botId)}
                    onCreateNew={(name) => actions.addBot(activeRoom.id, name)}
                />
            )}
            {dialog?.kind === 'settings' && (
                <SettingsDialog
                    defaultModelKey={state.defaultModelKey}
                    onChangeDefault={(key) => actions.setDefaultModel(key)}
                    onClose={() => setDialog(null)}
                />
            )}
            {modelTarget !== null && (
                <ModelDialog
                    title={`「${modelRoom?.name ?? ''}」的模型`}
                    value={modelRoom?.modelKey ?? state.defaultModelKey}
                    onChange={(key) => {
                        if (modelTarget !== null) actions.setRoomModel(modelTarget, key);
                    }}
                    onClose={() => setModelTarget(null)}
                />
            )}

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
}: {
    visible: boolean;
    Component: React.FC<{ targetId: string }>;
    targetId: string;
}) {
    return (
        <div className={visible ? 'contents' : 'hidden'}>
            <Component targetId={targetId} />
        </div>
    );
});

function SurfaceViews({ surfaceId, targetId }: { surfaceId: string; targetId: string }) {
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
                />
            ))}
        </>
    );
}
