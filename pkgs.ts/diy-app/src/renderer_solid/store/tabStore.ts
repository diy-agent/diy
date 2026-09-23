/**
 * tabStore — 打开的页面 tab（等同浏览器/编辑器开 tab）。
 *
 * 从「URI 字符串」升级为「页面实例」（见 133「一页一中心」）：
 *   - pageId  — 哪一类页面（task-run / lab …）
 *   - ctx     — 上下文键（任务 URI）；子页面共享父的 ctx
 *   - parent  — 父 tab 的 key：子页面挂靠，关父连带关子
 *
 * 语义：
 *   - 打开 = 「我现在要做这个」；关闭 = 「暂时不理会」——**与任务状态无关**
 *   - 同一 (pageId, ctx) 重复打开 → 聚焦已有，不新开
 *   - 关闭后回任务管理页；无历史回溯（浏览历史未设计）
 *
 * 落位：视图 cache（Caches.diy_tabs_*）。丢了无数据损失，只是忘了开过哪些。
 * 将来归「任务特殊状态」管理。
 */
import { createSignal } from "solid-js";
import { Caches } from "../lib/ui-state";
import { findPage } from "../../shared/view-registry";

export interface TabItem {
    /** 唯一键：`<pageId>:<ctx>`；ctx 为空时就是 pageId */
    key: string;
    pageId: string;
    /** 上下文键（任务 URI）。子页面与父共享 */
    ctx: string | null;
    /** 父 tab 的 key（子页面挂靠；关父连带关子） */
    parent?: string;
}

const keyOf = (pageId: string, ctx: string | null): string => (ctx ? `${pageId}:${ctx}` : pageId);

/** 宽松清洗：结构不对的条目直接丢，不让脏数据把导航搞乱 */
function load(): TabItem[] {
    const raw = Caches.diy_tabs_opened.get();
    const out: TabItem[] = [];
    for (const v of raw ?? []) {
        // 兼容旧格式（纯 URI 字符串）：那时只有任务执行页
        if (typeof v === "string") {
            out.push({ key: keyOf("task-run", v), pageId: "task-run", ctx: v });
            continue;
        }
        const o = v as unknown as Record<string, unknown>;
        if (typeof o.pageId !== "string") continue;
        const ctx = typeof o.ctx === "string" ? o.ctx : null;
        out.push({
            key: typeof o.key === "string" ? o.key : keyOf(o.pageId, ctx),
            pageId: o.pageId,
            ctx,
            parent: typeof o.parent === "string" ? o.parent : undefined,
        });
    }
    // 按 key 去重：历史脏数据不该让导航出现两个同名 tab
    const seen = new Set<string>();
    return out.filter((t) => (seen.has(t.key) ? false : (seen.add(t.key), true)));
}

const [opened, setOpened] = createSignal<TabItem[]>(load());
const [active, setActiveSignal] = createSignal<string>(Caches.diy_tabs_active.get());

function persist(next: { opened?: TabItem[]; active?: string }) {
    if (next.opened) {
        setOpened(next.opened);
        Caches.diy_tabs_opened.set(next.opened as unknown as string[]);
    }
    if (next.active !== undefined) {
        setActiveSignal(next.active);
        Caches.diy_tabs_active.set(next.active);
    }
}

/** 某 tab 的父键（子页面用；顶级 tab 无父） */
function parentKeyOf(item: TabItem): string | undefined {
    if (item.parent) return item.parent;
    // 未显式声明父时，按注册表的 parentPage 推出（子页面的 ctx 与父相同）
    const def = findPage(item.pageId);
    if (!def?.parentPage) return undefined;
    return keyOf(def.parentPage, item.ctx);
}

export const tabStore = {
    /** 已打开的 tab（顺序 = 显示顺序，子页面紧跟父之后） */
    get opened(): TabItem[] {
        return opened();
    },
    /** 当前激活的 tab key；"" = 没有（停在任务管理页） */
    get active(): string {
        return active();
    },
    /** 按 key 找 tab */
    find(key: string): TabItem | undefined {
        return opened().find((t) => t.key === key);
    },
    /** 当前激活的 tab（对象） */
    activeTab(): TabItem | undefined {
        return tabStore.find(active());
    },

    /**
     * 打开（或聚焦）一个页面 tab。
     * 已存在 → 只切 active，**不改顺序**（顺序是用户心智中的位置）。
     * 子页面：插到父之后（不是队尾），否则导航里父子会被别的 tab 隔开。
     */
    open(pageId: string, ctx: string | null, parent?: string): void {
        const key = keyOf(pageId, ctx);
        const cur = opened();
        if (cur.some((t) => t.key === key)) {
            persist({ active: key });
            return;
        }
        const item: TabItem = { key, pageId, ctx, parent };
        // 插入位置：子页面插到父「及其已有关联子页面」之后；顶级 tab 追加到队尾。
        // ⚠️ 必须先在**不含 item 的列表**上算位置再插入 —— 曾经写成
        // `let next = [...cur, item]` 之后再 splice 插入 item，于是 item 出现两次
        // （实测：点一次「提示词」生成两个同名 tab）。
        const base = [...cur];
        let at = base.length;
        const p = parentKeyOf(item);
        if (p) {
            const i = base.findIndex((t) => t.key === p);
            if (i >= 0) {
                let j = i + 1;
                while (j < base.length && base[j]!.parent === p) j++;
                at = j;
            }
        }
        persist({ opened: [...base.slice(0, at), item, ...base.slice(at)], active: key });
    },

    /**
     * 关闭 tab。**关父连带关子**（子页面生命周期挂在父上）。
     * 若关掉的是当前 tab，激活右邻（无右邻取左邻），没有就回任务管理页。
     */
    close(key: string): void {
        const cur = opened();
        const i = cur.findIndex((t) => t.key === key);
        if (i === -1) return;
        // 连带收集子孙（多层也一并关）
        const doomed = new Set([key]);
        let grew = true;
        while (grew) {
            grew = false;
            for (const t of cur) {
                const p = parentKeyOf(t);
                if (p && doomed.has(p) && !doomed.has(t.key)) {
                    doomed.add(t.key);
                    grew = true;
                }
            }
        }
        const next = cur.filter((t) => !doomed.has(t.key));
        let nextActive = active();
        if (doomed.has(nextActive)) {
            nextActive = next[Math.min(i, next.length - 1)]?.key ?? next[i - 1]?.key ?? "";
        }
        persist({ opened: next, active: nextActive });
    },

    /** 切到某个已打开的 tab（未打开则忽略，避免绕过 open 的语义） */
    activate(key: string): void {
        if (!opened().some((t) => t.key === key)) return;
        persist({ active: key });
    },

    /** 回到任务管理页（不清空 tabs） */
    showTree(): void {
        persist({ active: "" });
    },

    /** 任务被删除时的清理：该任务的所有 tab（含子页面）一起摘掉 */
    dropCtx(ctx: string): void {
        const cur = opened();
        if (!cur.some((t) => t.ctx === ctx)) return;
        const doomed = new Set(cur.filter((t) => t.ctx === ctx).map((t) => t.key));
        const next = cur.filter((t) => !doomed.has(t.key));
        const nextActive = doomed.has(active()) ? (next[0]?.key ?? "") : active();
        persist({ opened: next, active: nextActive });
    },
};

export { keyOf as tabKeyOf };
