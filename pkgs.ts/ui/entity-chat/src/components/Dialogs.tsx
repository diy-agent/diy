import * as React from 'react';

import { DIR_SUGGESTIONS, type Bot, type Entity } from '../model';
import { useStore } from '../store';
import { ModelPicker } from './ModelPicker';

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
            <div className="w-full max-w-md rounded-xl border bg-background p-4" onClick={(event) => event.stopPropagation()}>
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
                            <button key={item} onClick={() => setDir(item)} className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted">
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

export function CreateBotDialog({
    entity,
    onClose,
    onPickExisting,
    onCreateNew,
}: {
    entity: Entity;
    onClose: () => void;
    onPickExisting: (botId: string) => void;
    onCreateNew: (name: string) => void;
}) {
    const state = useStore();
    const [name, setName] = React.useState('');

    const available: Bot[] = Object.values(state.bots).filter((bot) => !entity.botIds.includes(bot.id));
    const homeName = (bot: Bot): string => {
        const home = state.entities.find((item) => item.id === bot.entityId);
        if (home === undefined) return '?';
        return `${home.kind === 'project' ? '项目' : '任务'}「${home.name}」`;
    };

    return (
        <Modal title={`给「${entity.name}」添加 bot`} onClose={onClose}>
            <div className="space-y-4 text-sm">
                <div>
                    <div className="mb-1.5 text-xs text-muted-foreground">从现有 bot 里选</div>
                    {available.length === 0 ? (
                        <p className="rounded-lg border border-dashed px-2 py-2 text-xs text-muted-foreground">还没有其他 bot，可以在下面新建一个。</p>
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
                                    <span className="ml-auto truncate text-[11px] text-muted-foreground">来自 {homeName(bot)}</span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                <div className="border-t pt-3">
                    <div className="mb-1.5 text-xs text-muted-foreground">或者新建一个 bot</div>
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
                    <p className="mt-1.5 text-[11px] text-muted-foreground">新建的 bot 归当前{entity.kind === 'project' ? '项目' : '任务'}所有。</p>
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
                    <p>provider = 端点 + 账户列表 + 模型目录；key = <code>account@provider/model</code>。</p>
                    <p>每个实体和 bot 都可以在头部单独覆盖模型；这里只改"新建设备"的默认值。</p>
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
