// compaction.ts —— 压缩策略接口 + 默认的简单实现（临时实验用）。
//
// 设计目标：**算法可换**。session 只负责"什么时候压、压完记账"，怎么压交给策略对象。
//   · 现在挂的是 `simpleCompactor`：确定性启发式，不调模型（临时够用）
//   · 将来可以换成接 `@diy-agent/compaction` 的 LLM 摘要版，session 一行不改
//
// 老库的判据只需要三样东西：`tokens / isUser / turn`。
// 所以数据结构上的要求只有一个：每条消息能回答"我属于哪一轮" —— 这就是 TranscriptEntry 里的 turn。

import type { ModelMessage } from 'ai';

/** 上下文里的一条：消息 + 它从哪来 + 属于哪一轮 */
export interface TranscriptEntry {
    message: ModelMessage;
    /** 产生它的轮次；种子 / 未知为 undefined */
    turn?: number;
    /**
     * public = 房间公共层（人话、别人的结论）
     * self   = 自己这一轮跑出来的内容（含 tool / reasoning）
     * note   = 压缩留下的占位说明
     */
    origin: 'public' | 'self' | 'note';
}

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
}

export interface CompactionBudget {
    /** 原样保留的最近消息数 */
    keepLast: number;
    /** 估算字符预算 */
    maxChars: number;
}

export interface CompactionInput {
    entries: readonly TranscriptEntry[];
    budget: CompactionBudget;
    turn: number;
    turnId: string;
    /** 上一轮的实测用量（真实 token）；刚启动 / 首轮没有 */
    usage?: TokenUsage;
    /** 手动触发：跳过"其实不用压"的早退 */
    force?: boolean;
}

export interface CompactionResult {
    entries: TranscriptEntry[];
    /** 折掉几条（工具消息 / 纯工具调用的 assistant） */
    folded: number;
    /** 整条丢弃几条 */
    dropped: number;
    /** 有没有生成摘要（简单版永远 false） */
    summarized: boolean;
}

export interface Compactor {
    readonly name: string;
    /** 不需要压缩时返回 null */
    compact(input: CompactionInput): CompactionResult | Promise<CompactionResult> | null;
}

export interface CompactEvent {
    at: number;
    strategy: string;
    turn: number;
    turnId: string;
    durationMs: number;
    budget: CompactionBudget;
    before: { entries: number; chars: number };
    after: { entries: number; chars: number };
    folded: number;
    dropped: number;
    summarized: boolean;
    usage?: TokenUsage;
}

export const DEFAULT_BUDGET: CompactionBudget = { keepLast: 12, maxChars: 24000 };

export function estimateChars(entries: readonly TranscriptEntry[]): number {
    let total = 0;
    for (const entry of entries) total += JSON.stringify(entry.message).length;
    return total;
}

/**
 * 默认策略：折叠私有过程 → 还超预算就从最老的**整轮**丢。
 *   · 公共层（人话 / 别人的结论）不折叠，只可能被整轮丢弃
 *   · 切点吸附到轮首：不会把一轮里的工具调用和结果拆开
 *   · 不调模型，所以没有摘要
 */
export const simpleCompactor: Compactor = {
    name: 'simple-fold-drop',

    compact({ entries, budget, force = false }): CompactionResult | null {
        if (!force && estimateChars(entries) <= budget.maxChars) return null;

        const keepFrom = Math.max(0, entries.length - budget.keepLast);
        const next: TranscriptEntry[] = [];
        let folded = 0;

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i]!;
            if (i >= keepFrom || entry.origin !== 'self') {
                next.push(entry);
                continue;
            }
            if (entry.message.role === 'tool') {
                folded += 1;
                continue;
            }
            if (entry.message.role === 'assistant') {
                const parts = Array.isArray(entry.message.content) ? entry.message.content : [];
                const kept = parts.filter((part) => part.type === 'text');
                if (kept.length === 0) {
                    folded += 1;
                    continue;
                }
                if (kept.length !== parts.length) folded += 1;
                next.push({ ...entry, message: { role: 'assistant', content: kept } });
                continue;
            }
            next.push(entry);
        }

        let dropped = 0;
        while (estimateChars(next) > budget.maxChars && next.length > budget.keepLast) {
            // 整轮丢：切点落在轮首，工具对不会被拆开
            const turn = next[0]!.turn;
            let cut = 1;
            while (cut < next.length && next[cut]!.turn === turn) cut += 1;
            if (next.length - cut < budget.keepLast) break;
            next.splice(0, cut);
            dropped += cut;
        }

        if (folded === 0 && dropped === 0) return null;
        return { entries: next, folded, dropped, summarized: false };
    },
};
