// BotsOverlay —— 「每个 bot 现在什么状态」的二级浮层 + 三级全量表格。
//
// 用户 2026-11-25 定的形状（两个都要分二级 / 三级，与作业 chip 同一套披露）：
//   L2 浮层：只列**要人看见的** —— 在跑 / 等你回答 / 上一轮出错（`needsYou`），
//           每行一句话 + 一个「继续」；空了就写「都闲着」。
//   L3 抽屉：所有房间 × 所有 bot 一张表，可筛选、可多选、可批量「继续」。
//           **默认筛选值与 L2 一致**（非空闲）—— 点进来看到的就是刚才那张弹层的全集，
//           只是多了列和批量动作，不是换一个世界。
//
// 两处口径都由 `bots.ts` 的 `needsYou` / `sortRows` 给：一处数据一处口径，
// 数字与行不会各说各话。

import { ChevronRight, Loader2, Play, X } from 'lucide-react';
import * as React from 'react';

import type { BotRow } from '@diy-agent/chat-transport-rpc';

import {
    ATTENTION_DOT,
    ATTENTION_INK,
    ATTENTION_TEXT,
    attentionLabelOf,
    attentionOf,
    countByAttention,
    type AttentionKind,
    type BotRowsState,
    fmtAt,
    outcomeTextOf,
    sortRows,
    STATE_TEXT,
    visibleInOverlay,
} from '../bots';
import { diy2 } from '../store';

/** 筛选 = 关注度词表（与标题栏徽标同一套词，点哪个就看哪一类） */
export type Filter = 'all' | AttentionKind;

/**
 * 筛选钮（**带数字**）：数字与徽标、与 tab 都从 `countByAttention` 来 —— 三处读一份，
 * 不会再出现「标题栏 4、点开是 5」。
 */
function filterItems(counts: ReturnType<typeof countByAttention>): Array<{ id: Filter; label: string; dot?: string }> {
    const item = (id: Filter, label: string, dot?: string): { id: Filter; label: string; dot?: string } => ({
        id,
        label,
        ...(dot === undefined ? {} : { dot }),
    });
    // 不再有「要看的 N」那一筛（用户 2026-11-26：删掉）：它就是「非空闲」，与下面五类
    // 重复——同一批人用两个名字叫，反而让人算不清。要看的就是「除了空闲」这类，
    // 二级浮层已经专门在干这件事（`visibleInOverlay`）。
    const items: Array<{ id: Filter; label: string; dot?: string }> = [
        item('all', `全部 ${counts.broken + counts.blocked + counts.queued + counts.live + counts.idle}`),
    ];
    for (const kind of ['broken', 'blocked', 'queued', 'live', 'idle'] as const) {
        // 空的类不占位（连「出错 0」也不画：一颗永远可能是 0 的筛选钮只会占地方、让人以为有问题）
        if (counts[kind] === 0) continue;
        items.push(item(kind, `${ATTENTION_TEXT[kind]} ${counts[kind]}`, ATTENTION_DOT[kind]));
    }
    return items;
}

function matches(row: BotRow, filter: Filter): boolean {
    if (filter === 'all') return true;
    return attentionOf(row) === filter;
}

/** 重试成功后给一句人话（服务端会说跳过了谁、为什么） */
function retryReport(back: {
    started: Array<{ roomId: string; botIds: string[] }>;
    skipped: Array<{ roomId: string; botId: string; reason: string }>;
}): string {
    const sent = back.started.reduce((sum, item) => sum + item.botIds.length, 0);
    if (sent === 0) {
        const why = back.skipped[0]?.reason;
        return why === undefined ? '没有可重试的' : `没发出去：${why}`;
    }
    const skipped = back.skipped.length;
    return skipped === 0 ? `已发「继续」给 ${sent} 个 bot` : `已发 ${sent} 个，跳过 ${skipped} 个`;
}

// ─── 行 ───────────────────────────────────────────────────────────

function StateDot({ row }: { row: BotRow }) {
    const kind = attentionOf(row);
    // 排队是「系统在你不用管」：灰 + 转，跟绿色呼吸的「在跑」长得不一样（不是一回事）
    if (kind === 'queued') return <Loader2 className={`size-3 shrink-0 animate-spin ${ATTENTION_INK.queued}`} />;
    return <span className={`size-1.5 shrink-0 rounded-full ${ATTENTION_DOT[kind]}`} />;
}

/** 二级浮层的一行：谁、在哪、要你干什么 */
function BriefRow({ row, onRetry }: { row: BotRow; onRetry: (row: BotRow) => void }) {
    const kind = attentionOf(row);
    const canRetry = kind === 'broken';
    // 一眼看懂「谁 / 在哪 / 这一行属于哪一类」：出错的写为什么，排队的写排了几条
    // 出错的写「为什么」（结局即原因），其余写关注度标签（在跑时会带上排队数）
    const detail = kind === 'broken' ? outcomeTextOf(row) : attentionLabelOf(row);
    return (
        <div className="flex items-center gap-2 px-3 py-1.5">
            <StateDot row={row} />
            <span className="truncate text-[11px] font-medium" style={{ color: row.botColor }}>
                {row.botName}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">{row.roomTitle}</span>
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{detail}</span>
            {canRetry ? (
                <button
                    onClick={() => onRetry(row)}
                    title="发一条「继续」接着干"
                    className="shrink-0 rounded p-0.5 hover:bg-muted"
                >
                    <Play className="size-3" />
                </button>
            ) : null}
        </div>
    );
}

/** 三级表格的一行：多选 + 三列事实 */
function TableRow({
    row,
    now,
    checked,
    onCheck,
}: {
    row: BotRow;
    now: number;
    checked: boolean;
    onCheck: (row: BotRow, checked: boolean) => void;
}) {
    return (
        <label className="flex cursor-pointer items-center gap-2 border-b border-border/40 px-3 py-1.5 hover:bg-muted/40">
            <input
                type="checkbox"
                checked={checked}
                onChange={(event) => onCheck(row, event.target.checked)}
                className="size-3"
            />
            <StateDot row={row} />
            <span className="w-[92px] shrink-0 truncate text-[11px]" style={{ color: row.botColor }}>
                {row.botName}
            </span>
            <span className="w-[200px] shrink-0 truncate text-[11px] text-muted-foreground" title={row.roomTitle}>
                {row.roomTitle}
            </span>
            <span className="w-[92px] shrink-0 text-[10px] text-muted-foreground">{attentionLabelOf(row)}</span>
            {/* 结局是**上一轮**怎么结束的，与左边那列「此刻」不是同一个时间点 ——
                不写明时态就会被读成同一件事（用户 2026-11-26 看到的「排队中 + 中断」：
                其实是一个正在跑的成员，上一轮被进程中断过）。 */}
            <span
                className={`min-w-0 flex-1 truncate text-[11px] ${
                    row.outcome === undefined || row.outcome === 'done' ? 'text-muted-foreground' : 'text-rose-300'
                }`}
                title={`上一轮：${outcomeTextOf(row)}`}
            >
                上轮 · {outcomeTextOf(row)}
            </span>
            <span className="w-[86px] shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                {row.lastTurnAt === undefined ? '—' : fmtAt(row.lastTurnAt, now)}
            </span>
        </label>
    );
}

// ─── 主体 ─────────────────────────────────────────────────────────

export interface BotsOverlayProps extends BotRowsState {
    onClose: () => void;
    /** 打开时先看哪一层；缺省二级浮层（宿主将来要「直接开全部」时用得上） */
    initialMode?: 'brief' | 'full';
    /**
     * 打开时预选哪个筛选（标题栏那颗**分类徽标**点进来的：点「出错 4」就直接看到那 4 个）。
     * 给了它就直接开三级抽屉 —— 二级没有筛选钮，预选一个它看不见的词等于白给。
     */
    initialFilter?: Filter;
}

export function BotsOverlay({
    rows,
    error,
    loaded,
    reload,
    onClose,
    initialMode = 'brief',
    initialFilter,
}: BotsOverlayProps) {
    const [mode, setMode] = React.useState<'brief' | 'full'>(initialMode === 'full' || initialFilter !== undefined ? 'full' : 'brief');
    const [filter, setFilter] = React.useState<Filter>(initialFilter ?? 'all');
    const [checked, setChecked] = React.useState<ReadonlySet<string>>(new Set());
    const [flash, setFlash] = React.useState<string | null>(null);
    const [sending, setSending] = React.useState(false);
    const [now, setNow] = React.useState(() => Date.now());

    const sorted = React.useMemo(() => sortRows(rows), [rows]);
    const counts = React.useMemo(() => countByAttention(rows), [rows]);
    /** 二级 = 非空闲（在跑 / 排队 / 等你 / 出错都算“活动的”） */
    const visible = sorted.filter(visibleInOverlay);
    const shown = mode === 'brief' ? visible : sorted.filter((row) => matches(row, filter));

    // 「刚刚」的时长要跳（只有这一段是相对时间，其余都是绝对时刻）
    React.useEffect(() => {
        if (!rows.some((row) => row.state === 'running')) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [rows]);

    React.useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const keyOf = (row: BotRow): string => `${row.roomId}\u0000${row.botId}`;

    const toggle = (row: BotRow, on: boolean) => {
        setChecked((previous) => {
            const next = new Set(previous);
            if (on) next.add(keyOf(row));
            else next.delete(keyOf(row));
            return next;
        });
    };

    const retry = async (targets: BotRow[]) => {
        if (targets.length === 0) return;
        setSending(true);
        try {
            const back = await diy2.bots.retry(targets.map((row) => ({ roomId: row.roomId, botId: row.botId })));
            setFlash(retryReport(back));
            setChecked(new Set());
            reload();
        } catch (err: unknown) {
            setFlash(err instanceof Error ? err.message : String(err));
        } finally {
            setSending(false);
        }
    };

    const selected = shown.filter((row) => checked.has(keyOf(row)));
    /** 全选 = 当前**筛出来的这批**（不是全实例：筛了「出错」却把在跑也选上很奇怪） */
    const allChecked = shown.length > 0 && shown.every((row) => checked.has(keyOf(row)));
    const toggleAll = (on: boolean): void => {
        setChecked((previous) => {
            const next = new Set(previous);
            for (const row of shown) {
                const key = keyOf(row);
                if (on) next.add(key);
                else next.delete(key);
            }
            return next;
        });
    };

    return (
        <div className="fixed inset-0 z-50" role="dialog" aria-label="Bot 状态">
            <div className="absolute inset-0 bg-black/40" onClick={onClose} />
            <div
                className={`absolute inset-x-0 top-0 flex flex-col border-b border-border bg-background shadow-xl ${
                    mode === 'full' ? 'h-[70vh]' : 'max-h-[60vh]'
                }`}
            >
                <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
                    <span className="text-xs font-medium">{mode === 'brief' ? 'Bot · 要你看的' : 'Bot · 全部'}</span>
                    {loaded ? (
                        // 分类小计：**与标题栏那排徽标同一个数**（都来自 `countByAttention`），
                        // 所以「红 4 + 等你 2 + 在跑 1」在这两处一定对得上
                        <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            {(['broken', 'blocked', 'queued', 'live'] as const)
                                .filter((kind) => counts[kind] > 0)
                                .map((kind) => (
                                    <span key={kind} className={`flex items-center gap-1 ${ATTENTION_INK[kind]}`}>
                                        <span className={`size-1.5 rounded-full ${ATTENTION_DOT[kind]}`} />
                                        {counts[kind]}
                                    </span>
                                ))}
                            <span className="text-muted-foreground/70">/ 共 {rows.length}</span>
                        </span>
                    ) : null}
                    {error === null ? null : <span className="text-[10px] text-rose-400">{error}</span>}
                    {mode === 'full' ? (
                        <div className="ml-3 flex items-center gap-1">
                            {filterItems(counts).map((item) => (
                                <button
                                    key={item.id}
                                    onClick={() => setFilter(item.id)}
                                    className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
                                        filter === item.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'
                                    }`}
                                >
                                    {item.dot === undefined ? null : (
                                        <span className={`size-1.5 rounded-full ${item.dot}`} />
                                    )}
                                    {item.label}
                                </button>
                            ))}
                        </div>
                    ) : null}
                    <button onClick={onClose} title="关闭" className="ml-auto rounded p-1 hover:bg-muted">
                        <X className="size-3.5" />
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                    {!loaded ? (
                        <p className="px-4 py-6 text-[11px] text-muted-foreground">正在读 bot 状态…</p>
                    ) : shown.length === 0 ? (
                        <p className="px-4 py-6 text-[11px] text-muted-foreground">
                            {mode === 'brief'
                                ? '都闲着 —— 没有在跑的、排队的、等你回答或出错的'
                                : '这个筛选下没有 bot'}
                        </p>
                    ) : mode === 'brief' ? (
                        shown.map((row) => (
                            <BriefRow
                                key={keyOf(row)}
                                row={row}
                                onRetry={(target) => {
                                    void retry([target]);
                                }}
                            />
                        ))
                    ) : (
                        <>
                            {/* 表头：全选当前筛选结果。以前只能一条一条勾，批量重试实际上用不起来 */}
                            <label className="flex cursor-pointer items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-1 text-[10px] text-muted-foreground hover:bg-muted/50">
                                <input
                                    type="checkbox"
                                    checked={allChecked}
                                    onChange={(event) => toggleAll(event.target.checked)}
                                    className="size-3"
                                    aria-label="全选"
                                />
                                全选{' '}
                                <span className="tabular-nums">
                                    已选 {selected.length} / {shown.length}
                                </span>
                            </label>
                            {shown.map((row) => (
                                <TableRow
                                    key={keyOf(row)}
                                    row={row}
                                    now={now}
                                    checked={checked.has(keyOf(row))}
                                    onCheck={toggle}
                                />
                            ))}
                        </>
                    )}
                </div>

                <div className="flex items-center gap-2 border-t border-border px-3 py-1.5">
                    {flash === null ? null : <span className="text-[10px] text-muted-foreground">{flash}</span>}
                    {mode === 'brief' ? (
                        <button
                            onClick={() => setMode('full')}
                            className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-[11px] hover:bg-muted"
                        >
                            全部 Bot <ChevronRight className="size-3" />
                        </button>
                    ) : (
                        <>
                            <button
                                onClick={() => setMode('brief')}
                                className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
                            >
                                ‹ 只看活动的
                            </button>
                            <button
                                onClick={() => {
                                    void retry(selected);
                                }}
                                disabled={selected.length === 0 || sending}
                                className="ml-auto flex items-center gap-1 rounded bg-primary px-2 py-1 text-[11px] text-primary-foreground disabled:opacity-40"
                            >
                                {sending ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
                                重试选中（{selected.length}）
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
