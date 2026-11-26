// RoomStatusBar —— 房间级的**两件静默**：谁在等你、谁没动。
//
// 它原先还管第三件「谁在跑」（2026-11-24 三合一）。用户当天又裁了一刀：
// **「正在调用 bash… 44s」只留一处 —— 轮次最下面那一行**（`TurnFooter`）。
// 于是这里删掉了 speaking chips：同一句话在两个位置出现，用户永远要猜哪个是准的；
// 而「这一轮跑得怎么样」本来就属于那一轮，不属于房间。
//
// 留下的两件都是**反向的静默**：它什么都没在做，但有东西正等着你 / 你发的话没人接。
// 这两件事在 2026-11-24 的现场（room 01a2091d…）里同时成立、同时没人看见 ——
// 提问挂 27 分钟没人答、用户 13:34 发的那条消息 `delivering` 到 14:00 也没落地，
// 而当时 `speaking=[]`，整屏没有任何信号，看着就是死了。
//
// 判据（这个组件唯一的职责）：
//   · 谁在等你 —— `asks`：说清是谁、问的什么、已等多久，并给一个跳过去的入口
//   · 谁没动   —— 投递还挂着但那个 bot 没有任何在动的证据（进程重启 / 队列丢了）
// 两件都没有 → 返回 null（不占位、不起时钟）。

import { deliveryNoteOf, waitTextOf, type AskRequest, type Bot, type Delivery } from '@diy-agent/chat-core';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import * as React from 'react';

import { jumpToAsk } from '../askJump';
import { askChipOf, askChipTitleOf } from '../pendingAsk';
import { conversationOf, useStore } from '../store';
import { useNow } from './useNow';

/** 一条 chip 的公共外形：两种状态只换颜色，不换骨架 */
const CHIP = 'flex items-center gap-1.5 rounded-full border px-2 py-0.5';

export interface StatusChipsProps {
    bots: Record<string, Bot>;
    asks: readonly AskRequest[];
    /**
     * 投递挂着、但对应 bot 没有在动（候选）。**阈值不在这里判** —— `deliveryNoteOf` 说
     * 15s 以内不值得说话，它返回 undefined 这一条就不显示。
     */
    stuck: readonly Delivery[];
    /** 本地时钟（秒级自走）：等多久、多久没动都靠它 */
    now: number;
    onJump: (askId: string) => void;
}

/** 纯渲染：不碰 store（SSR 就能测）。数据壳见下面的 `RoomStatusBar` */
export function StatusChips({ bots, asks, stuck, now, onJump }: StatusChipsProps) {
    const stuckLines = stuck.flatMap((delivery) => {
        const note = deliveryNoteOf({ state: delivery.state, updatedAt: delivery.updatedAt, live: false, now });
        return note === undefined ? [] : [{ delivery, note }];
    });
    if (asks.length === 0 && stuckLines.length === 0) return null;

    return (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs text-muted-foreground">
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
                    <span
                        key={`${delivery.messageId}\u0000${delivery.botId}`}
                        className={`${CHIP} border-destructive/40 text-destructive`}
                    >
                        <AlertTriangle className="size-3" />
                        <span>
                            {name} {note}
                        </span>
                    </span>
                );
            })}
        </div>
    );
}

/**
 * 数据壳：从会话状态取两件事实，交给 `StatusChips` 渲染。
 *
 * 为什么 `stuck` 用「queued/delivering 且该 bot 不在动」而不是「有 delivering 就显示」：
 * 正常一轮里投递和「正在跑」是同一段时间的两面，那时轮次底行已经有运行指示器 —— 再说一遍
 * 「未开跑」会让人以为消息没出去。需要它的是两者脱钩：轮次没起来，或者进程重启把队列丢了。
 *
 * `live` 仍然要算（只是不再渲染）：它是「脱钩」的判据，取自 speaking 与 progress 两处事实。
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

    // 两件事实都没有 → 不起时钟、不渲染。有候选时先跑起来：15s 那条阈值由 chip 自己判
    const active = state.asks.length > 0 || stuck.length > 0;
    const now = useNow(active);

    const onJump = React.useCallback((askId: string) => jumpToAsk(surfaceId, askId), [surfaceId]);

    return <StatusChips bots={shell.bots} asks={state.asks} stuck={stuck} now={now} onJump={onJump} />;
}
