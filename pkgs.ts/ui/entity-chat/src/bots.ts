// bots.ts —— 「每个席位一行状态」的界面副本（`botProfiles.rows` 的轮询 + 派生口径）。
//
// 二级浮层（只列要你看的）与三级全量表**读同一份数据、同一套口径**：数字与行都从这里的
// `needsYou` / `sortRows` 出来。两处各算一遍的话，「弹层说有 3 个、表格说有 4 个」这种
// 对不上是必然的（旧版就踩过，见 docs/plans/2026-11-24-job-ui.md 的遗留三条）。
//
// 为什么轮询：这份状态里有一半来自磁盘（上一轮怎么结束的），服务端没有为它推事件；
// 而「在跑」那半是内存态，1.5s 一拉也够看。作业 chip 用的是同一套节奏（1.2s / 5s）。
//
// 历史（2026-11-28，##43）：这套 `bots.ts` + `BotsOverlay.tsx` 在 2026-11-25 被整删过一次
// ——当时删的理由是建模（BotRole：bot 是类型级席位，不该有「每 bot 一行」），但服务端的
// `BotRow` 与 `bot-status.ts` 判据库留了下来，只是 RPC 与前端不见了。这次按留下的口径补回来，
// 一行 = 房间 × 席位。

import * as React from 'react';

import type { BotRow } from '@diy-agent/chat-transport-rpc';

import { diy2 } from './store';

/** 有人要你看 / 有东西在跑时的轮询间隔 */
const POLL_ACTIVE_MS = 1500;
/** 全空闲时慢一档：这张表没有推送来源 */
const POLL_IDLE_MS = 6000;

export const STATE_TEXT: Readonly<Record<BotRow['state'], string>> = {
    running: '在跑',
    asking: '等你回答',
    'needs-attention': '需要你看一眼',
    idle: '空闲',
};

/** 结局的一句话（与服务端 `outcomeText` 同一套说法；这里只管展示，不改判定） */
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
        case 'interrupted':
            return '上一轮被打断（没跑完）';
        case 'tool-mismatch':
            return '工具结果没回来';
        case 'failed':
            return row.outcomeMessage === undefined || row.outcomeMessage === ''
                ? '运行失败'
                : row.outcomeMessage;
    }
}

/**
 * 这一行要不要出现在**二级浮层**里。
 *
 * 用户 2026-11-25 定的口径：二级只列「活动的 + 出错的 + 等回答的」—— 也就是除 `idle`
 * 之外全部。`idle` 是「上次正常说完、现在没动」，它只属于三级表格。
 */
export function needsYou(row: BotRow): boolean {
    return row.state !== 'idle';
}

/** 同状态内的先后：在跑最前、等回答次之、需要看第三 —— 越靠上越急 */
const STATE_ORDER: Readonly<Record<BotRow['state'], number>> = {
    running: 0,
    asking: 1,
    'needs-attention': 2,
    idle: 3,
};

/** 需要人看的排前面；同状态按「最后动静」新→旧（没有动静的垫底） */
export function sortRows(rows: readonly BotRow[]): BotRow[] {
    return [...rows].sort((a, b) => {
        const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state];
        if (byState !== 0) return byState;
        return (b.lastTurnAt ?? 0) - (a.lastTurnAt ?? 0);
    });
}

export interface BotRowsState {
    rows: BotRow[];
    error: string | null;
    /** 拉过一次没有（区分「还在连」和「真的没有席位」） */
    loaded: boolean;
    reload: () => void;
}

/**
 * 行数据的界面副本。**可能是空的**：老服务端没有 `botProfiles.rows`，测试里的假客户端
 * 也只实现实际用到的那几项 —— 缺了就当「这台实例没有这份表」，不抛错、不白屏。
 */
function rowsApi(): { rows: () => Promise<{ rows: BotRow[] }> } | undefined {
    return (diy2.botProfiles as { rows?: () => Promise<{ rows: BotRow[] }> } | undefined) as
        | { rows: () => Promise<{ rows: BotRow[] }> }
        | undefined;
}

export interface RetryResult {
    started: Array<{ roomId: string; botIds: string[] }>;
    skipped: Array<{ roomId: string; botId: string; reason: string }>;
}

/** 批量「继续」（老客户端没有这条 API 时返回空结果，不抛） */
export async function retryRows(targets: ReadonlyArray<{ roomId: string; botId: string }>): Promise<RetryResult> {
    const api = diy2.botProfiles as unknown as {
        retry?: (t: ReadonlyArray<{ roomId: string; botId: string }>) => Promise<RetryResult>;
    };
    if (api.retry === undefined) return { started: [], skipped: [] };
    return api.retry(targets);
}

/**
 * `active` = 界面此刻是否看得见（浮层 / 抽屉开着）。看得见时用快档，
 * 看不见也照拉（标题栏那颗计数要活着），只是慢一档。
 */
export function useBotRows(active: boolean): BotRowsState {
    const [rows, setRows] = React.useState<BotRow[]>([]);
    const [error, setError] = React.useState<string | null>(null);
    const [loaded, setLoaded] = React.useState(false);
    const [tick, setTick] = React.useState(0);
    const busy = rows.some((row) => row.state === 'running' || row.state === 'asking');

    React.useEffect(() => {
        let alive = true;
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
                    setRows(back.rows);
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
        const every = active || busy ? POLL_ACTIVE_MS : POLL_IDLE_MS;
        const timer = setInterval(pull, every);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [active, busy, tick]);

    const reload = React.useCallback(() => setTick((value) => value + 1), []);
    return { rows, error, loaded, reload };
}

/** 绝对时刻：今天 `22:32`，跨天补 `11-24 22:32`（与侧栏同一口径，不写「3 分钟前」） */
export function fmtAt(at: number, now = Date.now()): string {
    const date = new Date(at);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const sameDay = new Date(now).toDateString() === date.toDateString();
    if (sameDay) return `${hh}:${mm}`;
    return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${hh}:${mm}`;
}
