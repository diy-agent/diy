// TurnFooter —— 轮次的**最下面一行**：这一轮此刻在干什么 / 干完了是什么结果。
//
// 为什么把三样东西并进一行（用户 2026-11-24 的原话）：
//   · 运行中：「正在调用 bash… 44s」—— 就是那一行，不许在消息头再放一个胶囊；
//   · 运行中右侧：「已用 2m44s」—— 从**第一秒**就起算，不是等工具跑完才出现；
//   · 结束时：换成结算 `完成 · 3m12s · 12.4k tokens · 7 步 · 2 次工具`，右侧 `结束于 22:20`。
//
// 分工（别并回去）：
//   · 消息头只写**开始时刻**（`entry.turn.startedAt`，整轮不变）；
//   · 这一行写**进行到什么程度 / 最后怎么样**；
//   · 结局的解释（该做什么 / 上游原文）仍在时间线的 notice / error 条目里，这里只留一行。
//
// 数据全部来自服务端成对给出的 `turn.start` / `turn.end`（见 chat-core 的 `TurnFacts`）：
// 前端自己不估开始时刻、不事后算耗时 —— 两处各算一次，界面上就会有两个时间。

import { elapsedText, settleFactsOf, turnSettleOf, type TimelineEntry } from '@diy-agent/chat-core';
import * as React from 'react';

import { formatAtAbsolute, formatClock } from '../model';
import { RunningIndicator } from './RunningIndicator';
import { useNow } from './useNow';

const TONE_CLASS: Record<'muted' | 'warn' | 'bad', string> = {
    muted: 'text-muted-foreground',
    warn: 'text-amber-500',
    bad: 'text-red-400',
};

export function TurnFooter({
    entry,
    roomId,
    onStopBot,
}: {
    entry: TimelineEntry;
    roomId: string;
    /** 停某个成员（只有 live 时有意义）：从房间状态条挪进来了 —— 那里不再重复「谁在跑」 */
    onStopBot?: (botId: string) => void;
}) {
    // 还在跑：typing（一个字没吐）/ 有一段在流 / 工具跑完等下一段 —— 三者都算「这一轮没结束」
    const live = entry.streaming === true || entry.waiting === true;
    const settle = turnSettleOf(entry.turn);
    const startedAt = entry.turn?.startedAt ?? entry.at;
    const now = useNow(live);

    // 既没在跑、也没有结算事实（老数据 / 快照重放）：这一行不出现 —— 空行比假数据更吵
    if (!live && settle === undefined) return null;

    const facts = settleFactsOf(entry.turn);

    return (
        <div className="mt-2 flex items-center justify-between gap-3 border-t border-dashed pt-1.5 text-[12px] leading-4">
            <div className={`flex min-w-0 items-center gap-1.5 ${live ? 'text-muted-foreground' : TONE_CLASS[settle?.tone ?? 'muted']}`}>
                {live ? (
                    <>
                        {onStopBot !== undefined && entry.author !== undefined && (
                            <button
                                onClick={() => onStopBot(entry.author!.id)}
                                title="停这一轮"
                                className="shrink-0 rounded px-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                                停
                            </button>
                        )}
                        <RunningIndicator roomId={roomId} botId={entry.author?.id} />
                    </>
                ) : (
                    <>
                        <span
                            className={`inline-block size-1.5 shrink-0 rounded-full bg-current ${settle?.tone === 'muted' ? 'opacity-60' : ''}`}
                            aria-hidden="true"
                        />
                        <span className="shrink-0" title={settle?.detail ?? settle?.label}>
                            {settle?.label}
                        </span>
                        {facts.length > 0 && (
                            <span className="truncate opacity-80">· {facts.join(' · ')}</span>
                        )}
                    </>
                )}
            </div>
            <span className="shrink-0 tabular-nums text-muted-foreground" title={endTitleOf(entry)}>
                {live
                    ? `已用 ${elapsedText(Math.max(0, now - startedAt))}`
                    : entry.turn?.endedAt === undefined
                      ? ''
                      : `结束于 ${formatClock(entry.turn.endedAt, now)}`}
            </span>
        </div>
    );
}

function endTitleOf(entry: TimelineEntry): string | undefined {
    const endedAt = entry.turn?.endedAt;
    return endedAt === undefined ? undefined : `结束于 ${formatAtAbsolute(endedAt)}`;
}
