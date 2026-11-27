// useUnitDetail —— 点开一条需求时取它的全貌（需求 + 步骤 + 决策 + 过程记录）
//
// 为什么不并进 `useUnitBoard`：首屏只要需求层（125 条 × 每条带决策 = 每 5 秒搬几百条
// 用不到的详情）。只在**选中某条**时才拉一次，选中换人再拉。
import * as React from 'react';

import { diy2 } from './store';
import type { UnitDetailView } from '@diy-agent/chat-transport-rpc';

export function useUnitDetail(roomId: string, unitId: string | null): { detail: UnitDetailView | null; error: string | null } {
    const [detail, setDetail] = React.useState<UnitDetailView | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        if (unitId === null) {
            setDetail(null);
            setError(null);
            return;
        }
        let alive = true;
        const load = (): void => {
            void diy2.units
                .get(roomId, unitId)
                .then((view) => {
                    if (!alive) return;
                    setDetail(view);
                    setError(null);
                })
                .catch((err: unknown) => {
                    if (!alive) return;
                    setError(err instanceof Error ? err.message : String(err));
                });
        };
        load();
        // 与账本同样的 5 秒节奏：步骤状态是 bot 推的，人看着它动才对
        const timer = setInterval(load, 5_000);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [roomId, unitId]);

    return { detail, error };
}
