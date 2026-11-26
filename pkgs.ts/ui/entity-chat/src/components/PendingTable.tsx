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

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@diy-agent/ui-shadcn';

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
        // 官方的 Table 是 h-10 / p-2 的常规表；这张是诊断条，要的是密（py-1），
        // 所以每格把高度与内边距压回去，其余（行分隔线、hover、white-space）沿用组件的
        <Table className="border-t text-xs">
            <TableHeader className="text-muted-foreground">
                <TableRow className="hover:bg-transparent">
                    <TableHead className="h-auto px-3 py-1 font-normal">成员</TableHead>
                    <TableHead className="h-auto px-1 py-1 font-normal">在等</TableHead>
                    <TableHead className="h-auto px-1 py-1 text-right font-normal">多久没动</TableHead>
                    <TableHead className="h-auto px-1 py-1 font-normal">心跳</TableHead>
                    <TableHead className="h-auto px-3 py-1 font-normal">档位</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {rows.map(([botId, progress]) => (
                    <TableRow key={botId} className={progress.stage === 'stalled' ? 'text-destructive' : ''}>
                        <TableCell className="px-3 py-1">{bots[botId]?.name ?? botId}</TableCell>
                        <TableCell className="px-1 py-1 font-mono">{awaitingText(progress.awaiting)}</TableCell>
                        <TableCell className="px-1 py-1 text-right tabular-nums">
                            {elapsedText(idleNowOf(progress, now))}
                        </TableCell>
                        <TableCell className="px-1 py-1">
                            {progress.alive ? <span className="text-emerald-600">有</span> : '—'}
                        </TableCell>
                        <TableCell className="px-3 py-1">{STAGE_TEXT[progress.stage]}</TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
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
