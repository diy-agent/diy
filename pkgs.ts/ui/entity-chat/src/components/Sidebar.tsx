import { Folder, ListPlus, ListTodo, PanelLeftClose, PanelLeftOpen, Plus, Settings } from 'lucide-react';
import * as React from 'react';

import { botsOf, ownerOfBot, type Bot, type Entity } from '../model';
import { actions, useStore } from '../store';

function EntityRow({
    entity,
    active,
    compact,
    onCreateTask,
}: {
    entity: Entity;
    active: boolean;
    compact: boolean;
    onCreateTask?: () => void;
}) {
    const state = useStore();
    const [editing, setEditing] = React.useState(false);
    const [draft, setDraft] = React.useState(entity.name);
    const owner = ownerOfBot(entity, state.bots);
    const Icon = entity.kind === 'project' ? Folder : ListTodo;
    const isProject = entity.kind === 'project';

    const commit = () => {
        actions.renameEntity(entity.id, draft);
        setEditing(false);
    };

    if (compact) {
        return (
            <button
                onClick={() => actions.select(entity.id)}
                title={`${entity.kind === 'project' ? '项目' : '任务'}：${entity.name}`}
                className={`flex w-full items-center justify-center rounded-lg py-2 ${
                    active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted/60'
                }`}
            >
                <Icon className={`size-4 ${isProject ? 'text-sky-400' : 'text-emerald-400'}`} />
            </button>
        );
    }

    return (
        <div
            className={`group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted/60'
            }`}
        >
            <Icon className={`size-3.5 shrink-0 ${isProject ? 'text-sky-400' : 'text-emerald-400'}`} />

            {editing ? (
                <input
                    autoFocus
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={commit}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') commit();
                        if (event.key === 'Escape') {
                            setDraft(entity.name);
                            setEditing(false);
                        }
                    }}
                    className="min-w-0 flex-1 rounded border bg-background px-1 text-sm outline-none"
                />
            ) : (
                <button
                    onClick={() => actions.select(entity.id)}
                    onDoubleClick={() => {
                        setDraft(entity.name);
                        setEditing(true);
                    }}
                    title="双击重命名"
                    className="min-w-0 flex-1 truncate text-left"
                >
                    {entity.name}
                </button>
            )}

            {owner !== undefined && <span className="size-1.5 shrink-0 rounded-full" style={{ background: owner.color }} title={`owner: ${owner.name}`} />}

            {isProject && onCreateTask !== undefined && (
                <button onClick={onCreateTask} title="在本项目下新建任务（并直接对话）" className="shrink-0 rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100">
                    <ListPlus className="size-3.5" />
                </button>
            )}
        </div>
    );
}

function BotRow({ bot, compact }: { bot: Bot; compact: boolean }) {
    const state = useStore();
    const owner = state.entities.find((e) => e.id === bot.entityId);
    const active = state.selectedId === bot.id;

    if (compact) {
        return (
            <button
                onClick={() => actions.select(bot.id)}
                title={`bot：${bot.name}（属于 ${owner?.name ?? '?'}）`}
                className={`flex w-full items-center justify-center rounded-lg py-1.5 ${
                    active ? 'bg-accent' : 'hover:bg-muted/60'
                }`}
            >
                <span className="size-2.5 rounded-full" style={{ background: bot.color }} />
            </button>
        );
    }

    return (
        <button
            onClick={() => actions.select(bot.id)}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs ${
                active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted/60'
            }`}
            title={`${bot.name} 专属：${owner?.name ?? bot.entityId}`}
        >
            <span className="size-2 shrink-0 rounded-full" style={{ background: bot.color }} />
            <span className="truncate">{bot.name}</span>
            <span className="ml-auto truncate text-[10px] text-muted-foreground/70">{owner?.name ?? '?'}</span>
        </button>
    );
}

export function Sidebar({
    open,
    onToggle,
    onCreateProject,
    onCreateBot,
    onOpenSettings,
}: {
    open: boolean;
    onToggle: () => void;
    onCreateProject: () => void;
    onCreateBot: () => void;
    onOpenSettings: () => void;
}) {
    const state = useStore();
    const projects = state.entities.filter((e) => e.kind === 'project');
    // 同一个 bot 可能被多个实体借用：列表按 bot 去重，只显示它自己的归属
    const seen = new Set<string>();
    const allBots = state.entities
        .flatMap((entity) => botsOf(entity, state.bots))
        .filter((bot) => (seen.has(bot.id) ? false : (seen.add(bot.id), true)));

    return (
        <aside
            className="flex shrink-0 flex-col overflow-hidden border-r transition-[width] duration-200"
            style={{ width: open ? 256 : 56 }}
        >
            <div className={`flex items-center border-b py-3 ${open ? 'gap-2 px-3' : 'justify-center px-1'}`}>
                {open && (
                    <>
                        <span className="text-sm font-semibold">diy</span>
                        <span className="text-xs text-muted-foreground">实体对话</span>
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
                        <button onClick={onCreateProject} title="从本机目录新建项目" className="rounded p-0.5 hover:bg-muted">
                            <Plus className="size-3.5" />
                        </button>
                    </div>
                )}

                {projects.map((project) => {
                    const tasks = state.entities.filter((e) => e.projectId === project.id);
                    return (
                        <div key={project.id} className={open ? 'mb-2' : 'mb-1'}>
                            <EntityRow
                                entity={project}
                                active={state.selectedId === project.id}
                                compact={!open}
                                onCreateTask={() => actions.createTask(project.id)}
                            />
                            {tasks.map((task) => (
                                <div key={task.id} className={open ? 'ml-4' : ''}>
                                    <EntityRow entity={task} active={state.selectedId === task.id} compact={!open} />
                                </div>
                            ))}
                        </div>
                    );
                })}

                <div className={open ? 'mt-3 mb-1 flex items-center justify-between border-t px-2 pt-3 text-[11px] uppercase tracking-wide text-muted-foreground' : 'mt-2 border-t pt-2'}>
                    {open ? (
                        <>
                            Bots（实体专属）
                            <button onClick={onCreateBot} title="给当前实体新增一个 bot" className="rounded p-0.5 hover:bg-muted">
                                <Plus className="size-3.5" />
                            </button>
                        </>
                    ) : null}
                </div>
                {allBots.map((bot) => (
                    <BotRow key={bot.id} bot={bot} compact={!open} />
                ))}
            </div>

            <div className={`flex items-center border-t py-2 ${open ? 'justify-between px-3' : 'justify-center'}`}>
                {open && (
                    <span className="text-[11px] leading-relaxed text-muted-foreground">
                        项目 = 本机目录；实体即对话
                    </span>
                )}
                <button onClick={onOpenSettings} title="模型设置" className="rounded p-1 text-muted-foreground hover:bg-muted">
                    <Settings className="size-4" />
                </button>
            </div>
        </aside>
    );
}
