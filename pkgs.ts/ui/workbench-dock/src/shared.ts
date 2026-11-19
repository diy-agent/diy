// shared.ts —— 页内共享状态（`PageApi.shared`）的实现。
//
// 纯 TS：不碰 React、不碰 DOM，所以 React view 的 `useShared`、vanilla view、以及将来
// 别的渲染器用的是同一个实现。语义只有三条（见 model.ts 的 `SharedState`）：
//
//   get(key)         没写过 → undefined
//   set(key, value)  值没变（Object.is）就不通知
//   subscribe(key)   只收这个 key 的变化；退订幂等
//
// 刻意不做的事：不做派生 / 不做批量事务 / 不做深层比较。它是「选中项」这个量级的通道，
// 想在里面跑状态机说明该用宿主的状态库了。

import type { SharedState } from './model.js';

export function createSharedState(): SharedState {
    const values = new Map<string, unknown>();
    const listeners = new Map<string, Set<() => void>>();

    return {
        get: <T = unknown>(key: string): T | undefined => values.get(key) as T | undefined,

        set: (key, value) => {
            // 同一个值不通知：view 常常在 render 里算出「选中项还是那一个」再写回去，
            // 每次通知都等于让所有订阅者再渲染一遍（`Object.is` 和 React 的 bail out 规则一致）
            if (Object.is(values.get(key), value)) return;
            values.set(key, value);
            const set = listeners.get(key);
            if (!set) return;
            // 先拍一份快照再遍历：监听器回调里可能退订别的监听器（React 卸载时就这么干），
            // 直接迭代 Set 的话「删掉的那个」会从当前迭代里消失，投递顺序就不确定了
            for (const listener of Array.from(set)) listener();
        },

        subscribe: (key, listener) => {
            const set = listeners.get(key) ?? new Set<() => void>();
            set.add(listener);
            listeners.set(key, set);
            return () => {
                set.delete(listener);
                if (set.size === 0) listeners.delete(key);
            };
        },
    };
}
