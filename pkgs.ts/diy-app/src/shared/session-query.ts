// src/shared/session-query.ts
// 会话总览的**切片 / 过滤 / 排序** —— 纯函数（renderer 与单测共用，无 DOM 无 Node 依赖）。
//
// 为什么单独成文件（照 shared/task-list 的分法）：
//   ①「范围 / 状态切片 / 搜索 / 排序」是**可验证的规则**，塞进组件就只剩"界面上看着对"一种验证；
//   ② SessionOverviewPage 里已有"行模型合成 + 动作接线"，再混进过滤剪枝会看不清哪层在干什么。
//
// 边界：本文件只认 `SessionOverviewRow`（行模型）。谁把注册表/账本/任务树揉成行（`overviewRowOf`）
// 是上一层的事 —— 过滤与排序不该知道数据从哪来。
import type { SessionOverviewRow, SessionSlice } from "./session-overview";

/** 状态切片清单 = 过滤 chips 的**声明序**（也是展示序：越靠前越"该看"） */
export const SESSION_SLICES: readonly { key: SessionSlice; label: string; title: string }[] = [
    { key: "working", label: "在跑", title: "正在跑轮次（无人看也在跑，##305）" },
    { key: "stalled", label: "停滞", title: "在跑但心跳久了没动（疑似卡住）" },
    { key: "error", label: "异常终止", title: "上一轮非正常收尾，且你还没看过" },
    { key: "unread", label: "未读", title: "跑完了你还没看（1 轮 = 1 条未读消息）" },
    { key: "queued", label: "待投递", title: "有留言在队列里等投递" },
    { key: "talked", label: "已对话", title: "聊过、此刻没有新消息、也没在跑" },
];

const SLICE_SET = new Set<string>(SESSION_SLICES.map((s) => s.key));

/** 排序键（会话侧；与任务表的会话列不同 —— 这里没有"标题/状态"那些任务属性） */
export type SessionSortKey = "attention" | "lastActivity" | "unread" | "cost" | "tokens" | "steps";

export const SESSION_SORT_KEYS: readonly { key: SessionSortKey; label: string; title: string }[] = [
    { key: "attention", label: "该不该看", title: "该先看的排前面（在跑 > 异常 > 未读 > 待投递 > 已对话）" },
    { key: "lastActivity", label: "最后活动", title: "最后一次消息时间（跨启动）" },
    { key: "unread", label: "未读", title: "未读消息条数（1 轮 = 1 条）" },
    { key: "cost", label: "消费", title: "累计消费 $（账本，跨启动）" },
    { key: "tokens", label: "token", title: "累计 token（跨启动）" },
    { key: "steps", label: "步数", title: "累计步数（跨启动）" },
];

const SORT_KEY_SET = new Set<string>(SESSION_SORT_KEYS.map((s) => s.key));

/** 点一下先看"要紧那头"的键（时间/花费类降序；位次类升序 = 按"该不该看"的正确顺序） */
const DEFAULT_DESC_KEYS = new Set<SessionSortKey>(["lastActivity", "unread", "cost", "tokens", "steps"]);

export type SessionScope = "all" | "session";

export interface SessionQuerySpec {
    /** `all` = 含账本历史（默认）· `session` = 只看本次启动活跃过的（注册表口径） */
    scope: SessionScope;
    /** 选中的状态切片；**空 = 不按切片过滤**（等价"全部"） */
    slices: SessionSlice[];
    /** 搜索词（uri / 任务号 / 标题 / 项目；大小写不敏感） */
    query: string;
    sort: { key: SessionSortKey; dir: "asc" | "desc" };
}

export const DEFAULT_SESSION_QUERY: SessionQuerySpec = {
    scope: "all",
    slices: [],
    query: "",
    sort: { key: "attention", dir: "asc" },
};

/** `"attention:asc"` → spec 的一半；形状不对 / 不认识的键 → 回落默认（未知键不报错） */
export function parseSessionSort(raw: string | undefined): SessionQuerySpec["sort"] {
    if (!raw) return { ...DEFAULT_SESSION_QUERY.sort };
    const [key, dir] = raw.split(":");
    if (!key || !SORT_KEY_SET.has(key)) return { ...DEFAULT_SESSION_QUERY.sort };
    return { key: key as SessionSortKey, dir: dir === "desc" ? "desc" : "asc" };
}

export function formatSessionSort(s: SessionQuerySpec["sort"]): string {
    return `${s.key}:${s.dir}`;
}

/** 点排序键：同键翻方向；换键给该键"最常想看的开头" */
export function toggleSessionSort(cur: SessionQuerySpec["sort"], key: SessionSortKey): SessionQuerySpec["sort"] {
    if (cur.key === key) return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
    return { key, dir: DEFAULT_DESC_KEYS.has(key) ? "desc" : "asc" };
}

/** 切片列表 ↔ 存储字符串（`"working,unread"`）；不认识的键**丢弃**（旧版本存的切片名） */
export function parseSlices(raw: string | undefined): SessionSlice[] {
    if (!raw) return [];
    const out: SessionSlice[] = [];
    for (const p of raw.split(",")) {
        const k = p.trim();
        if (SLICE_SET.has(k) && !out.includes(k as SessionSlice)) out.push(k as SessionSlice);
    }
    return out;
}

export function formatSlices(s: SessionSlice[]): string {
    return s.join(",");
}

export function parseScope(raw: string | undefined): SessionScope {
    return raw === "session" ? "session" : "all";
}

/**
 * 「该不该看」位次（越小越前）—— 与 `sessionRowOf` 的 attention 同一套语义，
 * 但这里对着**行模型**（含账本-only 行）算，故另立（两处都指向同一件事，改动要成对）。
 */
export function attentionOf(r: SessionOverviewRow): number {
    switch (r.slice) {
        case "working":
            return 0;
        case "stalled":
            return 0;
        case "error":
            return 1;
        case "unread":
            return 2;
        case "queued":
            return 3;
        default:
            return 4;
    }
}

/** 各切片在当前行集里的条数（chips 上显示"这里有几个"；全 0 的 chip 置灰） */
export function sessionCounts(rows: readonly SessionOverviewRow[]): Record<SessionSlice, number> {
    const out = { working: 0, stalled: 0, error: 0, unread: 0, queued: 0, talked: 0 } as Record<SessionSlice, number>;
    for (const r of rows) out[r.slice] += 1;
    return out;
}

/**
 * 命中搜索词？空词恒真。匹配 uri / 任务号 / 标题 / 项目（大小写不敏感）。
 *
 * 任务号同时喂 `8` 与 `#8` 两种写法：界面上一律显示 `#8`（见列表行），
 * 用户照着屏幕敲就会带 `#` —— 只认 `8` 的话"照抄屏幕却搜不到"（实测踩到）。
 */
export function matchesQuery(r: SessionOverviewRow, q: string): boolean {
    if (!q) return true;
    const needle = q.toLowerCase();
    const hay = [r.uri, r.num, r.num ? `#${r.num}` : undefined, r.title, r.project];
    return hay.some((h) => !!h && h.toLowerCase().includes(needle));
}

/**
 * 过滤：范围 → 切片 → 搜索（顺序固定，便于解释"为什么这行在/不在"）。
 *
 * 范围是**结构性**的（账本-only 行 vs 注册表行），不是切片 —— 因为"本次启动活跃过"
 * 与"已对话"是**两个维度**：一个重启前聊过、本次启动聊过的会话，两个范围下都该在。
 */
export function filterSessionRows(rows: readonly SessionOverviewRow[], spec: SessionQuerySpec): SessionOverviewRow[] {
    const q = spec.query.trim();
    const slices = new Set(spec.slices);
    return rows.filter((r) => {
        if (spec.scope === "session" && !r.entry) return false;
        if (slices.size > 0 && !slices.has(r.slice)) return false;
        return matchesQuery(r, q);
    });
}

/** 可空值比较：**未设置恒排最后**（与 asc/desc 无关）—— 照 task-list 的 `cmpField` 语义 */
function cmpNum(a: number | undefined, b: number | undefined, sign: number): number {
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
    return sign * (a - b);
}

function cmpStr(a: string | undefined, b: string | undefined, sign: number): number {
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
    // ISO 8601（带 Z）字典序 == 时间序，无需 Date 解析
    return sign * (a < b ? -1 : a > b ? 1 : 0);
}

function cmpOf(key: SessionSortKey, a: SessionOverviewRow, b: SessionOverviewRow, sign: number): number {
    switch (key) {
        case "attention":
            return sign * (attentionOf(a) - attentionOf(b));
        case "unread":
            return cmpNum(a.unread, b.unread, sign);
        case "cost":
            // `null`（账本无价）与 `undefined`（未读到）都当"没有这个数" → 恒排最后
            return cmpNum(a.cost ?? undefined, b.cost ?? undefined, sign);
        case "tokens":
            return cmpNum(a.tokens, b.tokens, sign);
        case "steps":
            return cmpNum(a.steps, b.steps, sign);
        case "lastActivity":
            return cmpStr(a.lastActivity, b.lastActivity, sign);
    }
}

/** 排序（返回新数组）。同值时回落 uri 字典序 —— 让行序**稳定**（否则每次重算都在跳） */
export function sortSessionRows(rows: readonly SessionOverviewRow[], spec: SessionQuerySpec): SessionOverviewRow[] {
    const sign = spec.sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
        const d = cmpOf(spec.sort.key, a, b, sign);
        if (d !== 0) return d;
        return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
    });
}

/** 过滤 + 排序（总览页一行调完；顺序 = 先剪枝后排序，省得给注定被滤掉的行算比较） */
export function applySessionQuery(rows: readonly SessionOverviewRow[], spec: SessionQuerySpec): SessionOverviewRow[] {
    return sortSessionRows(filterSessionRows(rows, spec), spec);
}
