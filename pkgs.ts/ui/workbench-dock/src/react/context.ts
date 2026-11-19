// context.ts —— view 深处要拿 scope / api 时用 hook，不靠 prop 层层透传。

import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import type { PageApi, PageInfo, Scope } from '../model.js';

export interface PageContextValue {
    scope: Scope;
    page: PageInfo;
    api: PageApi;
}

export const PageContext = createContext<PageContextValue | null>(null);

/**
 * 当前 view 所在的页（scope + page 身份 + 区域控制面）。
 *
 * 泛型只能在这里补：`createContext` 没法声明「值里的 scope 是某个子类型」，
 * 而调用方（view）写的 `usePage<TaskScope>()` 自己要拿回具体类型。
 * 唯一的一处断言，因为提供方（PageWorkbench<S>）确实就是那个 S。
 */
export function usePage<S extends Scope = Scope>(): PageContextValue & { scope: S } {
    const value = useContext(PageContext);
    if (!value) throw new Error('usePage 必须在 <PageWorkbench> 的 view 里调用');
    return value as PageContextValue & { scope: S };
}

/** 只要区域控制面 */
export function usePageApi(): PageApi {
    return usePage().api;
}

/**
 * view 之间的共享状态：`useState` 的手感，但作用域是整个页实例（`PageApi.shared`）。
 *
 * ```tsx
 * const [selected, setSelected] = useShared<string>('selectedTask', tasks[0].id);
 * ```
 *
 * 和 `useState` 的三点差别（都是故意的，见 `SharedState`）：
 *   · 同 key 的所有 view 一起变 —— 这就是它存在的理由（列表点一下 → 详情跟着换）；
 *   · **不进布局、不持久化**：改它不会重编译（拖过的尺寸不动），换页（宿主换 `key`）就没了；
 *   · `initial` 只在「这个 key 从没被写过」时用一次，**必须是稳定引用**（字面量 / 模块级常量）——
 *     传内联对象会让快照每次都变（React 会警告并让你请吃不完的午饭）。
 */
export function useShared<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
    const { shared } = usePageApi();
    const subscribe = useCallback((listener: () => void) => shared.subscribe(key, listener), [shared, key]);
    // `??` 而不是 `||`：存进去的 `0` / `''` / `false` 都是合法值（只有 undefined 才回 initial）
    const getSnapshot = useCallback(() => (shared.get<T>(key) ?? initial) as T, [shared, key, initial]);
    const value = useSyncExternalStore(subscribe, getSnapshot);
    const setValue = useCallback(
        (next: T | ((prev: T) => T)) => {
            const prev = (shared.get<T>(key) ?? initial) as T;
            shared.set(key, typeof next === 'function' ? (next as (prev: T) => T)(prev) : next);
        },
        [shared, key, initial],
    );
    return [value, setValue];
}
