// BotStatusChip —— 标题栏那颗「状态」：每个席位现在什么状态（用户 2026-11-28 裁）。
//
// 与隔壁那颗「Bot N」**各答一件事**（2026-11-24 / 2026-11-28 两次裁定，别合并）：
//   · `Bot N`（ActiveSessionsGlyph）= **谁在动** —— 只数正在跑的房间，点开跳过去；
//   · 这颗 = **我该推谁一把** —— 在跑 / 等你回答 / 上一轮出错，点开看总览。
// 11-25 判「重复」删掉的那次，是因为两颗都答同一个问题；口径分开之后并列成立。
//
// 三级披露（与作业 chip 同一套，见 DESIGN.md §6.5）：
//   ① 一眼：标题栏常显「状态 N」（N = 要你看的席位条数），空闲时也显示 0 ——
//      否则人分不清「没在跑」和「坏了」；
//   ② 浮层：只列要你看的（`needsYou`），每行一句话 + 一个动作（去回答 / 继续）；
//   ③ 全量表：所有房间 × 所有席位，可筛选、可多选、可批量「继续」。
//      **默认筛选 = ② 的全集**：点进去不是换一个世界，只是多了列和批量动作。
//
// 数字与行**同源**（都用 `useBotRows` 那一份）：各算一遍就会出现「状态 3、点开两行」。

import { Bot, Play, X } from 'lucide-react';
import * as React from 'react';

import type { BotRow } from '@diy-agent/chat-transport-rpc';

import {
    Button,
    Checkbox,
    Popover,
    PopoverContent,
    PopoverTrigger,
    Sheet,
    SheetContent,
    SheetTitle,
} from '@diy-agent/ui-shadcn';

import { fmtAt, needsYou, outcomeTextOf, retryRows, STATE_TEXT, useBotRows } from '../bots';
import { actions } from '../store';

/** 状态点：只在有意义的四档上用色（DESIGN.md §1 的状态色四档） */
const STATE_DOT: Readonly<Record<BotRow['state'], string>> = {
    running: 'bg-emerald-500 animate-pulse',
    asking: 'bg-sky-500',
    'needs-attention': 'bg-destructive',
    idle: 'bg-muted-foreground/40',
};

/** 一行的一句话：这一行到底怎么了（不重复状态名，状态已经在左边） */
function summarize(row: BotRow): string {
    switch (row.state) {
        case 'running':
            return row.queued === undefined ? '在跑' : `在跑 · 还排着 ${row.queued} 条`;
        case 'asking':
            return row.askTitle === undefined || row.askTitle === '' ? '等你回答' : `等你回答：${row.askTitle}`;
        default:
            return outcomeTextOf(row);
    }
}

function Dot({ state }: { state: BotRow['state'] }) {
    return <span className={`size-1.5 shrink-0 rounded-full ${STATE_DOT[state]}`} title={STATE_TEXT[state]} />;
}

/** ② 浮层的一行：左边点进房间，右边一个动作 */
function BriefRow({ row, onDone }: { row: BotRow; onDone: () => void }) {
    const go = () => {
        actions.select(row.roomId);
        onDone();
    };
    return (
        <div className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent">
            <button type="button" onClick={go} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <Dot state={row.state} />
                <span className="min-w-0 shrink-0 max-w-[9rem] truncate text-xs">{row.roomTitle}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{row.botName}</span>
                <span
                    className={`min-w-0 flex-1 truncate text-xs ${
                        row.state === 'needs-attention' ? 'text-destructive' : 'text-muted-foreground'
                    }`}
                    title={summarize(row)}
                >
                    {summarize(row)}
                </span>
            </button>
            {row.state === 'asking' ? (
                <Button variant="ghost" size="xs" onClick={go} className="shrink-0 text-sky-400">
                    去回答
                </Button>
            ) : row.state === 'running' ? null : (
                <RetryButton rows={[row]} onDone={onDone} />
            )}
        </div>
    );
}

/** 「继续」：给这一个（或选中的这一批）席位再发一句话。已在跑的服务端会跳过 */
function RetryButton({
    rows,
    onDone,
    label,
}: {
    rows: readonly BotRow[];
    onDone: () => void;
    label?: string;
}) {
    const [busy, setBusy] = React.useState(false);
    const [note, setNote] = React.useState<string | null>(null);
    const targets = rows.filter((row) => row.state !== 'running');
    if (targets.length === 0) return null;
    return (
        <Button
            variant="outline"
            size="xs"
            disabled={busy}
            className="shrink-0"
            title={note ?? `给 ${targets.length} 个席位各发一条「继续」`}
            onClick={() => {
                setBusy(true);
                void retryRows(targets.map((row) => ({ roomId: row.roomId, botId: row.botId })))
                    .then((back) => {
                        const sent = back.started.reduce((sum, item) => sum + item.botIds.length, 0);
                        setNote(
                            back.skipped.length === 0
                                ? `已发「继续」给 ${sent} 个席位`
                                : `已发 ${sent} 个，跳过 ${back.skipped.length} 个`,
                        );
                        onDone();
                    })
                    .catch((error: unknown) => {
                        setNote(error instanceof Error ? error.message : String(error));
                    })
                    .finally(() => setBusy(false));
            }}
        >
            <Play />
            {label ?? '继续'}
        </Button>
    );
}

/** ③ 全量表的筛选档位；默认 `attn` 与 ② 同一个口径 */
type Filter = 'attn' | 'all' | BotRow['state'];

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
    { id: 'attn', label: '要看的' },
    { id: 'all', label: '全部' },
    { id: 'running', label: '在跑' },
    { id: 'asking', label: '等你回答' },
    { id: 'needs-attention', label: '出错' },
    { id: 'idle', label: '空闲' },
];

const matches = (row: BotRow, filter: Filter): boolean =>
    filter === 'attn' ? needsYou(row) : filter === 'all' ? true : row.state === filter;

const keyOf = (row: BotRow): string => `${row.roomId}\u0000${row.botId}`;

/** ③ 全量表：一张表，筛选 / 多选 / 批量继续 */
function BotTable({
    rows,
    loaded,
    error,
    onClose,
    onRetry,
    now,
}: {
    rows: readonly BotRow[];
    loaded: boolean;
    error: string | null;
    onClose: () => void;
    onRetry: () => void;
    now: number;
}) {
    const [filter, setFilter] = React.useState<Filter>('attn');
    const [checked, setChecked] = React.useState<ReadonlySet<string>>(new Set());
    const shown = rows.filter((row) => matches(row, filter));
    const selected = shown.filter((row) => checked.has(keyOf(row)));
    const toggle = (row: BotRow, on: boolean) => {
        setChecked((previous) => {
            const next = new Set(previous);
            if (on) next.add(keyOf(row));
            else next.delete(keyOf(row));
            return next;
        });
    };

    return (
        <Sheet open onOpenChange={(next) => !next && onClose()}>
            <SheetContent side="top" showCloseButton={false} className="h-auto max-h-[70vh] gap-0 overflow-hidden p-0">
                <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
                    <Bot className="size-3.5 text-muted-foreground" />
                    <SheetTitle className="text-sm font-medium">Bot 状态</SheetTitle>
                    <span className="text-xs text-muted-foreground">
                        {loaded ? `${rows.filter(needsYou).length} 个要你看 / 共 ${rows.length} 个` : '正在读…'}
                    </span>
                    {error === null ? null : <span className="text-xs text-destructive">{error}</span>}
                    <div className="ml-2 flex items-center gap-1">
                        {FILTERS.map((item) => (
                            <Button
                                key={item.id}
                                variant={filter === item.id ? 'secondary' : 'ghost'}
                                size="xs"
                                onClick={() => setFilter(item.id)}
                            >
                                {item.label}
                            </Button>
                        ))}
                    </div>
                    <Button variant="ghost" size="icon-xs" onClick={onClose} title="关闭" className="ml-auto">
                        <X className="size-3.5" />
                    </Button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                    {!loaded ? (
                        <p className="px-4 py-6 text-xs text-muted-foreground">正在读 Bot 状态…</p>
                    ) : shown.length === 0 ? (
                        <p className="px-4 py-6 text-xs text-muted-foreground">
                            {filter === 'attn' ? '都闲着 —— 没有在跑的、也没有等你回答或出错的' : '这个筛选下没有席位'}
                        </p>
                    ) : (
                        <div className="divide-y divide-border">
                            {shown.map((row) => (
                                <label
                                    key={keyOf(row)}
                                    className="flex cursor-pointer items-center gap-2 px-4 py-1.5 hover:bg-accent"
                                >
                                    <Checkbox
                                        checked={checked.has(keyOf(row))}
                                        onCheckedChange={(next) => toggle(row, next === true)}
                                    />
                                    <span className="size-1.5 shrink-0">
                                        <Dot state={row.state} />
                                    </span>
                                    <span className="w-16 shrink-0 text-xs text-muted-foreground">
                                        {STATE_TEXT[row.state]}
                                    </span>
                                    <span className="min-w-0 max-w-[12rem] shrink-0 truncate text-xs">
                                        {row.roomTitle}
                                    </span>
                                    <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">
                                        {row.botName}
                                    </span>
                                    <span
                                        className={`min-w-0 flex-1 truncate text-xs ${
                                            row.state === 'needs-attention'
                                                ? 'text-destructive'
                                                : 'text-muted-foreground'
                                        }`}
                                        title={summarize(row)}
                                    >
                                        {summarize(row)}
                                    </span>
                                    <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                                        {row.lastTurnAt === undefined ? '—' : fmtAt(row.lastTurnAt, now)}
                                    </span>
                                </label>
                            ))}
                        </div>
                    )}
                </div>

                <div className="flex shrink-0 items-center gap-2 border-t px-4 py-2">
                    <span className="text-xs text-muted-foreground">
                        {selected.length === 0 ? '勾几行可以批量推一把' : `已选 ${selected.length} 个席位`}
                    </span>
                    <div className="ml-auto">
                        <RetryButton rows={selected} onDone={onRetry} label={`继续选中（${selected.length}）`} />
                    </div>
                </div>
            </SheetContent>
        </Sheet>
    );
}

/**
 * 标题栏那颗「状态」。
 *
 * 计数 = **要你看的**席位数（`needsYou`：在跑 / 等你回答 / 上一轮出错）。空闲也显示 0。
 * 颜色只表达「有没有更急的」：有出错 → 红；有等你回答 → 蓝；只在跑 → 绿；全闲 → 灰。
 */
export function BotStatusChip() {
    const [brief, setBrief] = React.useState(false);
    const [full, setFull] = React.useState(false);
    const { rows, error, loaded, reload } = useBotRows(brief || full);
    const [now, setNow] = React.useState(() => Date.now());

    // 秒表只在「有人在跑」时跳（只有这一段是相对时间，其余都是绝对时刻）
    React.useEffect(() => {
        if (!rows.some((row) => row.state === 'running')) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [rows]);

    const attention = rows.filter(needsYou);
    const count = attention.length;
    const tone = rows.some((row) => row.state === 'needs-attention')
        ? 'text-destructive'
        : rows.some((row) => row.state === 'asking')
          ? 'text-sky-400'
          : count > 0
            ? 'text-emerald-400'
            : 'text-muted-foreground/70';
    const title =
        error !== null
            ? `Bot 状态读取失败：${error}`
            : count === 0
              ? '所有 Bot 都闲着，点击看全部'
              : `${count} 个 Bot 要你看（在跑 / 等你回答 / 上一轮出错）`;

    return (
        <>
            <Popover open={brief} onOpenChange={setBrief}>
                <PopoverTrigger
                    render={
                        <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className={`h-[22px] gap-1 whitespace-nowrap px-1.5 leading-none ${tone}`}
                            title={title}
                            aria-label={`Bot 状态 ${count}，查看要你看的`}
                        />
                    }
                >
                    <Bot className="size-3.5" />
                    <span className="text-xs leading-none">状态</span>
                    <span className="text-xs tabular-nums leading-none">{count}</span>
                </PopoverTrigger>
                <PopoverContent side="bottom" align="end" aria-label="要你看的 Bot" className="w-96 p-1">
                    <div className="flex items-center gap-2 px-2 py-1">
                        <span className="text-xs font-medium">要你看的 · {count}</span>
                        {error === null ? null : <span className="truncate text-xs text-destructive">{error}</span>}
                        <Button
                            variant="ghost"
                            size="xs"
                            className="ml-auto text-muted-foreground"
                            onClick={() => {
                                setBrief(false);
                                setFull(true);
                            }}
                        >
                            全部 Bot ›
                        </Button>
                    </div>
                    <div className="max-h-80 overflow-y-auto">
                        {!loaded ? (
                            <p className="px-2 py-3 text-xs text-muted-foreground">正在读…</p>
                        ) : count === 0 ? (
                            <p className="px-2 py-3 text-xs text-muted-foreground">
                                都闲着 —— 没有在跑的、也没有等你回答或出错的
                            </p>
                        ) : (
                            attention.map((row) => (
                                <BriefRow key={keyOf(row)} row={row} onDone={() => setBrief(false)} />
                            ))
                        )}
                    </div>
                </PopoverContent>
            </Popover>

            {full && (
                <BotTable
                    rows={rows}
                    loaded={loaded}
                    error={error}
                    now={now}
                    onClose={() => setFull(false)}
                    onRetry={reload}
                />
            )}
        </>
    );
}
