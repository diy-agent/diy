/**
 * session-scan —— 「开机扫各任务账本」的**入队次序**（纯函数，##358 §10）。
 *
 * 【为什么要有次序】nav 的两个区（「待你处理」/「后台活动」）要回答"最近我在干啥"，
 * 判据落在**账本** `<task>.usage.jsonl`（落盘、跨启动）。账本只能**一个任务一次文件读**，
 * 任务一多，开机就是 N 次读排进同一条 FIFO 队列（`usageLedgerStore` 并发上限 4）
 * ⇒ **第一眼要看的几行**排在几百个老账本之后（数字会"迟到"，看着像没算）。
 *
 * 【打法】分两档，**都不丢任何任务**（次序变了，语义没变 —— 这是刻意的：
 * 「待你处理」是**全局聚合**，砍掉冷任务就等于"看不见历史欠账"）：
 *   · 热（`hot`，立即入队）：开着 tab 的 · 注册表里有活态的 · **非终态**任务的 · 最近 `updated` 的若干
 *     ——"最近的现场"必然落在这几类里；
 *   · 冷（`cold`，idle 切片慢慢补）：其余按 `updated` 降序到货一条更新一条，不跟热点抢队首。
 *
 * ⚠️ 本函数**只排序、不判断"要不要扫"**：`done` / `cancelled` 的任务照样在名单里
 *（它可能聊过、可能还有你没看的轮次）—— 只是排在后面。
 */

/** 终态：**非**终态 = 这活还没完 ⇒ 更可能是我"正在干的事" */
const TERMINAL = new Set(["done", "cancelled"]);

/** 立即入队的条数上限（`rank <= 2` 的行**不受此限**：那些本来就该最先看） */
export const SCAN_HOT_LIMIT = 24;

/** idle 每片补扫的条数（调用方按片推进；见 App.tsx 的 `drain`） */
export const SCAN_SLICE = 16;

export interface ScanHint {
    uri: string;
    /** tab 开着 ⇒ 用户此刻就看着它 */
    opened?: boolean;
    /** 注册表里有这个会话（本进程内活过）⇒ 有活态，界面上下一步就要用 */
    inRegistry?: boolean;
    /** 任务状态（api-def 的宽松 string）；`done` / `cancelled` 算终态 */
    state?: string;
    /** 任务最后编辑时刻（ISO）——"最近动过"的廉价近似（零额外 IO） */
    updated?: string;
}

export interface ScanPlan {
    hot: string[];
    cold: string[];
}

function msOf(iso?: string): number {
    const ms = Date.parse(iso ?? "");
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * @param hints 候选行（重复 uri 只取首个）
 * @param hotLimit 立即入队的条数上限
 */
export function scanPlanOf(hints: ScanHint[], hotLimit: number = SCAN_HOT_LIMIT): ScanPlan {
    const seen = new Set<string>();
    const rows: (ScanHint & { uri: string; rank: number })[] = [];
    for (const h of hints) {
        if (!h?.uri || seen.has(h.uri)) continue;
        seen.add(h.uri);
        const rank = h.opened ? 0 : h.inRegistry ? 1 : TERMINAL.has(h.state ?? "") ? 3 : 2;
        rows.push({ ...h, uri: h.uri, rank });
    }
    // 同名次内**新的先扫**：`updated` 是最接近"最近在干啥"的现成信号
    rows.sort((a, b) => a.rank - b.rank || msOf(b.updated) - msOf(a.updated));
    const hot: string[] = [];
    const cold: string[] = [];
    for (const r of rows) {
        // rank<=2（在看 / 有活态 / 没完的活）恒热；rank 3（终态的老账）只填满 hot 配额
        if (r.rank <= 2 || hot.length < hotLimit) hot.push(r.uri);
        else cold.push(r.uri);
    }
    return { hot, cold };
}
