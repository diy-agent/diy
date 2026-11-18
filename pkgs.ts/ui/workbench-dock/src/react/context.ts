// context.ts —— view 深处要拿 scope / api 时用 hook，不靠 prop 层层透传。

import { createContext, useContext } from 'react';
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
