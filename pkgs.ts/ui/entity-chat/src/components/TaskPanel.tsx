// TaskPanel —— 任务页右侧的「任务」面板：描述 / 正文 / 状态 / 目录。
//
// 为什么在侧面而不是时间线里：任务正文是**背景**，不是聊天记录。放侧面板既能编辑，
// 又不会把正文塞进对话（也不会被压缩摘要当人话改写）。保存后变量树的下一次模型步
// 会带 `task.body` 增量，agent 立刻看到新值 —— 不需要重建 system。

import type { Room } from '@diy-agent/chat-core';
import { X } from 'lucide-react';
import * as React from 'react';

import { actions, useRooms } from '../store';

function textOf(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

interface JournalEntry {
    seq: number;
    at: number;
    kind: string;
    text: string;
}

function timeOf(at: number): string {
    const date = new Date(at);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function TaskPanel({ room, onClose }: { room: Room; onClose: () => void }) {
    const rooms = useRooms();
    const project = rooms.find((item) => item.id === room.data['projectId']);
    const savedDesc = textOf(room.data['desc']);
    const savedBody = textOf(room.data['body']);

    const [desc, setDesc] = React.useState(savedDesc);
    const [body, setBody] = React.useState(savedBody);
    const [saving, setSaving] = React.useState(false);
    const [note, setNote] = React.useState<string | null>(null);
    const [entries, setEntries] = React.useState<JournalEntry[]>([]);
    const dirty = desc !== savedDesc || body !== savedBody;

    // 切到另一个任务，或保存后 refresh 换了 room 对象：跟随已保存值
    React.useEffect(() => {
        setDesc(savedDesc);
        setBody(savedBody);
        setNote(null);
    }, [room.id, savedDesc, savedBody]);

    // 日志：agent 用 journal 工具写，面板只读；轮询（和 ContextPanel 同思路，不新增事件类型）
    React.useEffect(() => {
        let alive = true;
        const load = (): void => {
            void fetch(`/api/rooms/${encodeURIComponent(room.id)}/journal?limit=30`)
                .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP'))))
                .then((body: { entries?: JournalEntry[] }) => {
                    if (alive) setEntries(body.entries ?? []);
                })
                .catch(() => undefined);
        };
        load();
        const timer = setInterval(load, 5000);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [room.id]);

    const save = async (): Promise<void> => {
        if (!dirty || saving) return;
        setSaving(true);
        setNote(null);
        try {
            await actions.updateRoomData(room.id, {
                desc: desc.trim() === '' ? null : desc,
                body: body.trim() === '' ? null : body,
            });
            setNote('已保存');
        } catch {
            setNote('保存失败（内容还在）');
        } finally {
            setSaving(false);
        }
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void save();
        }
    };

    return (
        <aside className="flex w-[340px] shrink-0 flex-col border-l">
            <header className="flex items-center gap-2 border-b px-3 py-2">
                <span className="text-[12px] font-medium">任务</span>
                <span className="truncate text-[11px] text-muted-foreground">{room.name}</span>
                <button
                    onClick={onClose}
                    title="收起"
                    className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted"
                >
                    <X className="size-3.5" />
                </button>
            </header>

            <div className="flex-1 space-y-3 overflow-y-auto p-3">
                <label className="block text-[11px] text-muted-foreground">
                    描述（一句话：这个任务要做什么）
                    <textarea
                        value={desc}
                        onChange={(event) => setDesc(event.target.value)}
                        onKeyDown={onKeyDown}
                        rows={3}
                        placeholder="任务简报；会作为 task.body 的一部分投给 agent"
                        className="mt-1 w-full resize-y rounded border bg-transparent p-2 text-[12px] text-foreground outline-none focus:border-ring"
                    />
                </label>

                <label className="block text-[11px] text-muted-foreground">
                    正文（方案 / 边界 / 验收口径）
                    <textarea
                        value={body}
                        onChange={(event) => setBody(event.target.value)}
                        onKeyDown={onKeyDown}
                        rows={14}
                        placeholder="长期信息写这里；改完保存，下一步 agent 只收到 task.body 增量"
                        className="mt-1 w-full resize-y rounded border bg-transparent p-2 font-mono text-[12px] text-foreground outline-none focus:border-ring"
                    />
                </label>

                <div className="space-y-1 text-[11px] text-muted-foreground">
                    <div>状态：{textOf(room.data['status']) || 'open'}</div>
                    <div>项目：{project?.name ?? '—'}</div>
                    <div className="break-all">目录：{textOf(room.data['dir']) || '—'}</div>
                </div>

                <div className="border-t pt-2">
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>日志</span>
                        <span>{entries.length} 条</span>
                    </div>
                    <ul className="mt-1 space-y-1">
                        {entries.length === 0 && (
                            <li className="text-[11px] text-muted-foreground">
                                还没有记录（agent 可用 journal 工具写决策 / 踩坑）
                            </li>
                        )}
                        {entries.map((entry) => (
                            <li key={entry.seq} className="text-[11px] leading-snug">
                                <span className="mr-1 text-muted-foreground">{timeOf(entry.at)}</span>
                                <span className="mr-1 rounded bg-muted px-1 text-[10px]">{entry.kind}</span>
                                <span>{entry.text}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>

            <footer className="flex items-center gap-2 border-t px-3 py-2">
                <button
                    onClick={() => void save()}
                    disabled={!dirty || saving}
                    className="rounded border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
                >
                    {saving ? '保存中…' : '保存'}
                </button>
                <span className="text-[10px] text-muted-foreground">
                    {note ?? (dirty ? '有未保存改动' : '⌘/Ctrl+Enter 保存')}
                </span>
            </footer>
        </aside>
    );
}
