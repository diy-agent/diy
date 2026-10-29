// loader.ts — manifest 驱动的插件装配（思路同 ##455 的 runtime-resolve / loader）。
//
// 只做三件事（不做业务、不读文件、不碰具体页面）：
//   ① 按 `inject` 拓扑排序（依赖先加载；有环 ⇒ 抛错并列出环路径）
//   ② 逐个按**包名**动态 import（Node 解析，宿主不必知道包在磁盘哪里）
//   ③ 把模块归一成 PageContribution[]（`pages` 数组 / `default` / `apply` 三种写法任选）
//
// 加载器可注入（单测给假实现，不碰真模块表）。

import { WorkbenchError } from "./errors.js";
import type { PageContribution, PageMethod } from "./page.js";

/** 一个装配单元 = 一个 npm 包名 + 它的依赖（依赖只决定加载顺序，不传值） */
export interface PluginEntry {
    /** 装配单元 id（`inject` 用它；与页面 id 无关） */
    readonly id: string;
    /** npm 包名（可带子路径，如 `@scope/pkg/main`） */
    readonly name: string;
    /** 依赖哪些加载单元（先加载） */
    readonly inject?: readonly string[];
    /** 原样传给插件 default / apply 的配置 */
    readonly config?: unknown;
}

/** 模块加载器（默认用真 import；单测注入假实现） */
export type ModuleLoader = (name: string) => Promise<unknown>;

const defaultLoad: ModuleLoader = (name) => import(name);

/** 按 inject 拓扑排序：依赖先、依赖方后；同层保持传入顺序 */
export function orderPlugins(entries: readonly PluginEntry[]): PluginEntry[] {
    const byId = new Map<string, PluginEntry>();
    for (const entry of entries) {
        if (byId.has(entry.id)) {
            throw new WorkbenchError("workbench/duplicate-plugin", `装配单元 id 重复：${entry.id}`);
        }
        byId.set(entry.id, entry);
    }
    for (const entry of entries) {
        for (const dep of entry.inject ?? []) {
            if (!byId.has(dep)) {
                throw new WorkbenchError(
                    "workbench/missing-plugin",
                    `${entry.id} 依赖 ${dep}，但插件清单里没有 ${dep}`,
                );
            }
        }
    }

    const ordered: PluginEntry[] = [];
    const state = new Map<string, "visiting" | "done">();
    const stack: string[] = [];

    const visit = (id: string): void => {
        const current = state.get(id);
        if (current === "done") return;
        if (current === "visiting") {
            throw new WorkbenchError(
                "workbench/plugin-cycle",
                `插件依赖成环：${[...stack, id].join(" → ")}`,
            );
        }
        state.set(id, "visiting");
        stack.push(id);
        const entry = byId.get(id);
        if (!entry) throw new WorkbenchError("workbench/missing-plugin", `没有这个装配单元：${id}`);
        for (const dep of entry.inject ?? []) visit(dep);
        stack.pop();
        state.set(id, "done");
        ordered.push(entry);
    };

    for (const entry of entries) visit(entry.id);
    return ordered;
}

/**
 * 按清单加载并归一页面贡献。
 *
 * 模块归一规则（按优先级）：
 *   · 模块本身是数组            → 页面数组
 *   · `pages`（数组 / 单页）    → 页面
 *   · `default` 或 `apply`（函数）→ 调用（传 `config`），返回单页或数组
 *   · 以上都不是                → 抛 `workbench/plugin-shape`
 */
export async function loadPages(
    entries: readonly PluginEntry[],
    load: ModuleLoader = defaultLoad,
): Promise<PageContribution[]> {
    const pages: PageContribution[] = [];
    const seen = new Set<string>();
    for (const entry of orderPlugins(entries)) {
        let mod: unknown;
        try {
            mod = await load(entry.name);
        } catch (cause) {
            throw new WorkbenchError(
                "workbench/plugin-load",
                `加载插件 ${entry.name}（id=${entry.id}）失败：${cause instanceof Error ? cause.message : String(cause)}`,
            );
        }
        for (const page of pagesOf(mod, entry)) {
            if (seen.has(page.id)) {
                throw new WorkbenchError(
                    "workbench/duplicate-page",
                    `页面 id 重复：${page.id}（${entry.name} 与先前插件冲突）`,
                );
            }
            seen.add(page.id);
            pages.push(page);
        }
    }
    return pages;
}

function pagesOf(mod: unknown, entry: PluginEntry): PageContribution[] {
    const candidate = pickCandidate(mod);
    const value = typeof candidate === "function" ? (candidate as (config: unknown) => unknown)(entry.config) : candidate;
    const list = Array.isArray(value) ? value : [value];
    return list.map((raw) => parsePage(raw, entry));
}

function pickCandidate(mod: unknown): unknown {
    if (Array.isArray(mod)) return mod;
    if (mod && typeof mod === "object") {
        const record = mod as Record<string, unknown>;
        for (const key of ["pages", "default", "apply"] as const) {
            if (record[key] !== undefined) return record[key];
        }
    }
    return undefined;
}

function parsePage(raw: unknown, entry: PluginEntry): PageContribution {
    if (!raw || typeof raw !== "object") {
        throw new WorkbenchError(
            "workbench/plugin-shape",
            `插件 ${entry.name}（id=${entry.id}）没有产出页面对象（应为 { id, title, methods? }）`,
        );
    }
    const { id, title, methods } = raw as { id?: unknown; title?: unknown; methods?: unknown };
    if (typeof id !== "string" || id.length === 0) {
        throw new WorkbenchError("workbench/plugin-shape", `插件 ${entry.name} 的页面缺 id`);
    }
    if (typeof title !== "string" || title.length === 0) {
        throw new WorkbenchError("workbench/plugin-shape", `页面 ${id} 缺 title`);
    }
    if (methods !== undefined) {
        if (!methods || typeof methods !== "object") {
            throw new WorkbenchError("workbench/plugin-shape", `页面 ${id} 的 methods 必须是对象`);
        }
        for (const [name, fn] of Object.entries(methods)) {
            if (typeof fn !== "function") {
                throw new WorkbenchError("workbench/plugin-shape", `页面 ${id} 的方法 ${name} 不是函数`);
            }
        }
    }
    return { id, title, methods: methods as Record<string, PageMethod> | undefined };
}
