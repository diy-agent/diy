import { Bot as BotIcon, Cpu, Folder, ListTodo, Plus, X } from 'lucide-react';
import * as React from 'react';

import { ChatPanel } from './components/ChatPanel';
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
                    {entity.kind === 'project' ? '项目' : '任务'}
                </span>
                <h1 className="text-sm font-semibold">{entity.name}</h1>
                <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                    <Folder className="size-3" />
                    {dirOf(entity, state.entities)}
                </span>
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
                            <button onClick={() => actions.removeBot(entity.id, bot.id)} title="移出对话" className="rounded p-0.5 hover:bg-muted">
                                <X className="size-3" />
                            </button>
                        </span>
                    ))}
                    <button onClick={onAddBot} className="flex items-center gap-1 rounded-full border px-2 py-0.5 hover:bg-muted">
                        <Plus className="size-3" />
                        bot
                    </button>
                </span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
                {entity.botIds.length <= 1
                    ? '单 agent：这个实体的 bot 直接对话（bot 只属于它）'
                    : `多 agent：${entity.botIds.length} 个实体专属 bot 各自回复`}
                <span className="ml-2">· {contextWindowLabel(entity.modelKey)}</span>
            </p>
        </header>
    );
}

function BotHeader({ bot, onPickModel }: { bot: Bot; onPickModel: () => void }) {
    const state = useStore();
    const ownerEntity = state.entities.find((entity) => entity.id === bot.entityId);

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
                <ModelChip value={bot.modelKey} onClick={onPickModel} />
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
                这是 {bot.name} 的独立对话（与它所属实体的群聊分开）；{bot.persona}
            </p>
        </header>
    );
}

export function App() {
    const state = useStore();
    const bot = state.bots[state.selectedId];
    const entity = entityOf(state.selectedId);
    const [dialog, setDialog] = React.useState<'project' | 'bot' | 'settings' | null>(null);
    const [modelTarget, setModelTarget] = React.useState<{ kind: 'entity' | 'bot'; id: string } | null>(null);
    const activeEntity = bot !== undefined ? entityOf(bot.entityId) : entity;

    // 侧栏折叠：持久化 + ⌘B
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
                {bot !== undefined ? (
                    <>
                        <BotHeader bot={bot} onPickModel={() => setModelTarget({ kind: 'bot', id: bot.id })} />
                        <ChatPanel key={bot.id} targetId={bot.id} />
                    </>
                ) : entity !== undefined ? (
                    <>
                        <EntityHeader
                            entity={entity}
                            onAddBot={() => setDialog('bot')}
                            onPickModel={() => setModelTarget({ kind: 'entity', id: entity.id })}
                        />
                        <ChatPanel key={entity.id} targetId={entity.id} />
                    </>
                ) : (
                    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">左侧选择一个项目、任务或 bot</div>
                )}
            </main>

            {dialog === 'project' && (
                <CreateProjectDialog
                    onClose={() => setDialog(null)}
                    onSubmit={(input) => {
                        actions.createProject(input);
                    }}
                />
            )}
            {dialog === 'bot' && activeEntity !== undefined && (
                <CreateBotDialog
                    entity={activeEntity}
                    onClose={() => setDialog(null)}
                    onPickExisting={(botId) => actions.addExistingBot(activeEntity.id, botId)}
                    onCreateNew={(name) => actions.addBot(activeEntity.id, name)}
                />
            )}
            {dialog === 'settings' && (
                <SettingsDialog
                    defaultModelKey={state.defaultModelKey}
                    onChangeDefault={(key) => actions.setDefaultModel(key)}
                    onClose={() => setDialog(null)}
                />
            )}
            {modelTarget !== null && (
                <ModelDialog
                    title={
                        modelTarget.kind === 'entity'
                            ? `「${entityOf(modelTarget.id)?.name ?? ''}」的模型`
                            : `bot「${state.bots[modelTarget.id]?.name ?? ''}」的模型`
                    }
                    value={
                        modelTarget.kind === 'entity'
                            ? (entityOf(modelTarget.id)?.modelKey ?? state.defaultModelKey)
                            : (state.bots[modelTarget.id]?.modelKey ?? state.defaultModelKey)
                    }
                    onChange={(key) =>
                        modelTarget.kind === 'entity' ? actions.setEntityModel(modelTarget.id, key) : actions.setBotModel(modelTarget.id, key)
                    }
                    onClose={() => setModelTarget(null)}
                />
            )}

            <div className="pointer-events-none fixed bottom-2 right-3 flex items-center gap-1 text-[10px] text-muted-foreground">
                <BotIcon className="size-3" />
                entity-chat · 实验骨架
            </div>
        </div>
    );
}
