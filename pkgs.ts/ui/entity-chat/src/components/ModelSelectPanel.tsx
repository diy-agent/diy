// ModelSelectPanel.tsx —— 统一的「模型选择」面板（三处同构）。
//
// 用户 2026-11-26 裁：默认模型配置 / bot 配置 / 聊天页配置 的模型选择要同构一致 ——
// 都是「点一下 → 弹出这张表格 → 选一个 account@provider/model 写回」。本文件是那一份。
//
// 2026-11-27 用户追加三件：
//   ① 每行一个「启用」开关（全选 / 全不选 = 批量启用禁用）—— 写回 model.yaml 的 filter；
//   ② 列选择器（可以显示多一些信息：模态 / 发布 / 更新 …）；
//   ③ 可分类字段做切片过滤（如「支持的 input 列表」）。
//
// 数据全从 useProviders()（目录，真源 model.yaml）：本组件不认识具体 provider，也不猜默认。

import * as React from 'react';

import { modelConfig } from '../modelConfig';
import type { ModelInfo } from '../models';
import { useDefaultModelKey, useProviders } from '../store';
import { Modal } from './Dialogs';

type SortKey = 'model' | 'account' | 'context' | 'input' | 'output' | 'cacheRead' | 'cacheWrite';

type ColKey =
    | 'enable'
    | 'model'
    | 'capability'
    | 'inputs'
    | 'account'
    | 'context'
    | 'input'
    | 'output'
    | 'cacheRead'
    | 'cacheWrite'
    | 'release'
    | 'updated';

interface ColDef {
    key: ColKey;
    label: string;
    /** 默认显示；其余在列选择器里勾出来 */
    def?: boolean;
    sort?: SortKey;
    align?: 'left' | 'right';
    /** 固定列：不可隐藏 */
    fixed?: boolean;
}

const COLUMNS: readonly ColDef[] = [
    { key: 'enable', label: '启用', def: true, fixed: true },
    { key: 'model', label: '模型', def: true, sort: 'model', fixed: true },
    { key: 'capability', label: '能力', def: true },
    { key: 'inputs', label: '模态' },
    { key: 'account', label: '账号', def: true, sort: 'account' },
    { key: 'context', label: '上下文', def: true, sort: 'context', align: 'right' },
    { key: 'input', label: 'in', def: true, sort: 'input', align: 'right' },
    { key: 'output', label: 'out', def: true, sort: 'output', align: 'right' },
    { key: 'cacheRead', label: '缓存读', sort: 'cacheRead', align: 'right' },
    { key: 'cacheWrite', label: '缓存写', sort: 'cacheWrite', align: 'right' },
    { key: 'release', label: '发布' },
    { key: 'updated', label: '更新' },
];

const DEFAULT_COLS = new Set(COLUMNS.filter((column) => column.def === true).map((column) => column.key));

interface Option {
    key: string; // account@provider/model
    providerId: string;
    providerName: string;
    account: string;
    modelId: string;
    modelName: string;
    /** 该行在目录里启用了吗（= model.yaml 的 filter 结果） */
    enabled: boolean;
    contextWindow?: number;
    cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
    /** 能力标记（目录透传；缺省 = 上游没声明） */
    capabilities?: ModelInfo['capabilities'];
}

/** 能力标签（紧凑：推理 / 视觉 / 工具 / 附件 / 结构化）；没声明 = — */
function capabilityText(capabilities: ModelInfo['capabilities']): string {
    if (capabilities === undefined) return '—';
    const out: string[] = [];
    if (capabilities.reasoning) out.push('推理');
    if (capabilities.vision) out.push('视觉');
    if (capabilities.toolCall) out.push('工具');
    if (capabilities.attachment) out.push('附件');
    if (capabilities.structuredOutput) out.push('结构化');
    return out.length === 0 ? '—' : out.join(' · ');
}

function contextLabel(n: number | undefined): string {
    if (n === undefined) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
    return `${String(Math.round(n / 1000))}K`;
}

/** 模态列表（模型支持哪些输入 / 输出）；空 = 上游没声明 */
function modalText(list: readonly string[] | undefined): string {
    return list === undefined || list.length === 0 ? '—' : list.join('/');
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
                    enabled: model.enabled ?? true,
                    contextWindow: model.contextWindow,
                    cost: model.cost,
                    capabilities: model.capabilities,
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
    /** 可见列（默认列 + 用户勾的） */
    const [cols, setCols] = React.useState<Set<ColKey>>(() => new Set(DEFAULT_COLS));
    /** 切片：模态（空 = 不过滤；选中的必须全部支持） */
    const [modals, setModals] = React.useState<Set<string>>(() => new Set());
    /** 开关写回中（避免连点把配置写乱） */
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string>();

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

    /** 目录里出现过的全部模态（切片候选项） */
    const modalOptions = React.useMemo(() => {
        const seen = new Set<string>();
        for (const option of options) {
            for (const input of option.capabilities?.inputs ?? []) seen.add(input);
        }
        return [...seen].sort();
    }, [options]);

    const keyword = query.trim().toLowerCase();
    const rows = React.useMemo(() => {
        const wanted = [...modals];
        const filtered = options.filter(
            (option) =>
                (account === '' || `${option.account}@${option.providerId}` === account) &&
                // 切片：模型必须支持选中的全部模态（AND）
                wanted.every((modal) => (option.capabilities?.inputs ?? []).includes(modal)) &&
                (keyword === '' ||
                    option.modelId.toLowerCase().includes(keyword) ||
                    option.modelName.toLowerCase().includes(keyword) ||
                    option.providerName.toLowerCase().includes(keyword) ||
                    option.key.toLowerCase().includes(keyword)),
        );
        const valueOf = (option: Option): string | number => {
            switch (sort.key) {
                case 'model':
                    return option.modelId;
                case 'account':
                    return `${option.account}@${option.providerId}`;
                case 'context':
                    return option.contextWindow ?? -1;
                case 'input':
                    return option.cost?.input ?? -1;
                case 'output':
                    return option.cost?.output ?? -1;
                case 'cacheRead':
                    return option.cost?.cacheRead ?? -1;
                case 'cacheWrite':
                    return option.cost?.cacheWrite ?? -1;
            }
        };
        return [...filtered].sort((a, b) => {
            const av = valueOf(a);
            const bv = valueOf(b);
            const cmp =
                typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
            return sort.desc ? -cmp : cmp;
        });
    }, [options, account, keyword, sort, modals]);

    // 打开时定位到当前模型所属账号（providers 异步到：等目录有了再定；用户手动切过就不再抢）
    const located = React.useRef(false);
    React.useEffect(() => {
        if (located.current) return;
        const hit = options.find((option) => option.key === current);
        if (hit !== undefined) {
            located.current = true;
            setAccount(`${hit.account}@${hit.providerId}`);
            return;
        }
        // 模型不在目录（下架 / 没勾选）：至少定位到它所属的账号，别让用户从「全部」里找
        if (current !== '') {
            const prefix = accounts.find((key) => current.startsWith(`${key}/`));
            if (prefix !== undefined) {
                located.current = true;
                setAccount(prefix);
            }
        }
    }, [options, current, accounts]);

    // 打开时把当前行滚到视口中央（只滚一次，之后用户自己排序 / 筛选不抢）
    const currentRowRef = React.useRef<HTMLTableRowElement | null>(null);
    const scrolled = React.useRef(false);
    React.useEffect(() => {
        if (scrolled.current || currentRowRef.current === null) return;
        scrolled.current = true;
        const id = requestAnimationFrame(() => currentRowRef.current?.scrollIntoView({ block: 'center' }));
        return () => cancelAnimationFrame(id);
    }, [rows]);

    /**
     * 批量改启用（全量重写该 provider 的 filter.exclude）：
     * 目录里 `enabled` 是 filter 的结果，写侧只有 include / exclude 两个键 ——
     * 用 exclude 把「不启用的模型」列出来（等价于默认全开 + 黑名单），
     * 全启用时把 filter 清空（`null` = 删键，不写空数组去冒充配置）。
     */
    const applyEnabled = React.useCallback(
        async (targets: readonly Option[], on: boolean): Promise<void> => {
            if (targets.length === 0 || saving) return;
            setSaving(true);
            setError(undefined);
            try {
                const byProvider = new Map<string, string[]>();
                for (const target of targets) {
                    const list = byProvider.get(target.providerId) ?? [];
                    list.push(target.modelId);
                    byProvider.set(target.providerId, list);
                }
                for (const [providerId, ids] of byProvider) {
                    const provider = providers.find((entry) => entry.id === providerId);
                    if (provider === undefined) continue;
                    const enabledIds = new Set(provider.models.filter((m) => m.enabled).map((m) => m.id));
                    for (const id of ids) {
                        if (on) enabledIds.add(id);
                        else enabledIds.delete(id);
                    }
                    const disabled = provider.models.map((m) => m.id).filter((id) => !enabledIds.has(id));
                    await modelConfig.saveProvider({
                        providerId,
                        filter: { include: null, exclude: disabled.length === 0 ? null : disabled },
                    });
                }
            } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
                setSaving(false);
            }
        },
        [providers, saving],
    );

    const toggleSort = (key: SortKey): void =>
        setSort((prev) => (prev.key === key ? { key, desc: !prev.desc } : { key, desc: false }));
    const mark = (key: SortKey): string => (sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : '');
    const money = (v: number | undefined): string => (v === undefined ? '—' : `$${v}`);
    const toggleCol = (key: ColKey): void =>
        setCols((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    const toggleModal = (modal: string): void =>
        setModals((prev) => {
            const next = new Set(prev);
            if (next.has(modal)) next.delete(modal);
            else next.add(modal);
            return next;
        });

    const visible = COLUMNS.filter((column) => column.fixed === true || cols.has(column.key));
    const canEnableAll = rows.some((row) => !row.enabled);
    const canDisableAll = rows.some((row) => row.enabled);
    const cell = (option: Option, key: ColKey): React.ReactNode => {
        switch (key) {
            case 'enable':
                return (
                    <button
                        type="button"
                        role="switch"
                        aria-checked={option.enabled}
                        aria-label={`${option.modelId} 启用`}
                        disabled={saving}
                        onClick={(event) => {
                            event.stopPropagation();
                            void applyEnabled([option], !option.enabled);
                        }}
                        className={`relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full border transition-colors ${
                            option.enabled ? 'border-primary bg-primary/80' : 'border-border bg-muted'
                        }`}
                    >
                        <span
                            className={`inline-block size-2.5 rounded-full bg-card transition-transform ${
                                option.enabled ? 'translate-x-3' : 'translate-x-0.5'
                            }`}
                        />
                    </button>
                );
            case 'model':
                return (
                    <>
                        <div className="truncate font-medium">{option.modelName}</div>
                        <code className="text-[10.5px] text-muted-foreground">{option.modelId}</code>
                    </>
                );
            case 'capability':
                return capabilityText(option.capabilities);
            case 'inputs':
                return (
                    <div className="space-y-0.5">
                        <div>入 {modalText(option.capabilities?.inputs)}</div>
                        <div className="text-[10px] text-muted-foreground">出 {modalText(option.capabilities?.outputs)}</div>
                    </div>
                );
            case 'account':
                return (
                    <span className="font-mono">
                        {option.account}@{option.providerId}
                    </span>
                );
            case 'context':
                return <span className="tabular-nums">{contextLabel(option.contextWindow)}</span>;
            case 'input':
                return <span className="tabular-nums">{money(option.cost?.input)}</span>;
            case 'output':
                return <span className="tabular-nums">{money(option.cost?.output)}</span>;
            case 'cacheRead':
                return <span className="tabular-nums">{money(option.cost?.cacheRead)}</span>;
            case 'cacheWrite':
                return <span className="tabular-nums">{money(option.cost?.cacheWrite)}</span>;
            case 'release':
                return option.capabilities?.releaseDate ?? '—';
            case 'updated':
                return option.capabilities?.lastUpdated ?? '—';
        }
    };

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
                            account === ''
                                ? 'border-ring bg-muted font-medium'
                                : 'border-border text-muted-foreground hover:bg-muted/60'
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
                                account === key
                                    ? 'border-ring bg-muted font-medium'
                                    : 'border-border text-muted-foreground hover:bg-muted/60'
                            }`}
                        >
                            {key}
                        </button>
                    ))}
                </div>
                {modalOptions.length === 0 ? null : (
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] text-muted-foreground">输入模态</span>
                        {modalOptions.map((modal) => (
                            <button
                                key={modal}
                                type="button"
                                aria-pressed={modals.has(modal)}
                                onClick={() => toggleModal(modal)}
                                className={`rounded-full border px-2 py-0.5 text-[11px] ${
                                    modals.has(modal)
                                        ? 'border-ring bg-muted font-medium'
                                        : 'border-border text-muted-foreground hover:bg-muted/60'
                                }`}
                            >
                                {modal}
                            </button>
                        ))}
                        {modals.size === 0 ? null : (
                            <button
                                type="button"
                                onClick={() => setModals(new Set())}
                                className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/60"
                            >
                                清除
                            </button>
                        )}
                    </div>
                )}
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground">列</span>
                    {COLUMNS.filter((column) => column.fixed !== true).map((column) => (
                        <button
                            key={column.key}
                            type="button"
                            aria-pressed={cols.has(column.key)}
                            onClick={() => toggleCol(column.key)}
                            className={`rounded-full border px-1.5 py-0.5 text-[11px] ${
                                cols.has(column.key)
                                    ? 'border-ring bg-muted font-medium'
                                    : 'border-border text-muted-foreground hover:bg-muted/60'
                            }`}
                        >
                            {column.label}
                        </button>
                    ))}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="text-muted-foreground">
                        共 {rows.length} 行 · 启用 {rows.filter((row) => row.enabled).length}
                    </span>
                    <button
                        type="button"
                        disabled={saving || !canEnableAll}
                        onClick={() => void applyEnabled(rows, true)}
                        className="rounded border border-border px-2 py-0.5 hover:bg-muted/60 disabled:opacity-40"
                    >
                        全选
                    </button>
                    <button
                        type="button"
                        disabled={saving || !canDisableAll}
                        onClick={() => void applyEnabled(rows, false)}
                        className="rounded border border-border px-2 py-0.5 hover:bg-muted/60 disabled:opacity-40"
                    >
                        全不选
                    </button>
                    {saving ? <span className="text-muted-foreground">写入中…</span> : null}
                    {error === undefined ? null : (
                        <span className="max-w-[280px] truncate text-destructive" title={error}>
                            {error}
                        </span>
                    )}
                </div>
                {rows.length === 0 ? (
                    <p className="py-2 text-xs text-muted-foreground">没有匹配的模型 —— 放宽筛选，或先去配置页勾选模型。</p>
                ) : (
                    <div className="max-h-[54vh] overflow-auto rounded-lg border border-border">
                        <table className="w-full min-w-[640px] text-left text-xs">
                            <thead className="sticky top-0 bg-muted/80 text-[11px] text-muted-foreground backdrop-blur">
                                <tr>
                                    {visible.map((column) => (
                                        <th
                                            key={column.key}
                                            className={`whitespace-nowrap py-1.5 ${
                                                column.align === 'right' ? 'text-right' : 'text-left'
                                            } ${column.key === 'enable' || column.key === 'model' ? 'pl-2' : ''} ${
                                                column.key === 'updated' ? 'pr-2' : ''
                                            }`}
                                        >
                                            {column.sort === undefined ? (
                                                column.label
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={() => toggleSort(column.sort!)}
                                                    className="hover:text-foreground"
                                                >
                                                    {column.label}
                                                    {mark(column.sort)}
                                                </button>
                                            )}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((option) => (
                                    <tr
                                        key={option.key}
                                        ref={option.key === current ? currentRowRef : undefined}
                                        onClick={() => onPick(option.key)}
                                        className={`cursor-pointer border-t border-border/60 hover:bg-muted/40 ${
                                            option.key === current ? 'bg-muted' : ''
                                        } ${option.enabled ? '' : 'opacity-55'}`}
                                    >
                                        {visible.map((column) => (
                                            <td
                                                key={column.key}
                                                className={`py-1 align-top ${
                                                    column.align === 'right' ? 'text-right' : 'text-left'
                                                } ${column.key === 'enable' || column.key === 'model' ? 'pl-2' : ''} ${
                                                    column.key === 'updated' ? 'pr-2' : ''
                                                } ${
                                                    column.key === 'model'
                                                        ? ''
                                                        : 'text-[10.5px] text-muted-foreground'
                                                }`}
                                            >
                                                {cell(option, column.key)}
                                            </td>
                                        ))}
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
