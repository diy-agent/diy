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
    // 这一轮的**结论正文**（用户 2026-11-28 澄清：「源代码按钮不是显示轮次源代码，
    // 只是需要当前结论的内容，用来做沟通交流用的」）—— 就是把本轮 bot 说的话拼起来，
    // 不带 tool 调用、不带 usage / turnId 那些元数据：它要能直接粘给别人看。
    const conclusion = React.useMemo(
        () =>
            entry.parts
                .filter((part): part is Extract<typeof part, { kind: 'text' }> => part.kind === 'text')
                .map((part) => part.text)
                .join('\n\n'),
        [entry],
    );
    const [showConclusion, setShowConclusion] = React.useState(false);

    // 既没在跑、也没有结算事实（老数据 / 快照重放）：这一行不出现 —— 空行比假数据更吵
    if (!live && settle === undefined) return null;

    const facts = settleFactsOf(entry.turn);

    return (
        <>
        <div className="mt-2 flex items-center justify-between gap-3 border-t border-dashed pt-1.5 text-xs leading-4">
            <div
                className={`flex min-w-0 items-center gap-1.5 ${live ? 'text-muted-foreground' : TONE_CLASS[settle?.tone ?? 'muted']}`}
            >
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
            {/* 操作在**左**、统计在**右**（用户 2026-11-28：按钮放最左边，统计信息放右侧）——
                按钮是可点的东西，贴着这一轮的正文左缘更容易找到；数字是阅读信息，靠右不挡眼。 */}
            {!live && conclusion !== '' && (
                <div className="flex shrink-0 items-center gap-0.5">
                    <CopyButton
                        text={conclusion}
                        title="复制这一轮的结论正文"
                        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    />
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setShowConclusion((value) => !value)}
                        title={showConclusion ? '收起结论' : '看这一轮的结论正文'}
                        aria-label="看这一轮的结论正文"
                        aria-expanded={showConclusion}
                        className="text-muted-foreground"
                    >
                        <Code className="size-3" />
                    </Button>
                </div>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-0.5 tabular-nums text-muted-foreground">
                <span title={endTitleOf(entry)}>
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
        {showConclusion && (
            <div className="mt-1 max-h-72 overflow-auto rounded border border-border bg-muted/40 p-2 text-xs leading-5 whitespace-pre-wrap break-words select-text">
                {conclusion}
            </div>
        )}
        </>
    );
}

function endTitleOf(entry: TimelineEntry): string | undefined {
    const endedAt = entry.turn?.endedAt;
    return endedAt === undefined ? undefined : `结束于 ${formatAtAbsolute(endedAt)}`;
}
