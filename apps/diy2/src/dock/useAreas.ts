// useAreas.ts —— 「哪些区域开着」的宿主侧状态。
//
// 为什么不是一行 `api.isAreaVisible(id)`：那是个读 dockview 实时状态的函数，**在 render 里调
// 会被 React Compiler 当纯函数缓存** —— 重渲也拿不到新值。实测（2026-11-22）页外浮层与诊断区的
// 五个指示灯永远全灭，而按钮本身能开能关（事件处理器里的调用不被缓存）。
//
// 所以：状态落进 state，订阅 `api.onAreasChange`（区域自己 toggle 也算），点完立刻同步一次。

import type { PageApi } from '@diy-agent/workbench-dock';
import { useCallback, useEffect, useState } from 'react';

export function useAreaStates(api: PageApi, ids: readonly string[]): Record<string, boolean> {
    const [states, setStates] = useState<Record<string, boolean>>({});

    const read = useCallback(() => {
        const next: Record<string, boolean> = {};
        for (const id of ids) next[id] = api.isAreaVisible(id);
        setStates(next);
    }, [api, ids]);

    useEffect(() => {
        read();
        const off = api.onAreasChange(read);
        return () => {
            off();
        };
    }, [read, api]);

    return states;
}
