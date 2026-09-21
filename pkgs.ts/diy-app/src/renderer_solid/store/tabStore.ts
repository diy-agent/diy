/**
 * tabStore — 打开的任务 tab（等同浏览器/编辑器开 tab）。
 *
 * 语义（与 133 设计一致）：
 *   - 打开 = 「我现在要做这个任务」；关闭 = 「暂时不理会」——**与任务状态无关**
 *   - 同一任务重复打开 → 聚焦已有 tab，不新开
 *   - 关闭后回任务树；无历史回溯（浏览历史未设计）
 *
 * 落位：视图 cache（Caches.diy_tabs_*）。丢了无数据损失，只是忘了开过哪些。
 * 将来归「任务特殊状态」管理。
 */
import { createSignal } from "solid-js";
import { Caches } from "../lib/ui-state";

const [opened, setOpened] = createSignal<string[]>(Caches.diy_tabs_opened.get());
const [active, setActiveSignal] = createSignal<string>(Caches.diy_tabs_active.get());

/** 写盘（只在真正变化时）——每个动作后调用一次，避免散落的 set+persist */
function persist(next: { opened?: string[]; active?: string }) {
    if (next.opened) {
        setOpened(next.opened);
        Caches.diy_tabs_opened.set(next.opened);
    }
    if (next.active !== undefined) {
        setActiveSignal(next.active);
        Caches.diy_tabs_active.set(next.active);
    }
}

export const tabStore = {
    /** 已打开的 tab URI（顺序 = 显示顺序） */
    get opened(): string[] {
        return opened();
    },
    /** 当前激活的 URI；"" = 没有激活的 tab（停在任务树） */
    get active(): string {
        return active();
    },
    /**
     * 打开（或聚焦）一个任务 tab。
     * 已存在 → 只切 active，**不改顺序**（顺序是用户心智中的位置，不该被点击重排）。
     */
    open(uri: string): void {
        const cur = opened();
        const next = cur.includes(uri) ? cur : [...cur, uri];
        persist({ opened: next, active: uri });
    },
    /** 关闭 tab：从列表移除；若关的是当前 tab，则激活右邻（无右邻取左邻），没有就回任务树 */
    close(uri: string): void {
        const cur = opened();
        const i = cur.indexOf(uri);
        if (i === -1) return;
        const next = cur.filter((u) => u !== uri);
        let nextActive = active();
        if (active() === uri) {
            nextActive = next[i] ?? next[i - 1] ?? "";
        }
        persist({ opened: next, active: nextActive });
    },
    /** 切到某个已打开的 tab（未打开则忽略，避免绕过 open 的语义） */
    activate(uri: string): void {
        if (!opened().includes(uri)) return;
        persist({ active: uri });
    },
    /** 回到任务树（不清空 tabs） */
    showTree(): void {
        persist({ active: "" });
    },
    /** 任务被删除时的清理（否则 tab 指向不存在的任务，点进去是空页） */
    drop(uri: string): void {
        if (!opened().includes(uri)) return;
        const cur = opened();
        const i = cur.indexOf(uri);
        const next = cur.filter((u) => u !== uri);
        const nextActive = active() === uri ? (next[i] ?? next[i - 1] ?? "") : active();
        persist({ opened: next, active: nextActive });
    },
};
