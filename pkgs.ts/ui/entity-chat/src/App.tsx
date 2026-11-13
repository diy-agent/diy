import { Bot as BotIcon, Cpu, Folder, ListTodo, Plus, X } from 'lucide-react';
import * as React from 'react';

import { SURFACES } from './surfaces/registry';
import { CreateBotDialog, CreateProjectDialog, ModelDialog, SettingsDialog } from './components/Dialogs';
import { Sidebar } from './components/Sidebar';
import { botsOf, dirOf, ownerOfBot, type Bot, type Entity } from './model';
import { contextWindowLabel, modelLabel } from './models';
import { actions, entityOf, useStore } from './store';

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

function EntityHeader({ entity, onAddBot, onPickModel }: { entity: Entity; onAddBot: () => void; onPickModel: () => void }) {
    const state = useStore();
    const bots = botsOf(entity, state.bots);
    const owner = ownerOfBot(entity, state.bots);
    const members = bots.slice(1);

    return (
        <header className="border-b px-5 py-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {entity.kind === 'project' ? <Folder className="size-3 text-sky-400" /> : <ListTodo className="size-3 text-emerald-400" />}
                    {entity.kind === 'project' ? '项目' : entity.kind === 'task' ? '任务' : 'Bot'}
                </span>
                <h1 className="text-sm font-semibold">{entity.name}</h1>
                {entity.dir !== undefined && (
                    <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                        <Folder className="size-3" />
                        {dirOf(entity, state.entities)}
                    </span>
                )}
                <ModelChip value={entity.modelKey} onClick={onPickModel} />

                <span className="ml-auto flex items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">owner</span>
                    {owner !== undefined && (
                        <span className="flex items-center gap-1 rounded-full border px-2 py-0.5">
                            <span className="size-2 rounded-full" style={{ background: owner.color }} />
                            {owner.name}
                        </span>
                    )}
                    {members.map((bot) => (
                        <span key={bot.id} className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-muted-foreground">
                            <span className="size-2 rounded-full" style={{ background: bot.color }} />
                            {bot.name}
                        </span>
                    ))}
                    <button onClick={onAddBot} className="flex items-center gap-1 rounded-full border px-2 py-0.5 hover:bg-muted">
                        <Plus className="size-3" />
                        bot
                    </button>
                </span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
                {entity.botIds.length <= 1 ? '单 agent：这个实体的 bot 直接对话' : `多 agent：${entity.botIds.length} 个实体专属 bot`}
                <span className="ml-2">· {contextWindowLabel(entity.modelKey)}</span>
            </p>
        </header>
    );
}

function BotHeader({ bot, entity, onPickModel }: { bot: Bot; entity: Entity; onPickModel: () => void }) {
    const state = useStore();
    const ownerEntity = state.entities.find((item) => item.id === bot.homeEntityId);

    return (
        <header className="border-b px-5 py-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    <BotIcon className="size-3" style={{ color: bot.color }} />
                    Bot
                </span>
                <h1 className="flex items-center gap-2 text-sm font-semibold">
                    <span className="size-2 rounded-full" style={{ background: bot.color }} />
                    {bot.name}
                </h1>
                <span className="text-[11px] text-muted-foreground">
                    属于 {ownerEntity?.kind === 'project' ? '项目' : '任务'}「{ownerEntity?.name ?? '?'}」
                </span>
                <ModelChip value={entity.modelKey} onClick={onPickModel} />
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">这是 {bot.name} 的独立对话；{bot.persona}</p>
        </header>
    );
}

export function App() {
    const state = useStore();
    const entity = entityOf(state.selectedId);
    const bot = entity?.kind === 'bot' ? state.bots[entity.botIds[0] ?? ''] : undefined;
    const [dialog, setDialog] = React.useState<'project' | 'bot' | 'settings' | null>(null);
    const [surfaceId, setSurfaceId] = React.useState<string>(SURFACES[0]!.id);
    const [modelTarget, setModelTarget] = React.useState<string | null>(null);
    const activeEntity = entity;

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
                onCreateBot={() => setDialog('bot')}
                onOpenSettings={() => setDialog('settings')}
            />

            <main className="flex min-w-0 flex-1 flex-col">
                {!state.loaded ? (
                    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">连接 diy2 后端…</div>
                ) : entity === undefined ? (
                    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">左侧选择一个项目、任务或 bot</div>
                ) : bot !== undefined ? (
                    <>
                        <BotHeader bot={bot} entity={entity} onPickModel={() => setModelTarget(entity.id)} />
                        <SurfaceTabs value={surfaceId} onChange={setSurfaceId} />
                        <SurfaceView surfaceId={surfaceId} targetId={entity.id} />
                    </>
                ) : (
                    <>
                        <EntityHeader entity={entity} onAddBot={() => setDialog('bot')} onPickModel={() => setModelTarget(entity.id)} />
                        <SurfaceTabs value={surfaceId} onChange={setSurfaceId} />
                        <SurfaceView surfaceId={surfaceId} targetId={entity.id} />
                    </>
                )}
                {state.error !== undefined && (
                    <div className="border-t border-destructive/40 bg-destructive/10 px-3 py-1 text-[11px]">后端：{state.error}</div>
                )}
            </main>

            {dialog === 'project' && <CreateProjectDialog onClose={() => setDialog(null)} onSubmit={(input) => actions.createProject(input)} />}
            {dialog === 'bot' && activeEntity !== undefined && (
                <CreateBotDialog
                    entity={activeEntity}
                    onClose={() => setDialog(null)}
                    onPickExisting={(botId) => actions.addExistingBot(activeEntity.id, botId)}
                    onCreateNew={(name) => actions.addBot(activeEntity.id, name)}
                />
            )}
            {dialog === 'settings' && (
                <SettingsDialog defaultModelKey={state.defaultModelKey} onChangeDefault={(key) => actions.setDefaultModel(key)} onClose={() => setDialog(null)} />
            )}
            {modelTarget !== null && (
                <ModelDialog
                    title={`「${entityOf(modelTarget)?.name ?? ''}」的模型`}
                    value={entityOf(modelTarget)?.modelKey ?? state.defaultModelKey}
                    onChange={(key) => actions.setEntityModel(modelTarget, key)}
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
