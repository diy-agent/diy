// useBotProgress —— 只订阅**一个成员**的进展切片（不让 progress 每 5s 的更新惊动整个消息树）。
//
// 为什么要这个 hook、而不是把 state.progress 顺着 props 传下去：
// `progress` 事件在工具活跃时最多每 5s 一条；顺着 props 传会让 MessageList（memo 的整棵
// 时间线）每 5s 重渲一次。真正需要它的只有 RunningIndicator 这一个小组件。
//
// getSnapshot 必须**按字段比较再返回旧引用**：state 里任何变化（包括每一条 text.delta）
// 都会让 useSyncExternalStore 再调它；每次返回新对象 = 无限重渲。

import type { BotProgress } from '@diy-agent/chat-core';
import * as React from 'react';

import { conversationOf } from '../store';

function sameProgress(a: BotProgress, b: BotProgress): boolean {
    return (
        a.awaiting === b.awaiting && a.idleMs === b.idleMs && a.at === b.at && a.alive === b.alive && a.stage === b.stage
    );
}

export function useBotProgress(roomId: string | undefined, botId: string | undefined): BotProgress | undefined {
    const conversation = React.useMemo(() => (roomId === undefined ? undefined : conversationOf(roomId)), [roomId]);
    const cache = React.useRef<BotProgress | undefined>(undefined);

    const getSnapshot = React.useCallback((): BotProgress | undefined => {
        const next = conversation?.get().progress[botId ?? ''] ?? undefined;
        const prev = cache.current;
        if (prev === next) return prev;
        if (prev !== undefined && next !== undefined && sameProgress(prev, next)) return prev;
        cache.current = next;
        return next;
    }, [conversation, botId]);

    // 不能条件调用 hook：没房间时给一个空订阅（组件本来也不该在无房里渲染）
    const subscribe = React.useCallback(
        (listener: () => void) => conversation?.subscribe(listener) ?? (() => {}),
        [conversation],
    );
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
