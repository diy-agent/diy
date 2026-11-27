// useUnitRaw —— 一条需求的**原始存储**（库里那一行 + 步骤行 + journal 事件）
//
// 只在详情页切到「源码」时才拉：内容是 JSON，比视图那份大得多，没必要常驻轮询。
// 拉一次就够（库里的值不会自己变，变的是 agent 写），切回来再拉。
import * as React from 'react';

import { diy2 } from './store';
import type { UnitRawView } from '@diy-agent/chat-transport-rpc';

export function useUnitRaw(
    roomId: string,
    unitId: string,
    enabled: boolean,
): { raw: UnitRawView | null; error: string | null } {
    const [raw, setRaw] = React.useState<UnitRawView | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        if (!enabled) {
            setRaw(null);
            setError(null);
            return;
        }
        let alive = true;
        void diy2.units
            .raw(roomId, unitId)
            .then((view) => {
                if (!alive) return;
                setRaw(view);
                setError(null);
            })
            .catch((cause: unknown) => {
                if (alive) setError(cause instanceof Error ? cause.message : String(cause));
            });
        return () => {
            alive = false;
        };
    }, [roomId, unitId, enabled]);

    return { raw, error };
}
