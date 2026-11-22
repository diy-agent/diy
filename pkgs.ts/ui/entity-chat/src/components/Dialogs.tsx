import * as React from 'react';

import { DIR_SUGGESTIONS, roomTitle, roomTypeLabel, type Bot, type Room } from '../model';
import { useStore } from '../store';
import { ModelPicker } from './ModelPicker';

/**
 * 弹窗外壳：点遮罩 / Esc 关闭（Esc 挂在 document 上 —— 弹窗里的 input 不一定拿得到焦点）。
 * `size` 默认 md；`wide` 留给需要多条表格列的弹窗（28rem 塞不下四列）。
 */
export function Modal({
    title,
    children,
    onClose,
    size = 'md',
}: {
    title: string;
    children: React.ReactNode;
    onClose: () => void;
    size?: 'md' | 'wide';
}) {
    React.useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
            <div
                className={`w-full rounded-xl border bg-background p-4 ${size === 'wide' ? 'max-w-3xl' : 'max-w-md'}`}
                onClick={(event) => event.stopPropagation()}
            >
                <h2 className="mb-3 text-sm font-semibold">{title}</h2>
                {children}
            </div>
        </div>
    );
}

export function CreateProjectDialog({
    onClose,
    onSubmit,
}: {
    onClose: () => void;
    onSubmit: (input: { name: string; dir: string }) => void;
}) {
    const [name, setName] = React.useState('');
    const [dir, setDir] = React.useState(DIR_SUGGESTIONS[0] ?? '');

    return (
        <Modal title="从本机目录新建项目" onClose={onClose}>
            <div className="space-y-3 text-sm">
                <label className="block">
                    <span className="mb-1 block text-xs text-muted-foreground">项目名</span>
                    <input
                        autoFocus
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="例如 diy"
                        className="w-full rounded-lg border bg-card px-2 py-1.5 outline-none"
                    />
                </label>
                <label className="block">
                    <span className="mb-1 block text-xs text-muted-foreground">目录</span>
                    <input
                        value={dir}
                        onChange={(event) => setDir(event.target.value)}
                        className="w-full rounded-lg border bg-card px-2 py-1.5 font-mono text-xs outline-none"
                    />
                    <div className="mt-1.5 flex flex-wrap gap-1">
                        {DIR_SUGGESTIONS.map((item) => (
                            <button
                                key={item}
                                onClick={() => setDir(item)}
                                className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                            >
                                {item}
                            </button>
                        ))}
                    </div>
                </label>
                <p className="rounded-lg border border-dashed px-2 py-1.5 text-[11px] text-muted-foreground">
                    会同时创建这个项目的 bot，名字 = 项目名（项目专属，不是全局 bot）
                </p>
            </div>
            <div className="mt-4 flex justify-end gap-2">
                <button onClick={onClose} className="rounded-lg border px-3 py-1.5 text-sm">
                    取消
                </button>
                <button
                    disabled={name.trim() === '' || dir.trim() === ''}
                    onClick={() => {
                        onSubmit({ name: name.trim(), dir: dir.trim() });
                        onClose();
                    }}
                    className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
                >
                    创建
                </button>
            </div>
        </Modal>
    );
}

/**
 * 新建任务。
 *
 * **描述进草稿，任务名不进**：描述是长文本，误关一次就白写；任务名几个字、而且默认值
 * 是「新任务 N」这种跟着上下文变的东西 —— 存下来的旧名字反而会盖掉新的建议。
 * 草稿 owner 是 `dlg:create-task:<projectId>`（synthetic scope）：任务还不存在，
 * 没有实体 id 可挂。提交 / 明确取消才清，点外面或 Esc 关掉保留（那是误关）。
 */
export function CreateTaskDialog({
    project,
    suggestedName,
    onClose,
    onSubmit,
}: {
    project: Room;
    suggestedName: string;
    onClose: () => void;
    /** 成功才 resolve：失败时草稿要留着（见 submit） */
    onSubmit: (input: { name: string }) => void | Promise<void>;
}) {
    const [name, setName] = React.useState(suggestedName);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    // 标题就是描述（2026-11-22）：不再有「任务名 + 可选描述」两栏 —— 建任务时写的那句
    // 就是它的标题，也是它在侧栏/项目树里显示的那句。长内容留给建成后的正文。
    const submit = (): void => {
        if (name.trim() === '' || busy) return;
        setBusy(true);
        setError(null);
        void Promise.resolve(onSubmit({ name: name.trim() }))
            .then(() => onClose())
            .catch(() => {
                setError('创建失败');
                setBusy(false);
            });
    };

    return (
        <Modal title={`在「${roomTitle(project)}」下新建任务`} onClose={onClose}>
            <div className="space-y-3 text-sm">
                <label className="block">
                    <span className="mb-1 block text-xs text-muted-foreground">任务名（一句话：这个任务要做什么）</span>
                    <input
                        autoFocus
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        onFocus={(event) => event.currentTarget.select()}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') submit();
                        }}
                        placeholder="要做到什么程度算完成…"
                        className="w-full rounded-lg border bg-card px-2 py-1.5 outline-none"
                    />
                </label>
                {error !== null && (
                    <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px]">
                        {error}
                    </p>
                )}
                <p className="rounded-lg border border-dashed px-2 py-1.5 text-[11px] text-muted-foreground">
                    会自动建一个同名任务 bot；状态默认 open，点名字前的状态图标改成
                    closed，它就从项目树挪进「历史任务」。
                </p>
            </div>
            <div className="mt-4 flex justify-end gap-2">
                <button onClick={onClose} className="rounded-lg border px-3 py-1.5 text-sm">
                    取消
                </button>
                <button
                    disabled={name.trim() === '' || busy}
                    onClick={submit}
                    className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
                >
                    创建
                </button>
            </div>
        </Modal>
    );
}

/** 删除确认（硬删，不可撤销）：项目要报出会连带几个任务 */
export function ConfirmDeleteDialog({
    room,
    taskCount,
    onClose,
    onConfirm,
}: {
    room: Room;
    taskCount: number;
    onClose: () => void;
    onConfirm: () => void;
}) {
    const isProject = room.type === 'project';
    return (
        <Modal title={`删除${isProject ? '项目' : '任务'}「${roomTitle(room)}」`} onClose={onClose}>
            <div className="space-y-2 text-sm">
                <p>
                    会删掉这个{isProject ? '项目' : '任务'}的对话记录、成员关系和会话快照，
                    <span className="font-medium">不可撤销</span>。
                </p>
                {isProject && (
                    <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs">
                        它下面的 {taskCount} 个任务会一起删掉。
                    </p>
                )}
                <p className="text-[11px] text-muted-foreground">
                    专属 bot 一并清掉；被其他容器借用的 bot 不动。仓库里的文件不删。
                </p>
            </div>
            <div className="mt-4 flex justify-end gap-2">
                <button onClick={onClose} className="rounded-lg border px-3 py-1.5 text-sm">
                    取消
                </button>
                <button
                    onClick={() => {
                        onConfirm();
                        onClose();
                    }}
                    className="rounded-lg bg-destructive px-3 py-1.5 text-sm text-white"
                >
                    删除
                </button>
            </div>
        </Modal>
    );
}

export function AddMemberDialog({
    room,
    onClose,
    onPickExisting,
    onCreateNew,
}: {
    room: Room;
    onClose: () => void;
    onPickExisting: (botId: string) => void;
    onCreateNew: (name: string) => void;
}) {
    const state = useStore();
    const [name, setName] = React.useState('');

    const available: Bot[] = Object.values(state.bots).filter(
        (bot) => !room.members.some((member) => member.botId === bot.id),
    );
    const homeName = (bot: Bot): string => {
        const home = state.rooms.find((item) => item.id === bot.homeRoomId);
        if (home === undefined) return '?';
        return `${roomTypeLabel(home.type)}「${roomTitle(home)}」`;
    };

    return (
        <Modal title={`给「${roomTitle(room)}」添加成员`} onClose={onClose}>
            <div className="space-y-4 text-sm">
                <div>
                    <div className="mb-1.5 text-xs text-muted-foreground">从现有成员里选</div>
                    {available.length === 0 ? (
                        <p className="rounded-lg border border-dashed px-2 py-2 text-xs text-muted-foreground">
                            还没有其他成员，可以在下面新建一个。
                        </p>
                    ) : (
                        <div className="max-h-48 space-y-1 overflow-y-auto">
                            {available.map((bot) => (
                                <button
                                    key={bot.id}
                                    onClick={() => {
                                        onPickExisting(bot.id);
                                        onClose();
                                    }}
                                    className="flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left hover:bg-muted"
                                >
                                    <span className="size-2 shrink-0 rounded-full" style={{ background: bot.color }} />
                                    <span className="font-medium">{bot.name}</span>
                                    <span className="ml-auto truncate text-[11px] text-muted-foreground">
                                        来自 {homeName(bot)}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                <div className="border-t pt-3">
                    <div className="mb-1.5 text-xs text-muted-foreground">或者新建一个成员 bot</div>
                    <div className="flex gap-2">
                        <input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="例如 小满"
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' && name.trim() !== '') {
                                    onCreateNew(name);
                                    onClose();
                                }
                            }}
                            className="flex-1 rounded-lg border bg-card px-2 py-1.5 outline-none"
                        />
                        <button
                            disabled={name.trim() === ''}
                            onClick={() => {
                                onCreateNew(name);
                                onClose();
                            }}
                            className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
                        >
                            新建
                        </button>
                    </div>
                    <p className="mt-1.5 text-[11px] text-muted-foreground">
                        新建的 bot 是当前容器的成员；@ 它才会说话，默认仍由「默认应答」回。
                    </p>
                </div>
            </div>

            <div className="mt-4 flex justify-end">
                <button onClick={onClose} className="rounded-lg border px-3 py-1.5 text-sm">
                    关闭
                </button>
            </div>
        </Modal>
    );
}

export function ModelDialog({
    title,
    value,
    onChange,
    onClose,
}: {
    title: string;
    value: string;
    onChange: (key: string) => void;
    onClose: () => void;
}) {
    return (
        <Modal title={title} onClose={onClose}>
            <ModelPicker value={value} onChange={onChange} />
            <div className="mt-4 flex justify-end">
                <button onClick={onClose} className="rounded-lg border px-3 py-1.5 text-sm">
                    完成
                </button>
            </div>
        </Modal>
    );
}

export function SettingsDialog({
    defaultModelKey,
    onChangeDefault,
    onClose,
}: {
    defaultModelKey: string;
    onChangeDefault: (key: string) => void;
    onClose: () => void;
}) {
    return (
        <Modal title="模型设置" onClose={onClose}>
            <div className="space-y-3 text-sm">
                <div>
                    <div className="mb-1 text-xs text-muted-foreground">默认模型（新建任务 / 项目 / bot 都继承它）</div>
                    <ModelPicker value={defaultModelKey} onChange={onChangeDefault} />
                </div>

                <div className="rounded-lg border border-dashed p-2 text-[11px] leading-relaxed text-muted-foreground">
                    <p className="mb-1 font-medium text-foreground">当前目录（照 diy 的 provider 结构）</p>
                    <p>
                        provider = 端点 + 账户列表 + 模型目录；key = <code>account@provider/model</code>。
                    </p>
                    <p>每个容器和 bot 都可以在头部单独覆盖模型；这里只改"新建容器"的默认值。</p>
                </div>
            </div>
            <div className="mt-4 flex justify-end">
                <button onClick={onClose} className="rounded-lg border px-3 py-1.5 text-sm">
                    完成
                </button>
            </div>
        </Modal>
    );
}
