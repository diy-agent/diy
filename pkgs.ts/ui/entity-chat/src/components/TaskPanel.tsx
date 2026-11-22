// TaskPanel —— 任务页右侧的「任务」面板：编号 / 描述 / 正文 / 相关任务 / 日志 / 路径。
//
// 为什么在侧面而不是时间线里：任务正文是**背景**，不是聊天记录。放侧面板既能编辑，
// 又不会把正文塞进对话（也不会被压缩摘要当人话改写）。保存后变量树的下一次模型步
// 会带 `task.body` 增量，agent 立刻看到新值 —— 不需要重建 system。
//
// 相关任务是**平铺列表**（不画树）：关系只有 `related` / `blocks` / `duplicate`，
// 反向由服务端算（`linksOf` 给出入边），所以这里不需要维护双向。

import { roomTitle, type Room } from '../model';
import { X } from 'lucide-react';
import * as React from 'react';

import { actions, diy2, useRooms } from '../store';

function textOf(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function numberOf(room: Room): number | undefined {
    const value = room.data['number'];
    return typeof value === 'number' ? value : undefined;
}

/** 任务在列表里的显示名：`#12 标题`（编号是给人用的句柄） */
function taskLabel(room: Room): string {
    const number = numberOf(room);
    return number === undefined ? roomTitle(room) : `#${number} ${roomTitle(room)}`;
}

interface JournalEntry {
    seq: number;
    at: number;
    kind: string;
    text: string;
}

/** 服务端 `/links` 返回的一行：另一边 + 关系种类 + 显示名 */
interface LinkItem {
    id: string;
    kind: string;
    label: string;
    type: string;
}

const LINK_KINDS = [
    { value: 'related', label: '相关' },
    { value: 'blocks', label: '阻塞' },
    { value: 'duplicate', label: '重复' },
] as const;

function kindLabel(kind: string): string {
    return LINK_KINDS.find((item) => item.value === kind)?.label ?? kind;
}

function timeOf(at: number): string {
    const date = new Date(at);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function TaskPanel({ room, onClose }: { room: Room; onClose: () => void }) {
    const rooms = useRooms();
    const project = rooms.find((item) => item.id === room.data['projectId']);
    // 标题就是描述（2026-11-22 用户裁）：任务的短文本只有一个字段，不再分成
    // 「标题 + 一句话描述」两段 —— 列表里看到的那句、展开后改的那句，是同一句。
    const savedTitle = roomTitle(room);
    const savedBody = textOf(room.data['body']);
    const taskDir = textOf(room.data['taskDir']);
    const number = numberOf(room);

    const [title, setTitle] = React.useState(savedTitle);
    const [body, setBody] = React.useState(savedBody);
    const [saving, setSaving] = React.useState(false);
    const [note, setNote] = React.useState<string | null>(null);
    const [entries, setEntries] = React.useState<JournalEntry[]>([]);
    const [links, setLinks] = React.useState<{ out: LinkItem[]; in: LinkItem[] }>({ out: [], in: [] });
    const [target, setTarget] = React.useState('');
    const [kind, setKind] = React.useState<string>('related');
    const [linking, setLinking] = React.useState(false);
    const dirty = title !== savedTitle || body !== savedBody;

    // 切到另一个任务，或保存后 refresh 换了 room 对象：跟随已保存值
    React.useEffect(() => {
        setTitle(savedTitle);
        setBody(savedBody);
        setNote(null);
    }, [room.id, savedTitle, savedBody]);

    // 日志：agent 用 journal 工具写，面板只读；轮询（和 ContextPanel 同思路，不新增事件类型）
    React.useEffect(() => {
        let alive = true;
        const load = (): void => {
            void diy2.journal
                .list(room.id, 30)
                .then((body) => {
                    if (alive) setEntries((body.entries ?? []) as JournalEntry[]);
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

    // 关系：只在打开面板 / 自己改动后取一次（目前只有本面板写，没有别人的写入口）
    const loadLinks = React.useCallback((): void => {
        void diy2.links
            .list(room.id)
            .then((body) => {
                setLinks({ out: (body.out ?? []) as LinkItem[], in: (body.in ?? []) as LinkItem[] });
            })
            .catch(() => undefined);
    }, [room.id]);

    React.useEffect(() => {
        setTarget('');
        loadLinks();
    }, [room.id, loadLinks]);

    const save = async (): Promise<void> => {
        const nextTitle = title.trim();
        // 空标题 = 这个容器在列表里认不出来了（房间按 id 认人，人按名字认房间）
        if (nextTitle === '') {
            setNote('标题不能为空');
            return;
        }
        if (!dirty || saving) return;
        setSaving(true);
        setNote(null);
        try {
            await actions.updateRoomData(room.id, {
                // 名字跟着容器走：任务的名字在 data.title（老数据里那份 desc 也抬上来）
                title: nextTitle,
                body: body.trim() === '' ? null : body,
            });
            setNote('已保存');
        } catch {
            setNote('保存失败（内容还在）');
        } finally {
            setSaving(false);
        }
    };

    const addLink = async (): Promise<void> => {
        if (target === '' || linking) return;
        setLinking(true);
        try {
            await actions.addLink(room.id, target, kind);
            setTarget('');
            loadLinks();
        } catch {
            /* 全局错误已亮；保留选择让用户重试 */
        } finally {
            setLinking(false);
        }
    };

    const removeLink = async (link: LinkItem): Promise<void> => {
        try {
            await actions.removeLink(room.id, link.id, link.kind);
            loadLinks();
        } catch {
            /* 同上 */
        }
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void save();
        }
    };

    // 能关联的对象：其它任务（未来可放开到任意实体，服务端已按 id 校验）
    const others = rooms
        .filter((item) => item.type === 'task' && item.id !== room.id)
        .sort((a, b) => (numberOf(a) ?? 1e9) - (numberOf(b) ?? 1e9));

    return (
        <aside className="flex w-[340px] shrink-0 flex-col border-l">
            <header className="flex items-center gap-2 border-b px-3 py-2">
                <span className="text-[12px] font-medium">任务</span>
                {number !== undefined && (
                    <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">#{number}</span>
                )}
                <span className="truncate text-[11px] text-muted-foreground">{roomTitle(room)}</span>
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
                    标题（一句话：这个任务要做什么）
                    <input
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') void save();
                        }}
                        placeholder="任务名；侧栏与项目树显示的就是这一句"
                        className="mt-1 w-full rounded border bg-transparent p-2 text-[12px] text-foreground outline-none focus:border-ring"
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

                <div className="border-t pt-2">
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>相关任务</span>
                        <span>{links.out.length + links.in.length} 条</span>
                    </div>
                    <ul className="mt-1 space-y-1">
                        {links.out.length + links.in.length === 0 && (
                            <li className="text-[11px] text-muted-foreground">还没有关联</li>
                        )}
                        {links.out.map((link) => (
                            <LinkRow
                                key={`out:${link.kind}:${link.id}`}
                                link={link}
                                mark="→"
                                onOpen={() => actions.select(link.id)}
                                onRemove={() => void removeLink(link)}
                            />
                        ))}
                        {links.in.map((link) => (
                            <LinkRow
                                key={`in:${link.kind}:${link.id}`}
                                link={link}
                                mark="←"
                                onOpen={() => actions.select(link.id)}
                                onRemove={() => void removeLink(link)}
                            />
                        ))}
                    </ul>

                    <div className="mt-1 flex items-center gap-1">
                        <select
                            value={target}
                            onChange={(event) => setTarget(event.target.value)}
                            className="min-w-0 flex-1 rounded border bg-transparent px-1 py-0.5 text-[11px]"
                        >
                            <option value="">关联到…</option>
                            {others.map((item) => (
                                <option key={item.id} value={item.id}>
                                    {taskLabel(item)}
                                </option>
                            ))}
                        </select>
                        <select
                            value={kind}
                            onChange={(event) => setKind(event.target.value)}
                            className="rounded border bg-transparent px-1 py-0.5 text-[11px]"
                        >
                            {LINK_KINDS.map((item) => (
                                <option key={item.value} value={item.value}>
                                    {item.label}
                                </option>
                            ))}
                        </select>
                        <button
                            onClick={() => void addLink()}
                            disabled={target === '' || linking}
                            className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
                        >
                            {linking ? '…' : '＋'}
                        </button>
                    </div>
                </div>

                <div className="space-y-1 text-[11px] text-muted-foreground">
                    <div>状态：{textOf(room.data['status']) || 'open'}</div>
                    <div>项目：{project === undefined ? '—' : roomTitle(project)}</div>
                    <div className="break-all" title={taskDir}>
                        任务目录：{taskDir || '—'}
                    </div>
                    <div className="break-all">工作目录：{textOf(room.data['dir']) || '—'}</div>
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

function LinkRow({
    link,
    mark,
    onOpen,
    onRemove,
}: {
    link: LinkItem;
    mark: string;
    onOpen: () => void;
    onRemove: () => void;
}) {
    return (
        <li className="flex items-center gap-1 text-[11px]">
            <span className="text-muted-foreground">{mark}</span>
            <span className="rounded bg-muted px-1 text-[10px]">{kindLabel(link.kind)}</span>
            <button onClick={onOpen} className="min-w-0 flex-1 truncate text-left hover:underline" title={link.label}>
                {link.label}
            </button>
            <button onClick={onRemove} title="取消关联" className="rounded p-0.5 text-muted-foreground hover:bg-muted">
                <X className="size-3" />
            </button>
        </li>
    );
}
