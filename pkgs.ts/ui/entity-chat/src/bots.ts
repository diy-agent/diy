// bots.ts —— 「每个 bot 一行状态」的界面副本（`diy2.bots.rows` 的轮询 + 派生口径）。
//
// 二级弹层（只列要人看见的）与三级表格（全量可筛选）**读同一份数据、同一套口径**：
// 数字与行都从这里的 `needsYou` / `stateOrder` 出来。两处各算一遍的话，
// 「弹层说有 3 个、表格说有 4 个」这种对不上是必然的（见 ##activity-popovers 的遗留三条）。
//
// 为什么轮询：这行状态里有一半来自磁盘（上一轮怎么结束的），服务端没有为它推事件；
// 而「在跑」那半是内存态，靠轮询 1.5s 也够看。作业 chip 用的是同一套节奏（1.2s / 5s）。

import * as React from 'react';

import type { BotRow } from '@diy-agent/chat-transport-rpc';

import { diy2 } from './store';

/**
 * 浮层开着（人正盯着这张表）时的轮询间隔。
 *
 * 2026-11-26 从 1500ms 提到 2500ms：实测下这个数字决定了**整个页面**的手感 ——
 * `bots.rows` 在服务端要跑两条全表 json 分组（529ms + 39ms），回包是全部房间 ×
 * 全部成员（实测 95 行），前端 setRows 会让顶层的 `countByAttention` 重算、整块重渲。
 * 1.5s 一轮 = 主线程每 1.5s 被撞一次，用户点输入框要排 1~3 秒的队。
 */
const POLL_ACTIVE_MS = 2500;
/**
 * 没人在看这张表时的轮询间隔。
 *
 * **不再因为「有 agent 在跑」就切快档**（那是 2026-11-26 之前的行为）：`busy` 会让
 * 一个开着 3 个在跑房间的实例以 1.5s 的频率算全实例的行 —— 而用户根本没在弹层里，
 * 只有标题栏那几颗靛标要活。标题栏靛标 6s 更新一次完全够看。
 */
const POLL_IDLE_MS = 6000;

export const STATE_TEXT: Readonly<Record<BotRow['state'], string>> = {
    running: '在跑',
    asking: '等你回答',
    'needs-attention': '需要你看一眼',
    idle: '空闲',
};

/**
 * 「这个房间 / 这个成员此刻归哪一类」——**可并存的关注度**词表（2026-11-25 裁）。
 *
 * 与 `BotState` 的关系：`BotState` 是**互斥单值**（此刻最要紧的一件事，一行一个徽标用它）；
 * 而汇总计数必须分类 —— 拿互斥值去 `filter(state !== 'idle')` 数出来的那个数字混了三种
 * 语义，于是出现「标题栏红 7，点开是 4 错 + 2 等 + 1 跑」。
 *
 * 顺序 = 谁更该让人动：先错、再卡在你这、再系统在干活、最后才是「跑完了你没看」。
 */
export type AttentionKind = 'broken' | 'blocked' | 'queued' | 'live' | 'idle';

/** 每一类的人话（徽标 / tab / tooltip 共用一处，不在各组件里各写一份） */
export const ATTENTION_TEXT: Readonly<Record<AttentionKind, string>> = {
    broken: '出错',
    blocked: '等你回答',
    queued: '排队中',
    live: '在跑',
    idle: '空闲',
};

/**
 * 标题栏那排徽标用**单字**标签（`6错 3等`）：28px 高的那一条放不下全称，
 * 但完全裸着的数字又看不出是什么（用户 2026-11-25 报「挤在一起」，量的结果是
 * `🤖 6 3` —— 两个数字紧贴着，读起来像一串乱数）。全称见 `ATTENTION_TEXT`。
 */
export const ATTENTION_SHORT: Readonly<Record<AttentionKind, string>> = {
    broken: '错',
    blocked: '等',
    queued: '排',
    live: '跑',
    idle: '闲',
};

/** 色点（**只有 broken 用红**：其余四类各有自己的色，红色专属「出事了」） */
export const ATTENTION_DOT: Readonly<Record<AttentionKind, string>> = {
    broken: 'bg-rose-400',
    blocked: 'bg-amber-400',
    queued: 'bg-zinc-400',
    live: 'bg-emerald-400 animate-pulse',
    idle: 'bg-zinc-600',
};

/** 文字的色（徽标旁的计数） */
export const ATTENTION_INK: Readonly<Record<AttentionKind, string>> = {
    broken: 'text-rose-400',
    blocked: 'text-amber-400',
    queued: 'text-zinc-400',
    live: 'text-emerald-400',
    idle: 'text-muted-foreground',
};

/**
 * 一行 → 关注度。
 *
 * 优先序：出错 > 等你 > **在跑** > 排队 > 空闲。
 *
 * 「在跑」排在「排队」前面是 2026-11-26 修的：一个正在跑的成员手上就是这一轮，
 * 它后面还可能排着几条 —— 把这种行归成「排队中」（原来的顺序）会让人以为它没在干活，
 * 用户看到的就是「排队中 + 上轮中断」那种读不通的组合。
 * 排队数并没有丢：`attentionLabelOf` 会在在跑的行上补一句「在跑 · 排 3」。
 */
export function attentionOf(row: BotRow): AttentionKind {
    if (row.state === 'needs-attention') return 'broken';
    if (row.state === 'asking') return 'blocked';
    if (row.state === 'running') return 'live';
    if ((row.queued ?? 0) > 0) return 'queued';
    return 'idle';
}

/**
 * 行上那个「状态」字样：在跑且排着队时两个都说（`在跑 · 排 3`）。
 *
 * 分类（`attentionOf`）必须互斥才能计数，但**一行可以同时是在跑和排着** ——
 * 所以展示层不能直接用分类名，否则总有一个事实被吞掉。
 */
export function attentionLabelOf(row: BotRow): string {
    const queued = row.queued ?? 0;
    if (row.state === 'running' && queued > 0) return `在跑 · 排 ${queued}`;
    return ATTENTION_TEXT[attentionOf(row)];
}

export interface AttentionCounts {
    broken: number;
    blocked: number;
    queued: number;
    live: number;
    idle: number;
    /** 二级浮层 / 默认筛选的口径：非空闲（含在跑、排队） */
    visible: number;
    /** 真正要人动手的：错 + 等你（**标题栏那颗红点只数这两个**） */
    needsYou: number;
}

/**
 * 一批行 → 分类计数。标题栏徽标、浮层 tab、侧栏全部读这一份。
 *
 * 每行**只归一类**，所以 `broken + blocked + queued + live + idle === rows.length` ——
 * 这就是「点开能对上」的保证：红点不会出现 7 而点开只有 4+2+1。
 */
export function countByAttention(rows: readonly BotRow[]): AttentionCounts {
    const counts: AttentionCounts = {
        broken: 0,
        blocked: 0,
        queued: 0,
        live: 0,
        idle: 0,
        visible: 0,
        needsYou: 0,
    };
    for (const row of rows) counts[attentionOf(row)] += 1;
    counts.needsYou = counts.broken + counts.blocked;
    counts.visible = rows.length - counts.idle;
    return counts;
}

/** 结局的一句话（与 entity-runtime 的 `outcomeText` 同一套说法，但那边是服务端文案，这边只管展示） */
export function outcomeTextOf(row: BotRow): string {
    switch (row.outcome) {
        case undefined:
            return '还没跑过';
        case 'done':
            return '正常结束';
        case 'truncated':
            return '被输出上限截断';
        case 'max-steps':
            return '撞到步数上限';
        case 'filtered':
            return '被内容策略拦截';
        case 'tool-mismatch':
            return '工具结果没回来';
        case 'interrupted':
            return '中断（上一轮没跑完）';
        case 'failed':
            return row.outcomeMessage === undefined || row.outcomeMessage === '' ? '运行失败' : row.outcomeMessage;
    }
}

/**
 * 这一行要不要出现在**二级弹层**里。
 *
 * 用户 2026-11-25 定的口径：二级只列「活动的 + 出错的 + 等回答的」—— 也就是
 * 除 `idle` 之外全部。`idle` 是「上次正常说完、现在没动」，它只属于三级表格。
 */
export function visibleInOverlay(row: BotRow): boolean {
    return attentionOf(row) !== 'idle';
}

/**
 * 这一行是不是**真要人动手**（上一轮出错 / 卡在你这）。
 *
 * 标题栏那颗数字只数这两个 —— 以前它是 `state !== 'idle'`，把「在跑」也染成红色，
 * 于是「红 7、点开只有 4 个真出错」。在跑 / 排队是系统状态，不该催人。
 */
export function needsYou(row: BotRow): boolean {
    const kind = attentionOf(row);
    return kind === 'broken' || kind === 'blocked';
}

/**
 * 排序顺序 = 关注度顺序：**要你处置的排最前**（先错、再等你、再排队、再在跑、最后空闲）。
 *
 * 以前是 `running > asking > needs-attention`（在跑最前），出错的沉在底下 ——
 * 用户 2026-11-25 报的「红 7、点开只有 4 个真出错」，有一半就是被这个顺序埋掉的。
 */
const ATTENTION_RANK: Readonly<Record<AttentionKind, number>> = {
    broken: 0,
    blocked: 1,
    queued: 2,
    live: 3,
    idle: 4,
};

/** 需要人动的排前面；同类按「最后动静」新→旧（没有动静的垫底） */
export function sortRows(rows: readonly BotRow[]): BotRow[] {
    return [...rows].sort((a, b) => {
        const byRank = ATTENTION_RANK[attentionOf(a)] - ATTENTION_RANK[attentionOf(b)];
        if (byRank !== 0) return byRank;
        return (b.lastTurnAt ?? 0) - (a.lastTurnAt ?? 0);
    });
}

/**
 * 行数据的**稳定签名**：判断「这次拉回来的和上次是不是同一份」。
 *
 * 不深比较整个对象（贵、且没必要）—— 只拼决定渲染的那几个字段：身份 / 状态 / 结局 /
 * 排队数 / 最后动静 / 提问。任何一项变了才值得 setState（= 顶层重渲）。
 *
 * 背景（2026-11-26）：轮询回包里绝大多数时候内容一模一样，`setRows(新数组)` 却会让
 * 顶层 `countByAttention` 重算、标题栏与抽屉整块重渲 —— 那是主线程被撞的元凶之一。
 */
function signatureOf(rows: readonly BotRow[]): string {
    return rows
        .map(
            (row) =>
                `${row.roomId}\u0000${row.botId}\u0000${row.state}\u0000${row.outcome ?? ''}\u0000${row.queued ?? 0}\u0000${row.lastTurnAt ?? 0}\u0000${row.askId ?? ''}`,
        )
        .join('\u0001');
}

export interface BotRowsState {
    rows: BotRow[];
    error: string | null;
    /** 拉过一次没有（区分「还在连」和「真的没有 bot」） */
    loaded: boolean;
    reload: () => void;
}

/**
 * 行数据的界面副本。**可能是空的**：老服务端没有 `bots.rows`，测试里的假客户端也只实现
 * 实际用到的那几项 —— 缺了就当「这台实例没有这份表」，不抛错、不白屏。
 */
function rowsApi(): { rows: () => Promise<{ rows: BotRow[] }> } | undefined {
    return diy2.bots as { rows?: () => Promise<{ rows: BotRow[] }> } | undefined as
        | { rows: () => Promise<{ rows: BotRow[] }> }
        | undefined;
}

/**
 * `active` = 界面此刻是否看得见（弹层开着 / 抽屉开着）。看得见时用快档轮询，
 * 看不见也照拉（标题栏那颗计数要活着），只是慢一档。
 *
 * 2026-11-26：**「有 agent 在跑」不再算 active** —— 那会让一个跑着 3 个房间的实例
 * 以快档循环算全实例的行，而用户根本没在看这张表。
 */
export function useBotRows(active: boolean): BotRowsState {
    const [rows, setRows] = React.useState<BotRow[]>([]);
    const [error, setError] = React.useState<string | null>(null);
    const [loaded, setLoaded] = React.useState(false);
    const [tick, setTick] = React.useState(0);

    React.useEffect(() => {
        let alive = true;
        let lastSignature = '';
        const pull = () => {
            const api = rowsApi();
            if (api === undefined) {
                setLoaded(true);
                return;
            }
            void api
                .rows()
                .then((back) => {
                    if (!alive) return;
                    // 内容没变就不 setState：`setRows(新数组)` 即使数据一模一样也会重渲
                    // 顶层（counts → 标题栏 → 抽屉），而那正是“每 1.5s 撞一次主线程”的一半来源。
                    const signature = signatureOf(back.rows);
                    if (signature !== lastSignature) {
                        lastSignature = signature;
                        setRows(back.rows);
                    }
                    setError(null);
                    setLoaded(true);
                })
                .catch((err: unknown) => {
                    if (!alive) return;
                    setError(err instanceof Error ? err.message : String(err));
                    setLoaded(true);
                });
        };
        pull();
        // 只有「人正看着这张表」才快档；`busy` 不再算（它在后台跑，用户看不见）
        const every = active ? POLL_ACTIVE_MS : POLL_IDLE_MS;
        const timer = setInterval(pull, every);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [active, tick]);

    const reload = React.useCallback(() => setTick((value) => value + 1), []);
    return { rows, error, loaded, reload };
}

/** `3m20s` / `1h04m` / `12s` —— 看的是量级 */
export function fmtDur(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    if (total < 60) return `${total}s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, '0')}s`;
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** 绝对时刻：今天 `22:32`，跨天补 `11-24 22:32`（与侧栏同一口径，不再写「3 分钟前」） */
export function fmtAt(at: number, now = Date.now()): string {
    const date = new Date(at);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const sameDay = new Date(now).toDateString() === date.toDateString();
    if (sameDay) return `${hh}:${mm}`;
    return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${hh}:${mm}`;
}
