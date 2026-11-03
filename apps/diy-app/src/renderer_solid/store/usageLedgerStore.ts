/**
 * usageLedgerStore — 任务会话的**账本事实**（「已对话」/「累计消费」）唯一来源（##358）。
 *
 * 【数据源】复用**既有** RPC `agent.local.usage`（读 `<key>.usage.jsonl`，一步一条账）。
 *
 * 【为什么另起 store，不并进 sessionStore】
 *   两者生命周期**不同**：
 *     · `sessionStore` = **注册表**（主进程推帧）—— **进程性**：重启即空，这是 ##305 的定案事实；
 *     · 本 store = **账本**（落盘的历史）—— **跨启动**：重启后仍能回答"这个任务我聊过"。
 *   把跨启动的事实塞进进程性的表，会让"重启后清零"的语义污染它（界面会跟着说"没聊过"）。
 *
 * 【为什么不加进注册表帧】##358 硬边界：不得新增后端 RPC / 注册表字段（要动 ⇒ 回炉
 *   [4] ##240）。故这里纯 renderer 现算。
 *
 * 【代价与限流】一个任务 = 一次文件读（几 KB ~ 几百 KB，实测 145KB 封顶）。
 *   任务表几百行全拉会打爆 → ① 按 uri **永久缓存**（拉到就不再拉）② **并发上限 4**
 *   ③ 失败**不缓存假值**（保持"未知"，下次仍会试；界面显示 "—" 而不是 0）。
 *
 * ⚠️ 与 `localChatStore.usage` 的关系：那是**当前打开的那个会话**的账本镜像（轮末刷新，
 *   给用量面板 L3 用）；本 store 是**全任务**的轻量事实（只为标"已对话/花了多少"）。
 *   两者读同一份盘上账本，口径不冲突 —— 不要合并（一个跟页面走，一个跟任务表走）。
 */
import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";
import type { StepUsageRecord } from "../../shared/usage";

export interface TaskLedgerFacts {
    /** 账本里有没有内容 = 这个任务**聊过**（会话已对话）。`false` 只代表"读到且为空" */
    started: boolean;
    /** 累计消费（$）；`null` = 账本里**一条带价的都没有**（不编 0 —— 0 是"真花过 0"） */
    cost: number | null;
    /**
     * 账本里出现过的**轮次**数（唯一 `turnId` 计数）—— 这是**跨启动的 `turnCount`**
     * （用户 2026-10-17：「turnCount 也需存储」：注册表的 `turnCount` 是进程内的，
     * 重启归零 ⇒ 未读算不出来；账本里的 turnId 是落盘的，重启后照样数得清）。
     */
    turns: number;
    /** 最后一次活动时刻（最后一条账的 `ts`，ISO）；`null` = 账本为空 */
    lastTs: string | null;
    /** 账本累计 token（各步 `usage.totalTokens` 之和，**跨启动**） */
    tokens: number;
    /**
     * 账本累计**步数**（一行 = 一步，跨启动）。
     * 用途 = 会话总览的「步数」列：注册表的 `totalSteps` 只含本进程，重启即 0，
     * 而账本一行不落（每步都记）⇒ 两者取大才是"这个会话一共走了多少步"。
     */
    steps: number;
}

const facts = new Map<string, TaskLedgerFacts>();
const inflight = new Set<string>();
/**
 * 事实到货订阅（**纯 JS 回调，不是 Solid 响应式**）。
 *
 * 为什么需要：`sessionStore` 的**已读水位基线**必须钉在"账本真值"上（见该文件 `pendingSeen`），
 * 而账本是异步到货的。订阅方（sessionStore）是 store 不是组件 —— 用 `createEffect` 得先
 * `createRoot`，白白在 store 里开一个永不销毁的响应式根；回调最直白。
 */
type FactsListener = (uri: string, f: TaskLedgerFacts) => void;
const listeners = new Set<FactsListener>();
const queue: string[] = [];
let running = 0;
/** 并发上限：一次最多 4 个文件读，够快又不至于把主进程的文件 IO 打满 */
const CONCURRENCY = 4;
const [version, setVersion] = createSignal(0);

function factsOf(rows: StepUsageRecord[]): TaskLedgerFacts {
    let sum = 0;
    let priced = 0;
    let tokens = 0;
    let lastTs: string | null = null;
    let lastMs = Number.NEGATIVE_INFINITY;
    const turns = new Set<string>();
    for (const r of rows) {
        const t = r?.cost?.total;
        if (typeof t === "number" && Number.isFinite(t)) {
            sum += t;
            priced += 1;
        }
        const tk = r?.usage?.totalTokens;
        if (typeof tk === "number" && Number.isFinite(tk)) tokens += tk;
        if (r?.turnId) turns.add(r.turnId);
        const ms = Date.parse(r?.ts ?? "");
        if (Number.isFinite(ms) && ms > lastMs) {
            lastMs = ms;
            lastTs = r.ts;
        }
    }
    return {
        started: rows.length > 0,
        cost: priced > 0 ? sum : null,
        turns: turns.size,
        lastTs,
        tokens,
        steps: rows.length,
    };
}

function pump(): void {
    while (running < CONCURRENCY && queue.length > 0) {
        const uri = queue.shift()!;
        running += 1;
        void diyService.diy.agent.local
            .usage({ taskUri: uri })
            .then((rows) => {
                const f = factsOf(Array.isArray(rows) ? (rows as StepUsageRecord[]) : []);
                facts.set(uri, f);
                for (const fn of listeners) {
                    // 订阅方出错不能拖垮拉取队列（水位写失败 ≠ 数据拉失败）
                    try {
                        fn(uri, f);
                    } catch (e) {
                        console.warn("[usage-ledger] 事实订阅回调抛错:", e);
                    }
                }
            })
            .catch(() => {
                /* 观测数据拉不到：不落假值（"未知" ≠ "没聊过"），下次 ensure 还会试 */
            })
            .finally(() => {
                running -= 1;
                inflight.delete(uri);
                setVersion((v) => v + 1);
                pump();
            });
    }
}

export const usageLedgerStore = {
    /**
     * 账本版本号 —— **订阅点**：读它即"账本到货就重算"。
     * 供把账本事实揉进排序值 / 列的调用方（如任务表）挂依赖。
     */
    get version(): number {
        return version();
    },
    // ── 下面三个读口**都读一次 `version()`**：让"读到新事实"自动触发重算。
    // 少了它，`Map` 是普通对象、不响应式 —— 界面会永远停在第一次渲染的那一瞬（"已对话"永不出现）。
    /** 已读到的事实；`undefined` = 还没读到（**未知 ≠ 空**，别当 0 用） */
    factsOf(uri: string): TaskLedgerFacts | undefined {
        version();
        return facts.get(uri);
    },
    /** 会话是否已对话（账本有内容）；`undefined` = 未知（拉取中 / 拉失败） */
    startedOf(uri: string): boolean | undefined {
        version();
        return facts.get(uri)?.started;
    },
    /** 累计消费 $；`undefined` = 未读到，`null` = 读到但无价 */
    costOf(uri: string): number | null | undefined {
        version();
        return facts.get(uri)?.cost;
    },
    /**
     * **跨启动的 `turnCount`**（账本唯一 turnId 计数）；`undefined` = 未读到。
     * 未读水位（`seenTurns`）与它相比 ⇒ 重启后仍算得出"你不在时跑了几轮"。
     */
    turnsOf(uri: string): number | undefined {
        version();
        return facts.get(uri)?.turns;
    },
    /** 最后一次活动时刻（ISO）；`undefined` = 未读到，`null` = 账本为空 */
    lastTsOf(uri: string): string | null | undefined {
        version();
        return facts.get(uri)?.lastTs;
    },
    /** 账本累计 token（跨启动）；`undefined` = 未读到 */
    tokensOf(uri: string): number | undefined {
        version();
        return facts.get(uri)?.tokens;
    },
    /** 账本累计步数（跨启动）；`undefined` = 未读到 */
    stepsOf(uri: string): number | undefined {
        version();
        return facts.get(uri)?.steps;
    },
    /**
     * 订阅"账本事实到货"。返回退订函数（本仓无人退订：订阅方是模块级 store，与进程同寿）。
     * 只对**成功读到**的 uri 触发（失败不通知 —— "未知"不是事实）。
     */
    onFacts(fn: FactsListener): () => void {
        listeners.add(fn);
        return () => listeners.delete(fn);
    },
    /**
     * **重读**某任务的账本（丢缓存 → 重新入队）。
     *
     * 为什么必须有：`ensure` 是"拉一次就永久缓存"（任务表几百行，反复读盘顶不住），
     * 但**会话在跑时账本也在长** —— 不重读的话，刚跑完的那一轮/那一步在界面上不出现
     * （症状：未读 `+N` 迟到、步数/token 停在打开页面那一刻）。故由**知道"这个会话动了"的一方**
     * （sessionStore 收到注册表帧时，见其 `ledgerMoved`）点名重读：一步一次，代价可接受。
     */
    refresh(uri: string): void {
        facts.delete(uri);
        // 在途的先别动（回来的是发起时那一刻的数据，会覆盖新队列里的读）；只清排队中的
        const qi = queue.indexOf(uri);
        if (qi >= 0) queue.splice(qi, 1);
        inflight.delete(uri);
        this.ensure(uri);
    },
    /** 请求若干任务的账本（已读到 / 在途 / 在队列的跳过）。幂等，可随手调用 */
    ensure(...uris: (string | null | undefined)[]): void {
        let added = false;
        for (const uri of uris) {
            if (!uri || facts.has(uri) || inflight.has(uri)) continue;
            inflight.add(uri);
            queue.push(uri);
            added = true;
        }
        if (added) pump();
    },
};
