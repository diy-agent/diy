/**
 * tabStore — 打开的页面 tab（等同浏览器/编辑器开 tab）。
 *
 * 从「URI 字符串」升级为「页面实例」（见 133「一页一中心」）：
 *   - pageId  — 哪一类页面（task-run / lab …）
 *   - ctx     — 上下文键（任务 URI）；子页面共享父的 ctx
 *
 * 语义：
 *   - 打开 = 「我现在要做这个」；关闭 = 「暂时不理会」——**与任务状态无关**
 *   - 同一 (pageId, ctx) 重复打开 → 聚焦已有，不新开
 *   - 关闭后回任务管理页；无历史回溯（浏览历史未设计）
 *
 * ═══ 存储契约：**只存真信息，派生数据一律现算** ═══
 *
 * 持久化（视图 cache `diy_tabs_opened`）里只有 `{ pageId, ctx }[]`，顺序 = 显示顺序。
 * 这两个字段是**真输入**（「我开了哪个任务的哪类页面」），别的全是推导：
 *
 *   | 字段            | 是否落盘 | 来源                                        |
 *   |-----------------|---------|---------------------------------------------|
 *   | pageId / ctx    | ✅ 落盘  | 用户打开动作                                  |
 *   | key             | ❌       | `<pageId>:<ctx>`                             |
 *   | parent（页面层次）| ❌       | page 注册表的 parentPage（见 shared/tab-order） |
 *   | taskAncestors   | ❌       | 任务树现查（resolver 注入，本 store 不依赖 taskStore）|
 *
 * **曾经三条全被写进 localStorage**（打开那一刻的快照）→ 任务移动/改父后，
 * 树变了而盘上还躺着旧祖先链，「导航结构不变 / 缩进指向不存在的父」（见 165）。
 * 刷新页面也没用 —— 陈旧数据被原样读回。
 * 现在：树变 → resolver 读到 nodes signal 变 → `opened` 重算 → 排序与缩进自动跟上。
 *
 * 落位：视图 cache（Caches.diy_tabs_*）。丢了无数据损失，只是忘了开过哪些。
 */
import { createSignal } from "solid-js";
import { Caches } from "../lib/ui-state";
import { findPage } from "../../shared/view-registry";
import { insertionIndex, normalizeOrder, pageParentKeyOf, type TabLike } from "../../shared/tab-order";

/** TabItem 与 shared/tab-order 的 TabLike 结构一致（那边不 import 本文件，避免 store 互相依赖） */
export interface TabItem extends TabLike {
    /** 唯一键：`<pageId>:<ctx>`；ctx 为空时就是 pageId */
    key: string;
    pageId: string;
    /** 上下文键（任务 URI）。子页面与父共享 */
    ctx: string | null;
    /** 父 tab 的 key（**页面**层次）。派生：由 page 注册表 parentPage 推，不落盘 */
    parent?: string;
    /** 任务祖先链（**任务**层次：不含自己，从根到直接父）。派生：任务树现查，不落盘。
     *  用途：同链相邻（排序）+ 子任务缩进，见 shared/tab-order。 */
    taskAncestors?: string[];
}

/** 落盘/内存里的**真信息**：只有这两个字段（顺序即显示顺序） */
interface TabEntry {
    pageId: string;
    ctx: string | null;
}

const keyOf = (pageId: string, ctx: string | null): string => (ctx ? `${pageId}:${ctx}` : pageId);

/**
 * 读盘：只取 pageId / ctx，**其余字段一律丢弃不读**。
 *
 * 这一点是修复的关键 —— 旧版本存了 key / parent / taskAncestors，若沿用它们，
 * 任务改父后就永远显示旧结构（刷新也不会好）。这里主动丢掉，逼所有派生数据现算。
 * 兼容更早的纯 URI 字符串格式（那时只有任务执行页）。
 */
function load(): TabEntry[] {
    const raw = Caches.diy_tabs_opened.get();
    const out: TabEntry[] = [];
    const seen = new Set<string>();
    for (const v of raw ?? []) {
        let pageId: string;
        let ctx: string | null;
        if (typeof v === "string") {
            // 最早格式：纯任务 URI（那时只有 task-run 一种页面）
            pageId = "task-run";
            ctx = v;
        } else if (v && typeof v === "object") {
            const o = v as Record<string, unknown>;
            if (typeof o.pageId !== "string") continue; // 结构不对：丢
            pageId = o.pageId;
            ctx = typeof o.ctx === "string" ? o.ctx : null;
        } else {
            continue;
        }
        const key = keyOf(pageId, ctx);
        if (seen.has(key)) continue; // 按 key 去重：历史脏数据不该出现两个同名 tab
        seen.add(key);
        out.push({ pageId, ctx });
    }
    return out;
}

const [entries, setEntries] = createSignal<TabEntry[]>(load());
const [active, setActiveSignal] = createSignal<string>(Caches.diy_tabs_active.get());

/**
 * 任务祖先链解析器（由 App 注入：taskAncestorsOf）。
 *
 * 放 signal 而非普通变量：注入动作本身要能触发 `opened` 重算，否则首帧注入前
 * 算出的「无缩进」结果不会被刷新。store 之间仍不互相依赖 —— tabStore 不知道
 * taskStore 存在，只知道「有个函数能给我 ctx 的祖先链」。
 */
export type AncestorsResolver = (ctx: string) => string[] | undefined;
const [ancestorsResolver, setAncestorsResolverSignal] = createSignal<AncestorsResolver>(() => undefined);

function persist(next: { entries?: TabEntry[]; active?: string }) {
    if (next.entries) {
        setEntries(next.entries);
        Caches.diy_tabs_opened.set(next.entries);
    }
    if (next.active !== undefined) {
        setActiveSignal(next.active);
        Caches.diy_tabs_active.set(next.active);
    }
}

/** 某 tab 的父键（子页面用；顶级 tab 无父）—— 判据在 shared/tab-order（与排序同源） */
const parentKeyOf = (item: TabLike): string | undefined =>
    pageParentKeyOf(item, (pid) => findPage(pid)?.parentPage);

/**
 * TabEntry → 富视图：把 key / parent / taskAncestors 全部现算出来。
 *
 * 带一层**对象复用**：读点很多（侧栏 For、面包屑、ui tab list…），若每次现算都产
 * 新对象，Solid 的 For 会把所有 tab 节点推倒重建（闪、丢 hover）。故按「祖先链
 * 签名」缓存 —— 只有真变了才换对象，其余情况复用同一个引用。
 *
 * 为什么不直接用 createMemo：模块级 memo 没有订阅者时不会自动重算（实测 Solid 1.9
 * 的 memo 在无 observer 时读到的是陈旧值），store 单例恰好没有固定 owner，靠不住。
 */
const itemCache = new Map<string, { sig: string; item: TabItem }>();

function toItem(e: TabEntry): TabItem {
    const key = keyOf(e.pageId, e.ctx);
    const taskAncestors = e.ctx ? ancestorsResolver()(e.ctx) : undefined;
    const sig = (taskAncestors ?? []).join("\u0000");
    const hit = itemCache.get(key);
    if (hit && hit.sig === sig) return hit.item;

    const pp = findPage(e.pageId)?.parentPage;
    const item: TabItem = {
        key,
        pageId: e.pageId,
        ctx: e.ctx,
        parent: pp ? `${pp}:${e.ctx ?? ""}` : undefined,
        taskAncestors,
    };
    itemCache.set(key, { sig, item });
    return item;
}

/**
 * 已打开的 tab（富视图，顺序 = 显示顺序）。
 *
 * 每次读都现算 + 规范化顺序：读 `ancestorsResolver()` 会追踪任务树 signal，故在
 * 渲染上下文里读取即自动订阅 —— 任务移动/改父后排序与缩进自动跟上，**不需要任何
 * 「reconcile」入口**，也不需要在 loadTree 后手工补一步。
 */
function items(): TabItem[] {
    return normalizeOrder(entries().map(toItem), (pid) => findPage(pid)?.parentPage) as TabItem[];
}

const toEntry = (t: TabLike): TabEntry => ({ pageId: t.pageId, ctx: t.ctx });

export const tabStore = {
    /** 已打开的 tab（顺序 = 显示顺序，子页面紧跟父之后） */
    get opened(): TabItem[] {
        return items();
    },
    /** 当前激活的 tab key；"" = 没有（停在任务管理页） */
    get active(): string {
        return active();
    },
    /** 按 key 找 tab */
    find(key: string): TabItem | undefined {
        return items().find((t) => t.key === key);
    },
    /** 当前激活的 tab（对象） */
    activeTab(): TabItem | undefined {
        return tabStore.find(active());
    },

    /** 注入任务祖先链解析器（App 侧：从任务树现查）。注入即触发重算。
     *  注意：必须包一层 `() => fn` —— Solid 的 setter 把「函数入参」当 updater 调用，
     *  直接 set(fn) 会立刻以 prev 调 fn 并把返回值当新值。 */
    setAncestorsResolver(fn: AncestorsResolver): void {
        setAncestorsResolverSignal(() => fn);
    },

    /**
     * 打开（或聚焦）一个页面 tab。
     * 已存在 → 只切 active，**不改顺序**（顺序是用户心智中的位置）。
     * 子页面：插到父之后（不是队尾），否则导航里父子会被别的 tab 隔开。
     */
    open(pageId: string, ctx: string | null): void {
        const key = keyOf(pageId, ctx);
        const cur = items();
        if (cur.some((t) => t.key === key)) {
            persist({ active: key });
            return;
        }
        // 插入位置由 shared/tab-order 决定（页面层次 + 任务层次两条规则）。
        // ⚠️ 必须先在**不含 item 的列表**上算位置再插入 —— 曾经写成
        // `let next = [...cur, item]` 之后再 splice 插入 item，于是 item 出现两次
        // （实测：点一次「提示词」生成两个同名 tab）。
        const item = toItem({ pageId, ctx });
        const at = insertionIndex(item, cur, (pid) => findPage(pid)?.parentPage);
        const next = [...cur.slice(0, at), item, ...cur.slice(at)];
        // 写回的是规范化后的**顺序**（真信息只有 pageId/ctx），派生字段不落盘
        persist({ entries: next.map(toEntry), active: key });
    },

    /**
     * 关闭 tab。**关父连带关子**（子页面生命周期挂在父上）。
     * 若关掉的是当前 tab，激活右邻（无右邻取左邻），没有就回任务管理页。
     */
    close(key: string): void {
        const cur = items();
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
        persist({ entries: next.map(toEntry), active: nextActive });
    },

    /** 切到某个已打开的 tab（未打开则忽略，避免绕过 open 的语义） */
    activate(key: string): void {
        if (!entries().some((e) => keyOf(e.pageId, e.ctx) === key)) return;
        persist({ active: key });
    },

    /** 回到任务管理页（不清空 tabs） */
    showTree(): void {
        persist({ active: "" });
    },

    /** 任务被删除时的清理：该任务的所有 tab（含子页面）一起摘掉 */
    dropCtx(ctx: string): void {
        const cur = entries();
        if (!cur.some((e) => e.ctx === ctx)) return;
        const next = cur.filter((e) => e.ctx !== ctx);
        const nextActive = next.some((e) => keyOf(e.pageId, e.ctx) === active()) ? active() : (next[0] ? keyOf(next[0].pageId, next[0].ctx) : "");
        persist({ entries: next, active: nextActive });
    },
};

export { keyOf as tabKeyOf };
