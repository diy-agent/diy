// context.ts —— view 深处要拿 scope / api 时用 hook，不靠 prop 层层透传。

import { createContext, useContext } from 'react';
import type { PageApi, PageInfo, Scope } from '../model.js';

export interface PageContextValue {
    scope: Scope;
    page: PageInfo;
    api: PageApi;
}

export const PageContext = createContext<PageContextValue | null>(null);

/** 当前 view 所在的页（scope + page 身份 + 区域控制面） */
export function usePage(): PageContextValue {
    const value = useContext(PageContext);
    if (!value) throw new Error('usePage 必须在 <PageWorkbench> 的 view 里调用');
    return value;
}

/** 只要区域控制面 */
export function usePageApi(): PageApi {
    return usePage().api;
}
