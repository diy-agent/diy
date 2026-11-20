// watch-cache.ts —— provider 值的**缓存归属**（机制层/runtime 不碰缓存）。
//
// 为什么在 provider 这一侧（用户 2026-11-20）：「runtime 不知道何时该缓存、缓存多久」——
// 只有 provider 知道自己读的是哪个文件树、哪些事件会让值失效。所以每个 provider 自己包一层：
// 第一次算完挂 `fs.watch`，事件到了重算；没有可 watch 的路径就**不缓存**（安全退化）。
//
// 注意：
//   · watcher `unref()` —— 不能因为缓存把进程钉住；
//   · 重算失败保留旧值（provider 的读盘抖动不该让一整轮发不出去）；
//   · key 由调用方拼全（含 cwd / 根目录），同 key 共享一份缓存与 watcher；
//   · 返回的函数**每次查缓存表**（不是捕获 entry）—— `clearWatchCache` 之后能重新建立。

import { watch, type FSWatcher } from 'node:fs';

interface Entry {
    value: unknown;
    watchers: FSWatcher[];
    timer?: NodeJS.Timeout;
}

const cache = new Map<string, Entry>();

export interface WatchedValueOptions {
    /** 目录是否递归 watch（默认 true；chain 只需要一层） */
    readonly recursive?: boolean;
}

/** 建立缓存 + watcher；一个 watcher 都挂不上 ⇒ null（调用方不缓存） */
function createEntry<T>(paths: readonly string[], compute: () => T, opts: WatchedValueOptions): Entry | null {
    const holder: Entry = { value: undefined, watchers: [] };
    for (const path of paths) {
        try {
            const watcher = watch(path, { recursive: opts.recursive ?? true }, () => {
                // 一次写入会连发多个事件：合并到一次重算（20ms 窗口）
                if (holder.timer !== undefined) return;
                holder.timer = setTimeout(() => {
                    holder.timer = undefined;
                    try {
                        holder.value = compute();
                    } catch {
                        /* 重算失败保留旧值 */
                    }
                }, 20);
                holder.timer.unref?.();
            });
            watcher.unref?.();
            holder.watchers.push(watcher);
        } catch {
            /* 路径不存在 / 平台不支持：这一路不 watch */
        }
    }
    if (holder.watchers.length === 0) return null;
    holder.value = compute();
    return holder;
}

/** 返回一个取值函数：命中缓存直接给；watch 到变化后重算 */
export function watchedValue<T>(
    key: string,
    paths: readonly string[],
    compute: () => T,
    opts: WatchedValueOptions = {},
): () => T {
    return () => {
        let entry = cache.get(key);
        if (entry === undefined) {
            const created = createEntry(paths, compute, opts);
            if (created === null) return compute();
            cache.set(key, created);
            entry = created;
        }
        return entry.value as T;
    };
}

/** 测试 / 诊断：关掉全部 watcher 并清缓存 */
export function clearWatchCache(): void {
    for (const entry of cache.values()) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        for (const watcher of entry.watchers) watcher.close();
    }
    cache.clear();
}
