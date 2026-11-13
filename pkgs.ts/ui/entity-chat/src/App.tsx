import { Bot as BotIcon, Cpu, Folder, ListTodo, Plus } from 'lucide-react';
import * as React from 'react';

import { SURFACES } from './surfaces/registry';
import { AddMemberDialog, CreateProjectDialog, ModelDialog, SettingsDialog } from './components/Dialogs';
import { Sidebar } from './components/Sidebar';
import { botsOf, dirOf, primaryBotOf, roomTypeLabel, type Room } from './model';
import { contextWindowLabel, modelLabel } from './models';
import { actions, roomOf, useStore } from './store';

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

function RoomHeader({ room, onAddMember, onPickModel }: { room: Room; onAddMember: () => void; onPickModel: () => void }) {
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
                <h1 className="text-sm font-semibold">{room.name}</h1>
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
                        <span key={bot.id} className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-muted-foreground">
                            <span className="size-2 rounded-full" style={{ background: bot.color }} />
                            {bot.name}
                        </span>
                    ))}
                    <button onClick={onAddMember} className="flex items-center gap-1 rounded-full border px-2 py-0.5 hover:bg-muted">
                        <Plus className="size-3" />
                        成员
                    </button>
                </span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
                {bots.length <= 1 ? '只有默认应答，没有 @ 时它自己回' : `${bots.length} 个成员：@名字叫谁谁回，@all 全回（等于开会，token 按人数涨）`}
                <span className="ml-2">· {contextWindowLabel(room.modelKey)}</span>
            </p>
        </header>
    );
}

export function App() {
    const state = useStore();
    const room = roomOf(state.selectedId);
    const [dialog, setDialog] = React.useState<'project' | 'member' | 'settings' | null>(null);
    const [surfaceId, setSurfaceId] = React.useState<string>(SURFACES[0]!.id);
    const [modelTarget, setModelTarget] = React.useState<string | null>(null);
    const activeRoom = room;

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
                onCreateProject={() => setDialog('project')}
                onOpenSettings={() => setDialog('settings')}
            />

            <main className="flex min-w-0 flex-1 flex-col">
                {!state.loaded ? (
                    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">连接 diy2 后端…</div>
                ) : room === undefined ? (
                    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">左侧选择一个容器</div>
                ) : (
                    <>
                        <RoomHeader room={room} onAddMember={() => setDialog('member')} onPickModel={() => setModelTarget(room.id)} />
                        <SurfaceTabs value={surfaceId} onChange={setSurfaceId} />
                        <SurfaceView surfaceId={surfaceId} targetId={room.id} />
                    </>
                )}
                {state.error !== undefined && (
                    <div className="border-t border-destructive/40 bg-destructive/10 px-3 py-1 text-[11px]">后端：{state.error}</div>
                )}
            </main>

            {dialog === 'project' && <CreateProjectDialog onClose={() => setDialog(null)} onSubmit={(input) => actions.createProject(input)} />}
            {dialog === 'member' && activeRoom !== undefined && (
                <AddMemberDialog
                    room={activeRoom}
                    onClose={() => setDialog(null)}
                    onPickExisting={(botId) => actions.addExistingBot(activeRoom.id, botId)}
                    onCreateNew={(name) => actions.addBot(activeRoom.id, name)}
                />
            )}
            {dialog === 'settings' && (
                <SettingsDialog defaultModelKey={state.defaultModelKey} onChangeDefault={(key) => actions.setDefaultModel(key)} onClose={() => setDialog(null)} />
            )}
            {modelTarget !== null && (
                <ModelDialog
                    title={`「${roomOf(modelTarget)?.name ?? ''}」的模型`}
                    value={roomOf(modelTarget)?.modelKey ?? state.defaultModelKey}
                    onChange={(key) => actions.setRoomModel(modelTarget, key)}
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

function SurfaceView({ surfaceId, targetId }: { surfaceId: string; targetId: string }) {
    const surface = SURFACES.find((entry) => entry.id === surfaceId) ?? SURFACES[0]!;
    const Component = surface.Component;
    return <Component key={`${surface.id}:${targetId}`} targetId={targetId} />;
}
