// loader.ts — 插件装配（思路同 ##455 的 runtime-resolve / loader）。
//
// 只做三件事（不做业务、不读文件、不碰具体页面）：
//   ① 按 `inject` 拓扑排序（依赖先加载；有环 ⇒ 抛错并列出环路径）
//   ② 取出每个装配单元的**模块本体**（宿主已经 import 好了；`load` 是懒加载等价物）
//   ③ 把模块归一成 PageContribution[]（`pages` 数组 / `default` / `apply` 三种写法任选）
//
// ##458：插件引用从「字符串包名 + 运行时 dynamic import」改成**宿主直接 import**。
// 判据：profile 里把包名写错一个字母 ⇒ tsc 立刻报 TS2307，不必等到起窗口。

import { WorkbenchError } from "./errors.js";
import type { PageContribution, PageMethod } from "./page.js";

/**
 * 装配单元（判别联合，判别键 `type`，规范见 `knowledge/facts/rule.yaml`
 * rule.code#discriminated-union）：与 `type` 同级 = 公共字段；分支私有的取法载荷进 `data`。
 */
export interface PluginEntryBase {
    /** 装配单元 id（`inject` 用它；与页面 id 无关） */
    readonly id: string;
    /** 依赖哪些装配单元（先装配） */
    readonly inject?: readonly string[];
    /** 原样传给插件 `default` / `apply` 的配置 */
    readonly config?: unknown;
}

/**
 * `module` 式（主推）：模块本体由宿主 `import * as pkg from "..."` 直接传进来。
 * 可以是模块命名空间 / 页面对象数组 / 单个页面对象 / 工厂函数；包名写错 ⇒ tsc 报错。
 */
export interface ModulePluginEntry extends PluginEntryBase {
    readonly type: "module";
    readonly data: { readonly module: unknown };
}

/** `load` 式：懒加载等价物（返回模块本体，形状同上） */
export interface LoadPluginEntry extends PluginEntryBase {
    readonly type: "load";
    readonly data: { readonly load: () => unknown | Promise<unknown> };
}

export type PluginEntry = ModulePluginEntry | LoadPluginEntry;

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
 * 按清单装配并归一页面贡献。
 *
 * 模块归一规则（按优先级）：
 *   · 模块本身是数组            → 页面数组
 *   · `pages`（数组 / 单页）    → 页面
 *   · `default` 或 `apply`（函数）→ 调用（传 `config`），返回单页或数组
 *   · 以上都不是                → 抛 `workbench/plugin-shape`
 */
export async function loadPages(entries: readonly PluginEntry[]): Promise<PageContribution[]> {
    const pages: PageContribution[] = [];
    const seen = new Set<string>();
    for (const entry of orderPlugins(entries)) {
        let mod: unknown;
        try {
            mod = await resolveModule(entry);
        } catch (cause) {
            throw new WorkbenchError(
                "workbench/plugin-load",
                `加载插件 ${entry.id} 失败：${cause instanceof Error ? cause.message : String(cause)}`,
            );
        }
        for (const page of pagesOf(mod, entry)) {
            if (seen.has(page.id)) {
                throw new WorkbenchError(
                    "workbench/duplicate-page",
                    `页面 id 重复：${page.id}（${entry.id} 与先前插件冲突）`,
                );
            }
            seen.add(page.id);
            pages.push(page);
        }
    }
    return pages;
}

async function resolveModule(entry: PluginEntry): Promise<unknown> {
    if (entry.type === "module") return entry.data.module;
    return await entry.data.load();
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
            `插件 ${entry.id} 没有产出页面对象（应为 { id, title, methods? }）`,
        );
    }
    const { id, title, methods } = raw as { id?: unknown; title?: unknown; methods?: unknown };
    if (typeof id !== "string" || id.length === 0) {
        throw new WorkbenchError("workbench/plugin-shape", `插件 ${entry.id} 的页面缺 id`);
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
