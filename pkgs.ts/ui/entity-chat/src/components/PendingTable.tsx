// PendingTable —— 「此刻谁卡在哪」的诊断面（刀 4）。
//
// 与 RunningIndicator 用**同一份** progress 事件（不额外拉接口）：它回答的是同一个问题的
// 详版 —— 「在等谁 / 多久没动 / 有没有心跳 / 到了哪一档」。默认折叠，因为它不是日常信息，
// 是「一眼答出卡在哪」的工具（计划 5.3）。
//
// 为什么按成员列而不是按 await 栈列：服务端只广播栈顶（`pending.at(-1)`）—— 那是"当前卡住
// 的就是它"的唯一判据。把整个栈塞进事件是为了给人看历史，收益远小于噪音。
//
// 拆成「容器 + 纯表格」：纯表格能不碰 store 直接 SSR 测（`PendingRows`），
// 而容器那层只负责订阅与每秒自走。诊断面的渲染逻辑不该因为要连 store 就没法测。

import type { Bot, BotProgress } from '@diy-agent/chat-core';
import { awaitingText, elapsedText, idleNowOf } from '@diy-agent/chat-core';
import * as React from 'react';

import { conversationOf, useStore } from '../store';

const STAGE_TEXT = { quiet: '正常', slow: '偏慢', stalled: '失联' } as const;

/** 纯表格：rows 为空时给一句「没有在跑的」 */
export function PendingRows({
    rows,
    bots,
    now,
}: {
    rows: Array<[string, BotProgress]>;
    bots: Record<string, Bot>;
    now: number;
}) {
    if (rows.length === 0) {
        return <p className="px-3 py-2 text-xs text-muted-foreground">现在没有正在跑的轮次</p>;
    }

    return (
        <table className="w-full border-t text-xs">
            <thead className="text-muted-foreground">
                <tr>
                    <th className="px-3 py-1 text-left font-normal">成员</th>
                    <th className="px-1 py-1 text-left font-normal">在等</th>
                    <th className="px-1 py-1 text-right font-normal">多久没动</th>
                    <th className="px-1 py-1 text-left font-normal">心跳</th>
                    <th className="px-3 py-1 text-left font-normal">档位</th>
                </tr>
            </thead>
            <tbody>
                {rows.map(([botId, progress]) => (
                    <tr key={botId} className={progress.stage === 'stalled' ? 'text-destructive' : ''}>
                        <td className="px-3 py-1">{bots[botId]?.name ?? botId}</td>
                        <td className="px-1 py-1 font-mono">{awaitingText(progress.awaiting)}</td>
                        <td className="px-1 py-1 text-right tabular-nums">{elapsedText(idleNowOf(progress, now))}</td>
                        <td className="px-1 py-1">
                            {progress.alive ? <span className="text-emerald-600">有</span> : '—'}
                        </td>
                        <td className="px-3 py-1">{STAGE_TEXT[progress.stage]}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

export function PendingTable({ roomId }: { roomId: string }) {
    const shell = useStore();
    const conversation = React.useMemo(() => conversationOf(roomId), [roomId]);
    const state = React.useSyncExternalStore(conversation.subscribe, conversation.get, conversation.get);
    const rows = Object.entries(state.progress);

    // 秒数自走：idleMs 只在事件到达时更新，这里每秒重算一次（没有在跑的就不开定时器）
    const [now, setNow] = React.useState(() => Date.now());
    const active = rows.length > 0;
    React.useEffect(() => {
        if (!active) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [active]);

    return <PendingRows rows={rows} bots={shell.bots} now={now} />;
}
