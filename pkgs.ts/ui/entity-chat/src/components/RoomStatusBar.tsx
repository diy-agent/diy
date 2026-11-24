// RoomStatusBar —— 房间现在的三件事：**谁在跑、谁在等你、谁没动**。
//
// 它是 SpeakingBar 与 PendingAskStrip 的合并（2026-11-24）。合并的理由是现场：
// room 01a2091d… 里，提问挂着 27 分钟没人答、你发的那条消息 `delivering` 了 26 分钟，
// 而页面上一个字都没有 —— 因为这两件事各自只在"自己那种情况"下出现，而那一刻
// `speaking=[]`（没有一轮在跑），两条都让位，于是整屏静悄悄，看着就是死了。
//
// 判据（也是这个组件唯一的职责）：
//   · 谁在跑   —— `speaking` + `progress`：说清卡在哪个 await（工具/模型/压缩）
//   · 谁在等你 —— `asks`：**说清是谁、问的什么、已等多久**，并给一个跳过去的入口
//   · 谁没动   —— 投递还挂着但那个 bot 没有任何在动的证据（进程重启 / 队列丢了）：
//                这是"发了没人理"唯一可能的可见信号
//
// 只在**有事发生**时出现：三种都没有 → 返回 null（不要一条空边框）。
// 有东西出现时每秒自走一次（`useNow`），因为「已等 27m」和「失联 2m05s」本身就是信息。

import {
    deliveryNoteOf,
    doingText,
    progressLineOf,
    waitTextOf,
    type AskRequest,
    type Bot,
    type BotProgress,
    type Delivery,
} from '@diy-agent/chat-core';
import { AlertTriangle, HelpCircle, Square } from 'lucide-react';
import * as React from 'react';

import { jumpToAsk } from '../askJump';
import { askChipOf, askChipTitleOf } from '../pendingAsk';
import { conversationOf, useStore } from '../store';
import { useNow } from './useNow';

/** 一条 chip 的公共外形：三种状态只换颜色，不换骨架 */
const CHIP = 'flex items-center gap-1.5 rounded-full border px-2 py-0.5';

export interface StatusChipsProps {
    bots: Record<string, Bot>;
    speaking: readonly string[];
    progress: Record<string, BotProgress>;
    asks: readonly AskRequest[];
    /**
     * 投递挂着、但对应 bot 没有在动（候选）。**阈值不在这里判** —— `deliveryNoteOf` 说
     * 15s 以内不值得说话，它返回 undefined 这一条就不显示。
     */
    stuck: readonly Delivery[];
    /** 本地时钟（秒级自走）：等多久、多久没动都靠它 */
    now: number;
    onStop: (botId: string) => void;
    onStopAll: () => void;
    onJump: (askId: string) => void;
}

/** 纯渲染：不碰 store（SSR 就能测）。数据壳见下面的 `RoomStatusBar` */
export function StatusChips({ bots, speaking, progress, asks, stuck, now, onStop, onStopAll, onJump }: StatusChipsProps) {
    const stuckLines = stuck.flatMap((delivery) => {
        const note = deliveryNoteOf({ state: delivery.state, updatedAt: delivery.updatedAt, live: false, now });
        return note === undefined ? [] : [{ delivery, note }];
    });
    if (speaking.length === 0 && asks.length === 0 && stuckLines.length === 0) return null;

    return (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-1.5 text-[11px] text-muted-foreground">
            {speaking.map((botId) => {
                const bot = bots[botId];
                const item = progress[botId];
                const name = bot?.name ?? botId;
                // 跑工具时说「正在调用 bash…」而不是笼统的「正在说话…」；真卡住了就直接说失联
                const stalled = item?.stage === 'stalled';
                const line =
                    item === undefined ? '正在说话…' : stalled ? progressLineOf(item, now) : doingText(item.awaiting);
                return (
                    <span key={botId} className={`${CHIP} ${stalled ? 'border-destructive/50 text-destructive' : ''}`}>
                        <span className="size-2 animate-pulse rounded-full" style={{ background: bot?.color ?? '#9ca3af' }} />
                        <span>{name}</span>
                        <span>{line}</span>
                        <button
                            onClick={() => onStop(botId)}
                            title={`只停 ${name}`}
                            className="ml-0.5 flex items-center gap-0.5 rounded px-1 hover:bg-muted"
                        >
                            <Square className="size-2.5" />停
                        </button>
                    </span>
                );
            })}
            {asks.map((request) => {
                const owner = request.owner === undefined ? undefined : bots[request.owner];
                const waited = waitTextOf(request.at, now);
                return (
                    <span
                        key={request.askId}
                        className={`${CHIP} border-amber-500/50 bg-amber-500/10 text-amber-600`}
                        title={askChipTitleOf(request.questions)}
                    >
                        <HelpCircle className="size-3" />
                        <span className="shrink-0">{owner?.name ?? '有成员'} 等你回答</span>
                        <span className="max-w-[18rem] truncate">{askChipOf(request.questions)}</span>
                        {waited !== '' && <span className="shrink-0 opacity-80">· {waited}</span>}
                        <button
                            onClick={() => onJump(request.askId)}
                            className="ml-0.5 shrink-0 rounded px-1 font-medium underline-offset-2 hover:bg-amber-500/20"
                        >
                            去回答
                        </button>
                    </span>
                );
            })}
            {stuckLines.map(({ delivery, note }) => {
                const name = bots[delivery.botId]?.name ?? delivery.botId;
                return (
                    <span key={`${delivery.messageId}\u0000${delivery.botId}`} className={`${CHIP} border-destructive/40 text-destructive`}>
                        <AlertTriangle className="size-3" />
                        <span>
                            {name} {note}
                        </span>
                    </span>
                );
            })}
            {speaking.length > 0 && (
                <button
                    onClick={onStopAll}
                    title="停掉所有人"
                    className="ml-auto flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-muted"
                >
                    <Square className="size-2.5" />
                    全部停止
                </button>
            )}
        </div>
    );
}

/**
 * 数据壳：从会话状态取三种事实，交给 `StatusChips` 渲染。
 *
 * 为什么 `stuck` 用「queued/delivering 且该 bot 不在动」而不是「有 delivering 就显示」：
 * 正常一轮里投递和「正在跑」是同一段时间的两面，那时行尾已有运行指示器 —— 再说一遍
 * 「未开跑」会让人以为消息没出去（这是 2026-11 之前刻意不显示的理由，仍然成立）。
 * 需要它的是两者脱钩：轮次没起来，或者进程重启把队列丢了。
 */
export function RoomStatusBar({ roomId, surfaceId }: { roomId: string; surfaceId: string }) {
    const shell = useStore();
    const conversation = React.useMemo(() => conversationOf(roomId), [roomId]);
    const state = React.useSyncExternalStore(conversation.subscribe, conversation.get, conversation.get);

    const live = new Set<string>(state.speaking);
    for (const botId of Object.keys(state.progress)) live.add(botId);
    const stuck = state.deliveries.filter(
        (delivery) => (delivery.state === 'queued' || delivery.state === 'delivering') && !live.has(delivery.botId),
    );

    // 三种事实都没有 → 不起时钟、不渲染。有候选时先跑起来：15s 那条阈值由 chip 自己判
    const active = state.speaking.length > 0 || state.asks.length > 0 || stuck.length > 0;
    const now = useNow(active);

    const onJump = React.useCallback((askId: string) => jumpToAsk(surfaceId, askId), [surfaceId]);

    return (
        <StatusChips
            bots={shell.bots}
            speaking={state.speaking}
            progress={state.progress}
            asks={state.asks}
            stuck={stuck}
            now={now}
            onStop={(botId) => conversation.stop(botId)}
            onStopAll={() => conversation.cancel()}
            onJump={onJump}
        />
    );
}
