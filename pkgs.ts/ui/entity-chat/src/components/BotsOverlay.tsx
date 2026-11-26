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

import { Button, Input, Sheet, SheetContent } from '@diy-agent/ui-shadcn';

import type { BotRow } from '@diy-agent/chat-transport-rpc';

import { type BotRowsState, fmtAt, needsYou, outcomeTextOf, sortRows, STATE_TEXT } from '../bots';
import { diy2 } from '../store';

const STATE_DOT: Readonly<Record<BotRow['state'], string>> = {
    running: 'bg-emerald-400 animate-pulse',
    asking: 'bg-amber-400',
    'needs-attention': 'bg-rose-400',
    idle: 'bg-zinc-500',
};

/** `attn` = 与二级浮层同一个口径（非 idle），三级抽屉的**默认**筛选 */
type Filter = 'attn' | 'all' | BotRow['state'];

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
    { id: 'attn', label: '要看的' },
    { id: 'all', label: '全部' },
    { id: 'running', label: '在跑' },
    { id: 'asking', label: '等你回答' },
    { id: 'needs-attention', label: '需要看' },
    { id: 'idle', label: '空闲' },
];

const FILTER_ATTN: Filter = 'attn';

function matches(row: BotRow, filter: Filter): boolean {
    if (filter === FILTER_ATTN) return needsYou(row);
    if (filter === 'all') return true;
    return row.state === filter;
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

function StateDot({ state }: { state: BotRow['state'] }) {
    return <span className={`size-1.5 shrink-0 rounded-full ${STATE_DOT[state]}`} />;
}

/** 二级浮层的一行：谁、在哪、要你干什么 */
function BriefRow({ row, onRetry }: { row: BotRow; onRetry: (row: BotRow) => void }) {
    const canRetry = row.state === 'needs-attention';
    return (
        <div className="flex items-center gap-2 px-3 py-1.5">
            <StateDot state={row.state} />
            <span className="truncate text-xs font-medium" style={{ color: row.botColor }}>
                {row.botName}
            </span>
            <span className="truncate text-xs text-muted-foreground">{row.roomTitle}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {row.state === 'needs-attention' ? outcomeTextOf(row) : STATE_TEXT[row.state]}
            </span>
            {canRetry ? (
                <Button variant="ghost" size="icon-xs" onClick={() => onRetry(row)} title="发一条「继续」接着干">
                    <Play className="size-3" />
                </Button>
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
            <Input
                type="checkbox"
                checked={checked}
                onChange={(event) => onCheck(row, event.target.checked)}
                className="size-3"
            />
            <StateDot state={row.state} />
            <span className="w-[92px] shrink-0 truncate text-xs" style={{ color: row.botColor }}>
                {row.botName}
            </span>
            <span className="w-[200px] shrink-0 truncate text-xs text-muted-foreground" title={row.roomTitle}>
                {row.roomTitle}
            </span>
            <span className="w-[84px] shrink-0 text-xs text-muted-foreground">{STATE_TEXT[row.state]}</span>
            <span
                className={`min-w-0 flex-1 truncate text-xs ${
                    row.outcome === undefined || row.outcome === 'done' ? 'text-muted-foreground' : 'text-rose-300'
                }`}
                title={outcomeTextOf(row)}
            >
                {outcomeTextOf(row)}
            </span>
            <span className="w-[86px] shrink-0 text-right font-mono text-xs text-muted-foreground">
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
}

export function BotsOverlay({ rows, error, loaded, reload, onClose, initialMode = 'brief' }: BotsOverlayProps) {
    const [mode, setMode] = React.useState<'brief' | 'full'>(initialMode);
    const [filter, setFilter] = React.useState<Filter>(FILTER_ATTN);
    const [checked, setChecked] = React.useState<ReadonlySet<string>>(new Set());
    const [flash, setFlash] = React.useState<string | null>(null);
    const [sending, setSending] = React.useState(false);
    const [now, setNow] = React.useState(() => Date.now());

    const sorted = React.useMemo(() => sortRows(rows), [rows]);
    const attention = sorted.filter(needsYou);
    const shown = mode === 'brief' ? attention : sorted.filter((row) => matches(row, filter));

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

    // 遮罩 / Esc / 焦点陷阱交给官方 Sheet(side=top)；两种形态只是高度不同
    return (
        <Sheet open onOpenChange={(next) => !next && onClose()}>
            <SheetContent
                side="top"
                showCloseButton={false}
                aria-label="Bot 状态"
                className={`h-auto gap-0 p-0 ${mode === 'full' ? 'h-[70vh]' : 'max-h-[60vh]'}`}
            >
                <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
                    <span className="text-xs font-medium">{mode === 'brief' ? 'Bot · 要你看的' : 'Bot · 全部'}</span>
                    {loaded ? (
                        <span className="text-xs text-muted-foreground">
                            {attention.length} 个要你看 / 共 {rows.length} 个
                        </span>
                    ) : null}
                    {error === null ? null : <span className="text-xs text-rose-400">{error}</span>}
                    {mode === 'full' ? (
                        <div className="ml-3 flex items-center gap-1">
                            {FILTERS.map((item) => (
                                <Button
                                    key={item.id}
                                    variant="ghost"
                                    size="xs"
                                    onClick={() => setFilter(item.id)}
                                    className={`${
                                        filter === item.id
                                            ? 'bg-muted text-foreground'
                                            : 'text-muted-foreground hover:bg-muted/60'
                                    }`}
                                >
                                    {item.label}
                                </Button>
                            ))}
                        </div>
                    ) : null}
                    <Button variant="ghost" size="icon-xs" onClick={onClose} title="关闭">
                        <X className="size-3.5" />
                    </Button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                    {!loaded ? (
                        <p className="px-4 py-6 text-xs text-muted-foreground">正在读 bot 状态…</p>
                    ) : shown.length === 0 ? (
                        <p className="px-4 py-6 text-xs text-muted-foreground">
                            {mode === 'brief' ? '都闲着 —— 没有在跑的、也没有等你回答或出错的' : '这个筛选下没有 bot'}
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
                        shown.map((row) => (
                            <TableRow
                                key={keyOf(row)}
                                row={row}
                                now={now}
                                checked={checked.has(keyOf(row))}
                                onCheck={toggle}
                            />
                        ))
                    )}
                </div>

                <div className="flex items-center gap-2 border-t border-border px-3 py-1.5">
                    {flash === null ? null : <span className="text-xs text-muted-foreground">{flash}</span>}
                    {mode === 'brief' ? (
                        <Button variant="ghost" size="xs" onClick={() => setMode('full')}>
                            全部 Bot <ChevronRight className="size-3" />
                        </Button>
                    ) : (
                        <>
                            <Button variant="ghost" size="xs" onClick={() => setMode('brief')}>
                                ‹ 只看要看的
                            </Button>
                            <Button
                                variant="default"
                                size="xs"
                                onClick={() => {
                                    void retry(selected);
                                }}
                                disabled={selected.length === 0 || sending}
                            >
                                {sending ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
                                重试选中（{selected.length}）
                            </Button>
                        </>
                    )}
                </div>
            </SheetContent>
        </Sheet>
    );
}
