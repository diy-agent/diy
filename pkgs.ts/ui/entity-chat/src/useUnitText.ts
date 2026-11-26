// useUnitText —— 「目标」视图里源码形态的数据源：模型实际读到的 `units` 节原文。
//
// 为什么单独一个 hook 而不是塞进 `useUnitBoard`：两者触发的时机不同 —— 树一直在轮询
// （看状态变化），原文只在人切到「源码」时才有必要拉。跟着树一起轮询会把一段 YAML 每 5 秒
// 重排一次 DOM（几十行 text 的 reflow 白费），所以这里由 `enabled` 把关。
import * as React from 'react';

import { diy2 } from './store';
import type { UnitTextView } from '@diy-agent/chat-transport-rpc';

const POLL_MS = 5000;

/**
 * `enabled=false` 时不拉取（保留上次结果）：源码形态是「按需看一眼」，
 * 跟树的 5 秒轮询一起跑纯属白花 RPC 与 DOM 重排。
 */
export function useUnitText(roomId: string, enabled = true): { view: UnitTextView | null; error: string | null } {
    const [view, setView] = React.useState<UnitTextView | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        if (!enabled) return;
        let alive = true;
        const load = (): void => {
            void diy2.units
                .text(roomId)
                .then((body) => {
                    if (!alive) return;
                    setView(body);
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
    }, [roomId, enabled]);

    return { view, error };
}
