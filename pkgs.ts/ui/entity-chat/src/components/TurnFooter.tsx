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

import { Button } from '@diy-agent/ui-shadcn';

import { Code } from 'lucide-react';
import { formatAtAbsolute, formatClock } from '../model';
import { CopyButton } from './CopyButton';
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
    // 这一轮的**结论正文**（用户 2026-11-27：「源代码按钮不是显示轮次源代码，只是需要当前结论的
    // 内容，用来做沟通交流」）—— 所以给的是 bot 说的话本身，不是 JSON：复制它是为了贴给别人看，
    // `parts` / `deliveries` 那层结构对读的人没有意义。
    const conclusion = React.useMemo(
        () =>
            entry.parts
                .filter((part) => part.kind === 'text')
                .map((part) => part.text)
                .join('\n\n')
                .trim(),
        [entry],
    );
    const [showRaw, setShowRaw] = React.useState(false);

    // 既没在跑、也没有结算事实（老数据 / 快照重放）：这一行不出现 —— 空行比假数据更吵
    if (!live && settle === undefined) return null;

    const facts = settleFactsOf(entry.turn);

    return (
        <>
        <div className="mt-2 flex items-center justify-between gap-3 border-t border-dashed pt-1.5 text-xs leading-4">
            <div
                className={`flex min-w-0 items-center gap-1.5 ${live ? 'text-muted-foreground' : TONE_CLASS[settle?.tone ?? 'muted']}`}
            >
                {/* 操作在**左**、统计在**右**（用户 2026-11-27）：动作是「我要对它做点什么」，
                    跟状态结论一样是从左往右读的第一眼；时间那类数字是旁注，靠右。
                    收尾后才给：跑着的轮没有定论，复制下来只是半截。 */}
                {!live && conclusion !== '' && (
                    <>
                        <CopyButton
                            text={conclusion}
                            title="复制本轮结论正文"
                            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        />
                        <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => setShowRaw((value) => !value)}
                            title={showRaw ? '收起本轮结论' : '看本轮结论正文'}
                            aria-label="看本轮结论正文"
                            aria-expanded={showRaw}
                            className="shrink-0 text-muted-foreground"
                        >
                            <Code className="size-3" />
                        </Button>
                    </>
                )}
                {live ? (
                    <>
                        {onStopBot !== undefined && entry.author !== undefined && (
                            <Button
                                variant="ghost"
                                size="xs"
                                onClick={() => onStopBot(entry.author!.id)}
                                title="停这一轮"
                                className="h-5 shrink-0 px-1 text-muted-foreground"
                            >
                                停
                            </Button>
                        )}
                        {/* `since` / `stallable`：没有 progress 事实时（刚刷新）退到 180s 兜底；
                            waiting 不给 stallable —— 它的起点含已推进的内容，会误报（见 stuckHintOf） */}
                        <RunningIndicator
                            roomId={roomId}
                            botId={entry.author?.id}
                            since={startedAt}
                            stallable={entry.waiting !== true}
                        />
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
                        {facts.length > 0 && <span className="truncate opacity-80">· {facts.join(' · ')}</span>}
                    </>
                )}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
                <span className="tabular-nums text-muted-foreground" title={endTitleOf(entry)}>
                    {live
                        ? `已用 ${elapsedText(Math.max(0, now - startedAt))}`
                        : entry.turn?.endedAt === undefined
                          ? ''
                          : // 基准时间就用 `endedAt` 自己：`useNow(false)` 不起定时器、`now` 是
                            // 「挂载那一刻」的值 —— 拿它判跨天，跨过零点后还在开着的页面会把
                            // 本该写「22:20」的写成「11-24 22:20」。
                            `结束于 ${formatClock(entry.turn.endedAt, entry.turn.endedAt)}`}
                </span>
            </div>
        </div>
        {showRaw && (
            <div className="mt-1 max-h-72 overflow-auto rounded border border-border bg-muted/40 p-2 text-xs leading-5 whitespace-pre-wrap break-words select-text">
                {conclusion === '' ? <span className="text-muted-foreground">这一轮没有正文</span> : conclusion}
            </div>
        )}
        </>
    );
}

function endTitleOf(entry: TimelineEntry): string | undefined {
    const endedAt = entry.turn?.endedAt;
    return endedAt === undefined ? undefined : `结束于 ${formatAtAbsolute(endedAt)}`;
}
