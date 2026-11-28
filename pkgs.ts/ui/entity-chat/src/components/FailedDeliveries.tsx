// FailedDeliveries —— 「哪几条消息没送到」+ 重发（##43，2026-11-28）。
//
// 用户原话：「未送达，这个很难理解…… 人能干啥呢，也干不了啥吧」。
// 问题不在名字，在**不可行动**：侧栏一颗红叉，不知道是哪句话，也没有任何按钮。
// 这一块把那颗红叉变成能点开的一条一条 + 一个「重发」。
//
// 数据是懒拉的（点开才问 `deliveries.failed`）：失败很少见，不该占 `rooms.list` 的
// 30 秒轮询带宽；而「想处理时才问一次」正是它该有的成本。

import * as React from 'react';

import { Button, Popover, PopoverContent, PopoverTrigger } from '@diy-agent/ui-shadcn';

import { diy2 } from '../store';

interface FailedRow {
    roomId: string;
    messageId: string;
    botId: string;
    preview?: string;
    updatedAt: number;
}

function failedApi(): { failed: () => Promise<{ rows: FailedRow[] }> } | undefined {
    return (diy2.deliveries as { failed?: () => Promise<{ rows: FailedRow[] }> } | undefined) as
        | { failed: () => Promise<{ rows: FailedRow[] }> }
        | undefined;
}

function replayApi(): ((input: { roomId: string; messageId: string; botId: string }) => Promise<{ ok: boolean }>) | undefined {
    const api = diy2.deliveries as {
        replay?: (input: { roomId: string; messageId: string; botId: string }) => Promise<{ ok: boolean }>;
    };
    return api.replay;
}

const fmtAt = (at: number): string => {
    const date = new Date(at);
    const sameDay = new Date().toDateString() === date.toDateString();
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return sameDay ? `${hh}:${mm}` : `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${hh}:${mm}`;
};

/**
 * 侧栏那一行上的红叉（可点开）。
 *
 * `count` 来自 `rooms.list` 的投影（一个数字）；点开才去拉具体是哪几条 ——
 * 两处同源（都是 `state='failed'`），所以不会出现「说有 1 条却列不出来」。
 */
export function FailedDeliveriesBadge({ roomId, count }: { roomId: string; count: number }) {
    const [open, setOpen] = React.useState(false);
    const [rows, setRows] = React.useState<FailedRow[] | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [note, setNote] = React.useState<string | null>(null);

    const pull = React.useCallback(() => {
        const api = failedApi();
        if (api === undefined) {
            setRows([]);
            return;
        }
        void api
            .failed()
            .then((back) => setRows(back.rows.filter((row) => row.roomId === roomId)))
            .catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error)));
    }, [roomId]);

    React.useEffect(() => {
        if (!open) return;
        setRows(null);
        setNote(null);
        pull();
    }, [open, pull]);

    const replay = (row: FailedRow) => {
        const call = replayApi();
        if (call === undefined) {
            setNote('这个实例不支持重发（服务端版本较旧）');
            return;
        }
        setBusy(true);
        setNote(null);
        void call({ roomId: row.roomId, messageId: row.messageId, botId: row.botId })
            .then(() => {
                setNote('已重发 —— 旧的这条作废，新的那条在投递中了');
                pull();
            })
            .catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error)))
            .finally(() => setBusy(false));
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
                render={
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="text-rose-400"
                        title={`${count} 条消息没送到 —— 点开看是哪几条、可以重发`}
                        aria-label={`${count} 条消息没送到，点开处理`}
                    />
                }
            >
                <span className="text-xs tabular-nums">{count}</span>
            </PopoverTrigger>
            <PopoverContent side="right" align="start" aria-label="没送到的消息" className="w-80 p-2">
                <div className="px-1 pb-1 text-xs font-medium">
                    没送到的消息
                    <span className="ml-1 font-normal text-muted-foreground">这些 bot 没读到，可以重发</span>
                </div>
                {rows === null ? (
                    <p className="px-1 py-2 text-xs text-muted-foreground">正在读…</p>
                ) : rows.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-muted-foreground">没有失败记录了（可能已重发或已超保留期清理）</p>
                ) : (
                    <ul className="max-h-64 space-y-1 overflow-y-auto">
                        {rows.map((row) => (
                            <li
                                key={`${row.messageId}\u0000${row.botId}`}
                                className="flex items-start gap-2 rounded-md px-1 py-1 hover:bg-accent"
                            >
                                <div className="min-w-0 flex-1">
                                    <p className="line-clamp-2 text-xs text-foreground">
                                        {row.preview === undefined ? '（正文已被清理，超过保留期）' : row.preview}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        {row.botId} · {fmtAt(row.updatedAt)}
                                    </p>
                                </div>
                                <Button
                                    variant="outline"
                                    size="xs"
                                    disabled={busy || row.preview === undefined}
                                    title={row.preview === undefined ? '正文已清理，只能重新写一遍' : '把这条原话再发一遍'}
                                    onClick={() => replay(row)}
                                    className="shrink-0"
                                >
                                    重发
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
                {note === null ? null : <p className="px-1 pt-1 text-xs text-muted-foreground">{note}</p>}
            </PopoverContent>
        </Popover>
    );
}
