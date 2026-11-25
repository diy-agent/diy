// ModelSelectPanel.tsx —— 统一的「模型选择」搜索面板（三处同构）。
//
// 用户 2026-11-26 裁：默认模型配置 / bot 配置 / 聊天页配置 的模型选择要同构一致 ——
// 都是「点一下 → 弹出这张表格 → 选一个 account@provider/model 写回」。本文件是那一份,
// 三处只传 current + onPick，不各写一份表格。
//
// 数据全从 useProviders()（目录，真源 model.yaml）：本组件不认识具体 provider，也不猜默认。
// 表格：搜索 + 已连接账号按钮筛选（默认「全部」）+ 各列可排序；显示 account@provider/model 全称。

import { Modal } from './Dialogs';
import { useDefaultModelKey, useProviders } from '../store';
import * as React from 'react';

type SortKey = 'model' | 'account' | 'context' | 'input' | 'output' | 'cacheRead' | 'cacheWrite';

interface Option {
    key: string; // account@provider/model
    providerId: string;
    providerName: string;
    account: string;
    modelId: string;
    modelName: string;
    contextWindow?: number;
    cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

function contextLabel(n: number | undefined): string {
    if (n === undefined) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
    return `${String(Math.round(n / 1000))}K`;
}

function buildOptions(providers: ReturnType<typeof useProviders>): Option[] {
    const out: Option[] = [];
    for (const provider of providers) {
        for (const account of provider.accounts) {
            if (!account.configured) continue;
            for (const model of provider.models) {
                out.push({
                    key: `${account.name}@${provider.id}/${model.id}`,
                    providerId: provider.id,
                    providerName: provider.name,
                    account: account.name,
                    modelId: model.id,
                    modelName: model.name,
                    contextWindow: model.contextWindow,
                    cost: model.cost,
                });
            }
        }
    }
    return out;
}

export function ModelSelectPanel({
    title = '选择模型',
    current,
    onPick,
    onClose,
}: {
    title?: string;
    /** 当前 modelKey（account@provider/model）；空串 = 跟随默认 */
    current: string;
    onPick: (key: string) => void;
    onClose: () => void;
}) {
    const providers = useProviders();
    const options = React.useMemo(() => buildOptions(providers), [providers]);
    const [query, setQuery] = React.useState('');
    const [account, setAccount] = React.useState('');
    const [sort, setSort] = React.useState<{ key: SortKey; desc: boolean }>({ key: 'model', desc: false });

    const accounts = React.useMemo(() => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const option of options) {
            const key = `${option.account}@${option.providerId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(key);
        }
        return out;
    }, [options]);

    const keyword = query.trim().toLowerCase();
    const rows = React.useMemo(() => {
        const filtered = options.filter(
            (option) =>
                (account === '' || `${option.account}@${option.providerId}` === account) &&
                (keyword === '' ||
                    option.modelId.toLowerCase().includes(keyword) ||
                    option.modelName.toLowerCase().includes(keyword) ||
                    option.providerName.toLowerCase().includes(keyword) ||
                    option.key.toLowerCase().includes(keyword)),
        );
        const valueOf = (option: Option): string | number => {
            switch (sort.key) {
                case 'model': return option.modelId;
                case 'account': return `${option.account}@${option.providerId}`;
                case 'context': return option.contextWindow ?? -1;
                case 'input': return option.cost?.input ?? -1;
                case 'output': return option.cost?.output ?? -1;
                case 'cacheRead': return option.cost?.cacheRead ?? -1;
                case 'cacheWrite': return option.cost?.cacheWrite ?? -1;
            }
        };
        return [...filtered].sort((a, b) => {
            const av = valueOf(a);
            const bv = valueOf(b);
            const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
            return sort.desc ? -cmp : cmp;
        });
    }, [options, account, keyword, sort]);

    const toggleSort = (key: SortKey): void =>
        setSort((prev) => (prev.key === key ? { key, desc: !prev.desc } : { key, desc: false }));
    const mark = (key: SortKey): string => (sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : '');
    const money = (v: number | undefined): string => (v === undefined ? '—' : `$${v}`);

    return (
        <Modal title={title} onClose={onClose} size="wide">
            <div className="space-y-2">
                <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索模型 / 服务商"
                    className="w-full rounded border border-border bg-card px-2 py-1 text-xs outline-none"
                />
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground">账号</span>
                    <button
                        type="button"
                        aria-pressed={account === ''}
                        onClick={() => setAccount('')}
                        className={`rounded-full border px-2 py-0.5 text-[11px] ${
                            account === '' ? 'border-ring bg-muted font-medium' : 'border-border text-muted-foreground hover:bg-muted/60'
                        }`}
                    >
                        全部
                    </button>
                    {accounts.map((key) => (
                        <button
                            key={key}
                            type="button"
                            aria-pressed={account === key}
                            onClick={() => setAccount(key)}
                            className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${
                                account === key ? 'border-ring bg-muted font-medium' : 'border-border text-muted-foreground hover:bg-muted/60'
                            }`}
                        >
                            {key}
                        </button>
                    ))}
                </div>
                {rows.length === 0 ? (
                    <p className="py-2 text-xs text-muted-foreground">没有可选的模型 —— 先在配置页填账号、勾选模型。</p>
                ) : (
                    <div className="max-h-[54vh] overflow-auto rounded-lg border border-border">
                        <table className="w-full min-w-[640px] text-left text-xs">
                            <thead className="sticky top-0 bg-muted/80 text-[11px] text-muted-foreground backdrop-blur">
                                <tr>
                                    <th className="py-1.5 pl-2"><button type="button" onClick={() => toggleSort('model')} className="hover:text-foreground">模型{mark('model')}</button></th>
                                    <th className="py-1.5"><button type="button" onClick={() => toggleSort('account')} className="hover:text-foreground">账号{mark('account')}</button></th>
                                    <th className="py-1.5 text-right"><button type="button" onClick={() => toggleSort('context')} className="hover:text-foreground">上下文{mark('context')}</button></th>
                                    <th className="py-1.5 text-right"><button type="button" onClick={() => toggleSort('input')} className="hover:text-foreground">in{mark('input')}</button></th>
                                    <th className="py-1.5 text-right"><button type="button" onClick={() => toggleSort('output')} className="hover:text-foreground">out{mark('output')}</button></th>
                                    <th className="py-1.5 text-right"><button type="button" onClick={() => toggleSort('cacheRead')} className="hover:text-foreground">缓存读{mark('cacheRead')}</button></th>
                                    <th className="py-1.5 pr-2 text-right"><button type="button" onClick={() => toggleSort('cacheWrite')} className="hover:text-foreground">缓存写{mark('cacheWrite')}</button></th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((option) => (
                                    <tr
                                        key={option.key}
                                        onClick={() => onPick(option.key)}
                                        className={`cursor-pointer border-t border-border/60 hover:bg-muted/40 ${option.key === current ? 'bg-muted' : ''}`}
                                    >
                                        <td className="py-1 pl-2">
                                            <div className="truncate font-medium">{option.modelName}</div>
                                            <code className="text-[10.5px] text-muted-foreground">{option.modelId}</code>
                                        </td>
                                        <td className="py-1 font-mono text-[10.5px] text-muted-foreground">{option.account}@{option.providerId}</td>
                                        <td className="py-1 text-right tabular-nums text-muted-foreground">{contextLabel(option.contextWindow)}</td>
                                        <td className="py-1 text-right tabular-nums text-muted-foreground">{money(option.cost?.input)}</td>
                                        <td className="py-1 text-right tabular-nums text-muted-foreground">{money(option.cost?.output)}</td>
                                        <td className="py-1 text-right tabular-nums text-muted-foreground">{money(option.cost?.cacheRead)}</td>
                                        <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">{money(option.cost?.cacheWrite)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </Modal>
    );
}

/**
 * 极简模型胶囊：显示 `account@provider/model`，点开 ModelSelectPanel。
 * 三处同构的 L1 入口 —— 只显示与触发，不认识数据从哪来。
 */
export function ModelSelectButton({
    value,
    onPick,
    emptyText,
}: {
    value: string;
    onPick: (key: string) => void;
    /** 空值时的文案。不传 = 「跟随默认 · 当前值」；传了就用它（默认模型配置页用「未设置」）*/
    emptyText?: string;
}) {
    const [open, setOpen] = React.useState(false);
    const defaultKey = useDefaultModelKey();
    // 空 = 跟随全局默认：把当前实际生效的默认值显示出来，别只说「跟随」让人猜
    const shown =
        value === ''
            ? emptyText !== undefined
                ? emptyText
                : defaultKey === ''
                  ? '跟随全局默认（还没配）'
                  : `跟随默认 · ${defaultKey}`
            : value;
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                title={value === '' ? `跟随全局默认：${defaultKey === '' ? '还没配' : defaultKey}` : value}
                className="max-w-full truncate rounded border border-border px-2 py-0.5 text-left font-mono text-[11px] hover:border-ring hover:bg-muted"
            >
                {shown}
            </button>
            {open ? (
                <ModelSelectPanel
                    current={value}
                    onPick={(key) => {
                        setOpen(false);
                        onPick(key);
                    }}
                    onClose={() => setOpen(false)}
                />
            ) : null}
        </>
    );
}
