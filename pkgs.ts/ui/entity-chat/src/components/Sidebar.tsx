import { Folder, ListPlus, ListTodo, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Settings, Trash2 } from 'lucide-react';
import * as React from 'react';

import { primaryBotOf, type Room } from '../model';
import { actions, useStore } from '../store';
import { EditableName, StatusChip } from './RoomName';

/** hover 才出现的行内小按钮：重命名 / 删除。键盘 Tab 也能到（focus-visible 展开） */
function RowAction({
    title,
    onClick,
    children,
    danger = false,
}: {
    title: string;
    onClick: () => void;
    children: React.ReactNode;
    danger?: boolean;
}) {
    return (
        <button
            onClick={(event) => {
                event.stopPropagation();
                onClick();
            }}
            title={title}
            aria-label={title}
            className={`shrink-0 rounded p-0.5 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 ${
                danger ? 'text-muted-foreground hover:bg-destructive/15 hover:text-destructive' : 'hover:bg-muted'
            }`}
        >
            {children}
        </button>
    );
}

function RoomRow({
    room,
    active,
    compact,
    onCreateTask,
    onRequestDelete,
}: {
    room: Room;
    active: boolean;
    compact: boolean;
    onCreateTask?: () => void;
    onRequestDelete: (room: Room) => void;
}) {
    const state = useStore();
    const [renaming, setRenaming] = React.useState(false);
    const primary = primaryBotOf(room, state.bots);
    const isProject = room.type === 'project';
    const Icon = isProject ? Folder : ListTodo;

    if (compact) {
        return (
            <button
                onClick={() => actions.select(room.id)}
                title={`${room.type}：${room.name}`}
                className={`relative flex w-full items-center justify-center rounded-lg py-2 ${
                    active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted/60'
                }`}
            >
                <Icon className={`size-4 ${isProject ? 'text-sky-400' : 'text-emerald-400'}`} />
                {room.type === 'task' && <StatusChip room={room} compact className="absolute bottom-0.5 right-1" />}
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

            <EditableName
                value={room.name}
                mode="double"
                editing={renaming}
                onEditingChange={setRenaming}
                onClick={() => actions.select(room.id)}
                onCommit={(next) => void actions.renameRoom(room.id, next)}
            />

            <StatusChip room={room} />

            {primary !== undefined && (
                <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: primary.color }}
                    title={`默认应答：${primary.name}`}
                />
            )}

            <RowAction title="重命名" onClick={() => setRenaming(true)}>
                <Pencil className="size-3.5" />
            </RowAction>

            {isProject && onCreateTask !== undefined && (
                <RowAction title="在本项目下新建任务（并直接对话）" onClick={onCreateTask}>
                    <ListPlus className="size-3.5" />
                </RowAction>
            )}

            <RowAction title={`删除${isProject ? '项目（连带其任务）' : '任务'}`} onClick={() => onRequestDelete(room)} danger>
                <Trash2 className="size-3.5" />
            </RowAction>
        </div>
    );
}

export function Sidebar({
    open,
    onToggle,
    onCreateProject,
    onCreateTask,
    onRequestDelete,
    onOpenSettings,
}: {
    open: boolean;
    onToggle: () => void;
    onCreateProject: () => void;
    onCreateTask: (projectId: string) => void;
    onRequestDelete: (room: Room) => void;
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
                        <button
                            onClick={onCreateProject}
                            title="从本机目录新建项目"
                            className="rounded p-0.5 hover:bg-muted"
                        >
                            <Plus className="size-3.5" />
                        </button>
                    </div>
                )}

                {open && projects.length === 0 && (
                    <p className="mx-2 rounded-lg border border-dashed px-2 py-2 text-[11px] leading-relaxed text-muted-foreground">
                        还没有项目。点上面的 <Plus className="inline size-3" /> 从本机目录建一个。
                    </p>
                )}

                {projects.map((project) => {
                    const tasks = state.rooms.filter((room) => room.data['projectId'] === project.id);
                    return (
                        <div key={project.id} className={open ? 'mb-2' : 'mb-1'}>
                            <RoomRow
                                room={project}
                                active={state.selectedId === project.id}
                                compact={!open}
                                onCreateTask={() => onCreateTask(project.id)}
                                onRequestDelete={onRequestDelete}
                            />
                            {tasks.map((task) => (
                                <div key={task.id} className={open ? 'ml-4' : ''}>
                                    <RoomRow
                                        room={task}
                                        active={state.selectedId === task.id}
                                        compact={!open}
                                        onRequestDelete={onRequestDelete}
                                    />
                                </div>
                            ))}
                            {open && tasks.length === 0 && (
                                <button
                                    onClick={() => onCreateTask(project.id)}
                                    className="ml-6 mt-0.5 flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                                >
                                    <ListPlus className="size-3" />
                                    新建任务
                                </button>
                            )}
                        </div>
                    );
                })}

                {/* 没挂到任何项目下的容器（老数据丢过 projectId / 以后别的类型）也要能点开 ——
                    按 projectId 分组的写法会让它们直接消失，数据还在却永远进不去 */}
                {orphans.length > 0 && (
                    <div className={open ? 'mb-2' : 'mb-1'}>
                        {open && <div className="px-2 pb-1 text-[11px] text-muted-foreground">未归属</div>}
                        {orphans.map((room) => (
                            <RoomRow
                                key={room.id}
                                room={room}
                                active={state.selectedId === room.id}
                                compact={!open}
                                onRequestDelete={onRequestDelete}
                            />
                        ))}
                    </div>
                )}
            </div>

            <div className={`flex items-center border-t py-2 ${open ? 'justify-between px-3' : 'justify-center'}`}>
                {open && (
                    <span className="text-[11px] leading-relaxed text-muted-foreground">
                        容器 = 一条对话；成员在容器内
                    </span>
                )}
                <button
                    onClick={onOpenSettings}
                    title="模型设置"
                    className="rounded p-1 text-muted-foreground hover:bg-muted"
                >
                    <Settings className="size-4" />
                </button>
            </div>
        </aside>
    );
}
