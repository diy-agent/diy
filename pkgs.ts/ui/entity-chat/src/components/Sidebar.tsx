import { Folder, ListPlus, ListTodo, PanelLeftClose, PanelLeftOpen, Plus, Settings } from 'lucide-react';
import * as React from 'react';

import { primaryBotOf, type Room } from '../model';
import { actions, useStore } from '../store';

function RoomRow({
    room,
    active,
    compact,
    onCreateTask,
}: {
    room: Room;
    active: boolean;
    compact: boolean;
    onCreateTask?: () => void;
}) {
    const state = useStore();
    const [editing, setEditing] = React.useState(false);
    const [draft, setDraft] = React.useState(room.name);
    const primary = primaryBotOf(room, state.bots);
    const isProject = room.type === 'project';
    const Icon = isProject ? Folder : ListTodo;

    const commit = () => {
        actions.renameRoom(room.id, draft);
        setEditing(false);
    };

    if (compact) {
        return (
            <button
                onClick={() => actions.select(room.id)}
                title={`${room.type}：${room.name}`}
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
                            setDraft(room.name);
                            setEditing(false);
                        }
                    }}
                    className="min-w-0 flex-1 rounded border bg-background px-1 text-sm outline-none"
                />
            ) : (
                <button
                    onClick={() => actions.select(room.id)}
                    onDoubleClick={() => {
                        setDraft(room.name);
                        setEditing(true);
                    }}
                    title="双击重命名"
                    className="min-w-0 flex-1 truncate text-left"
                >
                    {room.name}
                </button>
            )}

            {primary !== undefined && (
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: primary.color }} title={`默认应答：${primary.name}`} />
            )}

            {isProject && onCreateTask !== undefined && (
                <button onClick={onCreateTask} title="在本项目下新建任务（并直接对话）" className="shrink-0 rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100">
                    <ListPlus className="size-3.5" />
                </button>
            )}
        </div>
    );
}

export function Sidebar({
    open,
    onToggle,
    onCreateProject,
    onOpenSettings,
}: {
    open: boolean;
    onToggle: () => void;
    onCreateProject: () => void;
    onOpenSettings: () => void;
}) {
    const state = useStore();
    const projects = state.rooms.filter((room) => room.type === 'project');
    const projectIds = new Set(projects.map((project) => project.id));
    // 非项目、且没有挂在任何已存在的项目下 → "未归属"（老数据 / projectId 丢了的任务）
    const orphans = state.rooms.filter(
        (room) => room.type !== 'project' && !projectIds.has(String(room.data['projectId'] ?? '')),
    );

    return (
        <aside
            className="flex shrink-0 flex-col overflow-hidden border-r transition-[width] duration-200"
            style={{ width: open ? 256 : 56 }}
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
                        <button onClick={onCreateProject} title="从本机目录新建项目" className="rounded p-0.5 hover:bg-muted">
                            <Plus className="size-3.5" />
                        </button>
                    </div>
                )}

                {projects.map((project) => {
                    const tasks = state.rooms.filter((room) => room.data['projectId'] === project.id);
                    return (
                        <div key={project.id} className={open ? 'mb-2' : 'mb-1'}>
                            <RoomRow
                                room={project}
                                active={state.selectedId === project.id}
                                compact={!open}
                                onCreateTask={() => actions.createTask(project.id)}
                            />
                            {tasks.map((task) => (
                                <div key={task.id} className={open ? 'ml-4' : ''}>
                                    <RoomRow room={task} active={state.selectedId === task.id} compact={!open} />
                                </div>
                            ))}
                        </div>
                    );
                })}

                {/* 没挂到任何项目下的容器（老数据丢过 projectId / 以后别的类型）也要能点开 ——
                    按 projectId 分组的写法会让它们直接消失，数据还在却永远进不去 */}
                {orphans.length > 0 && (
                    <div className={open ? 'mb-2' : 'mb-1'}>
                        {open && (
                            <div className="px-2 pb-1 text-[11px] text-muted-foreground">未归属</div>
                        )}
                        {orphans.map((room) => (
                            <RoomRow key={room.id} room={room} active={state.selectedId === room.id} compact={!open} />
                        ))}
                    </div>
                )}
            </div>

            <div className={`flex items-center border-t py-2 ${open ? 'justify-between px-3' : 'justify-center'}`}>
                {open && <span className="text-[11px] leading-relaxed text-muted-foreground">容器 = 一条对话；成员在容器内</span>}
                <button onClick={onOpenSettings} title="模型设置" className="rounded p-1 text-muted-foreground hover:bg-muted">
                    <Settings className="size-4" />
                </button>
            </div>
        </aside>
    );
}
