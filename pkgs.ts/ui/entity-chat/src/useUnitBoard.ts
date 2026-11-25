// useUnitBoard —— 「分解」（树）与「文本」（模型读到的原文）两个视图**共用**的一份数据源。
//
// 为什么要抽：两个 tab 讲的是同一份 `units.list`，各写一份轮询会出现「一个 tab 刷新了、
// 另一个还是旧的」这种谁也说不清的现象；而且轮询节奏（5s）与错误处理也该只有一处。
//
// 为什么轮询而不是订阅事件：unit 只有 agent 写，改图频率是「分钟级」，不值得为它新开一种
// 事件类型（事件通道现在是给对话流用的）。要改成推送时，改这一个文件就够。
import * as React from 'react';

import { diy2 } from './store';
import type { UnitBoardView } from '@diy-agent/chat-transport-rpc';

const POLL_MS = 5000;

export function useUnitBoard(roomId: string): { board: UnitBoardView | null; error: string | null } {
    const [board, setBoard] = React.useState<UnitBoardView | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        let alive = true;
        const load = (): void => {
            void diy2.units
                .list(roomId)
                .then((body) => {
                    if (!alive) return;
                    setBoard(body);
                    setError(null);
                })
                .catch((cause: unknown) => {
                    if (alive) setError(cause instanceof Error ? cause.message : String(cause));
                });
        };
        load();
        const timer = setInterval(load, POLL_MS);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [roomId]);

    return { board, error };
}
