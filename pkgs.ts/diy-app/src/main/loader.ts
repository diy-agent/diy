// src/main/loader.ts
// 🎯 能力包 loader 骨架（##455 #6）：manifest 驱动的装配 —— 拓扑排序 + 环检测 + apply。
//
// 只做三件事（不做业务、不读 manifest 文件、不替换现有 import）：
//   ① 按 `inject` 拓扑排序（有环 ⇒ 抛错并列出环路径）
//   ② 逐个 `loadPackage(entry.name)`（复用 runtime-resolve.ts 的解析锚点）
//   ③ 调 `apply(ctx, config)`，返回值交给 `host.provide(id, …)`
//
// apply 约定：`export default function apply(ctx, config)` 或 `export function apply(...)`。
// `ctx` 就是 host —— 包之间只通过 `host.get(id)` 拿彼此，不互相 import。

import { InvariantError } from "@diy/context/format/invariant";
import { loadPackage } from "./runtime-resolve";

export interface LoaderEntry {
    /** 装配单元 id（host 里的键；`inject` 也用它） */
    id: string;
    /** npm 包名（runtime/ 里按名字解析） */
    name: string;
    /** 传给 apply 的配置（原样，不做校验） */
    config?: unknown;
    /** 依赖哪些 id（决定加载顺序） */
    inject?: string[];
}

export interface LoaderHost {
    /** 一个包被加载后，拿它注册的服务（key = id） */
    provide(id: string, value: unknown): void;
    get(id: string): unknown;
}

/** 可注入的加载器（单测替换用；缺省 = 真解析 runtime/ 里的包） */
export interface LoaderOptions {
    load?: (name: string) => Promise<unknown>;
}

type ApplyFn = (ctx: LoaderHost, config: unknown) => unknown;

/** 取模块里的 apply：`default` 函数优先，其次具名 `apply`；都没有 = 包不合约定 */
function applyOf(mod: unknown, entry: LoaderEntry): ApplyFn {
    if (typeof mod === "function") return mod as ApplyFn;
    if (mod && typeof mod === "object") {
        const { default: dflt, apply } = mod as { default?: unknown; apply?: unknown };
        if (typeof dflt === "function") return dflt as ApplyFn;
        if (typeof apply === "function") return apply as ApplyFn;
    }
    throw new InvariantError(
        "agent/loader-no-apply",
        `${entry.name}（id=${entry.id}）既没有 default 函数也没有具名 apply —— loader 不知道该怎么装配它`,
    );
}

/**
 * 拓扑排序：按 `inject` 决定加载顺序（依赖先、依赖方后）。
 *
 * 顺序**只由 inject 决定**，与 entries 的传入顺序无关 —— 这正是「打乱顺序仍按依赖加载」的判据。
 * 同层（互不依赖）保持传入顺序（稳定排序，便于日志可读）。
 */
export function orderEntries(entries: readonly LoaderEntry[]): LoaderEntry[] {
    const byId = new Map<string, LoaderEntry>();
    for (const entry of entries) {
        if (byId.has(entry.id)) throw new InvariantError("agent/loader-duplicate-id", `id 重复：${entry.id}`);
        byId.set(entry.id, entry);
    }
    for (const entry of entries) {
        for (const dep of entry.inject ?? []) {
            if (!byId.has(dep)) {
                throw new InvariantError("agent/loader-missing-dep", `${entry.id} 依赖 ${dep}，但 entries 里没有 ${dep}`);
            }
        }
    }

    const ordered: LoaderEntry[] = [];
    const state = new Map<string, "visiting" | "done">();
    const stack: string[] = [];

    const visit = (id: string): void => {
        const current = state.get(id);
        if (current === "done") return;
        if (current === "visiting") {
            // 环：从栈里 id 第一次出现的位置起就是环路径（末尾再补 id 闭合）
            const at = stack.indexOf(id);
            const cycle = [...stack.slice(at), id];
            throw new InvariantError("agent/loader-cycle", `依赖有环：${cycle.join(" → ")}`);
        }
        state.set(id, "visiting");
        stack.push(id);
        for (const dep of byId.get(id)?.inject ?? []) visit(dep);
        stack.pop();
        state.set(id, "done");
        ordered.push(byId.get(id)!);
    };

    for (const entry of entries) visit(entry.id);
    return ordered;
}

/**
 * 按拓扑顺序装配全部条目。
 *
 * @param entries 装配单元（顺序无关；由 `inject` 决定真实顺序）
 * @param host    provide/get 的宿主（loader 只调用这两个方法）
 * @param opts.load 可注入的包加载器（缺省 = runtime-resolve.ts 的 loadPackage）
 */
export async function loadAll(
    entries: readonly LoaderEntry[],
    host: LoaderHost,
    opts: LoaderOptions = {},
): Promise<void> {
    const load = opts.load ?? loadPackage;
    for (const entry of orderEntries(entries)) {
        const mod = await load(entry.name);
        const apply = applyOf(mod, entry);
        const result = await apply(host, entry.config);
        host.provide(entry.id, result);
    }
}
