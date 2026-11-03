// registry.ts — 页面注册表：id → renderer 侧实现。
//
// 主进程给的是「有哪些页面」，这里给的是「每个页面怎么画」。两份按 id 对齐：
// 主进程有而这里没有 = 该页缺 renderer 实现（骨架显示提示，不崩）；反之不显示。

import { WorkbenchUiError } from "./errors.js";
import type { PageView } from "./contract.js";

const views = new Map<string, PageView>();

export function registerPage(view: PageView): void {
    if (!view || typeof view.id !== "string" || view.id.length === 0) {
        throw new WorkbenchUiError("ui-workbench/bad-page", "页面缺 id");
    }
    if (typeof view.title !== "string" || view.title.length === 0) {
        throw new WorkbenchUiError("ui-workbench/bad-page", `页面 ${view.id} 缺 title`);
    }
    if (typeof view.render !== "function") {
        throw new WorkbenchUiError("ui-workbench/bad-page", `页面 ${view.id} 缺 render`);
    }
    if (views.has(view.id)) {
        throw new WorkbenchUiError("ui-workbench/duplicate-page", `页面 id 重复注册：${view.id}`);
    }
    views.set(view.id, view);
}

export function getPage(id: string): PageView | undefined {
    return views.get(id);
}

/** 已注册的页面（单测 / 排障用；顺序 = 注册顺序） */
export function registeredPages(): PageView[] {
    return [...views.values()];
}

/** 清空注册表（单测用） */
export function resetPages(): void {
    views.clear();
}
