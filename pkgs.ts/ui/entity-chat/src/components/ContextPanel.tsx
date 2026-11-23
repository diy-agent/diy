// ContextPanel —— 每个 bot 的上下文占了多少、什么时候压过、现在压一次。
//
// 位置在房间头部的元信息行：同一个组件给两个 surface 用（壳层，不在 surface 里）。

import { Gauge, Scissors } from 'lucide-react';
import * as React from 'react';

import type { Room, SessionInfo } from '@diy-agent/chat-core';

import { contextWindowOf } from '../models';
import { actions, useProviders, useStore } from '../store';

/** 实测：中文 + JSON 结构下约 0.78 token / 字符（diy2 实测 522 tok ↔ 674 chars） */
const TOKENS_PER_CHAR = 0.78;

function tokensOf(chars: number): number {
    return Math.round(chars * TOKENS_PER_CHAR);
}

function fmt(value: number): string {
    return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function timeOf(at: number | undefined): string {
    if (at === undefined) return '—';
    const date = new Date(at);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function Row({ session, busy, onCompact }: { session: SessionInfo; busy: boolean; onCompact: () => void }) {
    const { stats } = session;
    const used = tokensOf(stats.chars);
    return (
        <div className="border-t px-3 py-2 first:border-t-0">
            <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium">{session.name}</span>
                <span className="text-[11px] text-muted-foreground">
                    {stats.entries} 条 · ≈{fmt(used)} tok
                </span>
                <button
                    onClick={onCompact}
                    disabled={busy}
                    className="ml-auto flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted disabled:opacity-50"
                >
                    <Scissors className="size-3" />
                    {busy ? '压缩中…' : '压缩'}
                </button>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
                <span>策略 {stats.strategy}</span>
                <span>压过 {stats.compactions} 次</span>
                {stats.collapsed > 0 && <span>已折叠 {stats.collapsed} 条</span>}
                {stats.lastCompactAt !== undefined && <span>上次 {timeOf(stats.lastCompactAt)}</span>}
                {stats.usage !== undefined && <span>上轮实测 {fmt(stats.usage.inputTokens)} tok</span>}
            </div>
        </div>
    );
}

export function ContextPanel({ room }: { room: Room }) {
    const state = useStore();
    const providers = useProviders();
    const sessions = state.sessions[room.id] ?? [];
    const [open, setOpen] = React.useState(false);
    const [busy, setBusy] = React.useState<string | null>(null);
    const [note, setNote] = React.useState<string | null>(null);
    /** 手动压缩用；默认跟随后端预算，改了只影响手动那一下 */
    const [keepLast, setKeepLast] = React.useState<number | null>(null);
    const [maxChars, setMaxChars] = React.useState<number | null>(null);
    const serverBudget = sessions[0]?.stats.budget;
    const keep = keepLast ?? serverBudget?.keepLast ?? 12;
    const chars = maxChars ?? serverBudget?.maxChars ?? 24000;

    const windowTokens = contextWindowOf(providers, room.modelKey);
    const used = sessions.reduce((sum, session) => sum + tokensOf(session.stats.chars), 0);
    const ratio = windowTokens === undefined || windowTokens === 0 ? undefined : used / windowTokens;

    // 打开面板时拉一次，之后定时刷（后台还有 bot 在跑，推不动就轮询）
    React.useEffect(() => {
        actions.refreshSessions(room.id);
        const timer = setInterval(() => actions.refreshSessions(room.id), 4000);
        return () => clearInterval(timer);
    }, [room.id]);

    const compress = async (botId: string) => {
        setBusy(botId);
        setNote(null);
        const outcome = await actions.compactSession(room.id, botId, { keepLast: keep, maxChars: chars });
        setBusy(null);
        if (outcome === null) {
            setNote('压缩失败（后端未响应）');
            return;
        }
        const event = outcome.event;
        const name = sessions.find((session) => session.botId === botId)?.name ?? botId;
        setNote(
            event === null
                ? `${name}：没有可压缩的内容`
                : `${name}：${event.before.entries} → ${event.after.entries} 条（折叠 ${event.folded}，丢弃 ${event.dropped}）`,
        );
    };

    const compressAll = async () => {
        for (const session of sessions) await compress(session.botId);
    };

    return (
        <span className="relative ml-2 inline-flex">
            <button
                onClick={() => setOpen((value) => !value)}
                title="查看每个 bot 的上下文占用，手动压缩"
                className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
            >
                <Gauge className="size-3" />
                上下文 {fmt(used)}
                {windowTokens !== undefined && <span className="opacity-60">/ {fmt(windowTokens)}</span>}
                {ratio !== undefined && <span className="opacity-60">({Math.round(ratio * 100)}%)</span>}
            </button>

            {open && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
                    <div className="absolute left-0 top-full z-50 mt-1 w-[360px] rounded-md border bg-background shadow-lg">
                        <div className="flex items-center gap-2 px-3 py-2">
                            <span className="text-[11px] font-medium">上下文</span>
                            <span className="text-[10px] text-muted-foreground">
                                {windowTokens === undefined ? '窗口未知' : `窗口 ${fmt(windowTokens)} tok`} · 各 bot
                                独立压缩
                            </span>
                            <button
                                onClick={() => void compressAll()}
                                disabled={busy !== null || sessions.length === 0}
                                className="ml-auto rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted disabled:opacity-50"
                            >
                                全部压缩
                            </button>
                        </div>

                        <div className="flex items-center gap-1.5 border-t px-3 py-1.5 text-[10px] text-muted-foreground">
                            <span>保留</span>
                            <input
                                type="number"
                                min={1}
                                value={keep}
                                onChange={(event) => setKeepLast(Number(event.target.value))}
                                className="w-12 rounded border bg-transparent px-1 text-right"
                            />
                            <span>条 · 预算</span>
                            <input
                                type="number"
                                min={100}
                                step={100}
                                value={chars}
                                onChange={(event) => setMaxChars(Number(event.target.value))}
                                className="w-20 rounded border bg-transparent px-1 text-right"
                            />
                            <span>字符（超了自动压）</span>
                        </div>

                        {sessions.length === 0 ? (
                            <p className="border-t px-3 py-3 text-[11px] text-muted-foreground">
                                还没有会话（发一条消息再回来看）
                            </p>
                        ) : (
                            sessions.map((session) => (
                                <Row
                                    key={session.botId}
                                    session={session}
                                    busy={busy === session.botId}
                                    onCompact={() => void compress(session.botId)}
                                />
                            ))
                        )}

                        {note !== null && (
                            <p className="border-t px-3 py-2 text-[10px] text-muted-foreground">{note}</p>
                        )}
                    </div>
                </>
            )}
        </span>
    );
}
