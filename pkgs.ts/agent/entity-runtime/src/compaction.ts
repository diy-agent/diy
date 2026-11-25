// compaction.ts —— 压缩策略接口 + 默认的摘要压缩实现。
//
// 设计目标：**算法可换**。session 只负责"什么时候压、压完记账"，怎么压交给策略对象。
//   · `simpleCompactor` 提供确定性的折叠 / 整轮丢弃边界
//   · 默认 `createSummaryCompactor` 在同一边界上摘要将被移除的内容
//
// 老库的判据只需要三样东西：`tokens / isUser / turn`。
// 所以数据结构上的要求只有一个：每条消息能回答"我属于哪一轮" —— 这就是 TranscriptEntry 里的 turn。

import { generateText, type ModelMessage } from 'ai';
import { parseSummary, renderSummaryFallback, summaryExtractionPrompt, type SummaryData } from '@diy-agent/compaction';

/** 上下文里的一条：消息 + 它从哪来 + 属于哪一轮 */
export interface TranscriptEntry {
    message: ModelMessage;
    /** 产生它的轮次；种子 / 未知为 undefined */
    turn?: number;
    /**
     * 它对应的房间公共条目序号（只有 `origin: 'public'` 的建议带）。
     * 用途只有一个：重启回放的水位 —— 「这条到底进没进过我的上下文」要靠序号回答，
     * 靠文本比对或靠房间的 lastSeq 都会答错（见 session.logSeq）。
     */
    seq?: number;
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
    /**
     * 用户撤掉这次压缩。只对**会等外部 IO** 的策略（摘要）有意义：
     * 确定性的折叠是同步的，压根没机会在中途取消。
     */
    signal?: AbortSignal;
}

export interface CompactionResult {
    entries: TranscriptEntry[];
    /** 折掉几条（工具消息 / 纯工具调用的 assistant） */
    folded: number;
    /** 整条丢弃几条 */
    dropped: number;
    /** 被折叠或整轮丢弃的条目，用于摘要提取（兼容自定义策略可省略） */
    removedEntries?: TranscriptEntry[];
    /** 摘要正文；session 会将其并入压缩说明。可能来自本次生成，也可能沿用旧摘要 */
    summary?: string;
    /** 本次有没有**新生成**摘要（沿用旧摘要 / 失败都是 false） */
    summarized: boolean;
    /** 本次摘要为什么没成（LLM 报错 / 解析失败 / 空输出）；undefined = 没试或成功 */
    summaryError?: string;
}

export interface Compactor {
    readonly name: string;
    /** 不需要压缩时返回 null */
    compact(input: CompactionInput): CompactionResult | Promise<CompactionResult | null> | null;
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
    /** 本次是否新生成摘要 */
    summarized: boolean;
    /** 最终落进压缩说明的摘要正文（新生成的，或沿用的旧摘要） */
    summary?: string;
    /** 摘要失败原因；undefined = 成功或没试。压缩本身仍算成功 */
    summaryError?: string;
    usage?: TokenUsage;
}

export const DEFAULT_BUDGET: CompactionBudget = { keepLast: 12, maxChars: 24000 };

export function estimateChars(entries: readonly TranscriptEntry[]): number {
    let total = 0;
    for (const entry of entries) total += JSON.stringify(entry.message).length;
    return total;
}

/**
 * 确定性压缩基线：折叠私有过程 → 还超预算就从最老的**整轮**丢。
 *   · 公共层（人话 / 别人的结论）不折叠，只可能被整轮丢弃
 *   · 切点吸附到轮首：不会把一轮里的工具调用和结果拆开
 *   · 不负责生成摘要，由 `createSummaryCompactor` 包装
 */
export const simpleCompactor: Compactor = {
    name: 'simple-fold-drop',

    compact({ entries, budget, force = false }): CompactionResult | null {
        if (!force && estimateChars(entries) <= budget.maxChars) return null;

        const keepFrom = Math.max(0, entries.length - budget.keepLast);
        const next: TranscriptEntry[] = [];
        let folded = 0;
        const removedEntries: TranscriptEntry[] = [];

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i]!;
            if (i >= keepFrom || entry.origin !== 'self') {
                next.push(entry);
                continue;
            }
            if (entry.message.role === 'tool') {
                removedEntries.push(entry);
                folded += 1;
                continue;
            }
            if (entry.message.role === 'assistant') {
                const parts = Array.isArray(entry.message.content) ? entry.message.content : [];
                const kept = parts.filter((part) => part.type === 'text');
                if (kept.length === 0) {
                    removedEntries.push(entry);
                    folded += 1;
                    continue;
                }
                if (kept.length !== parts.length) {
                    removedEntries.push(entry);
                    folded += 1;
                }
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
            const droppedEntries = next.splice(0, cut);
            removedEntries.push(...droppedEntries);
            dropped += cut;
        }

        if (folded === 0 && dropped === 0) return null;
        return { entries: next, folded, dropped, removedEntries, summarized: false };
    },
};

/**
 * LLM 摘要策略：复用确定性的折叠 / 整轮丢弃边界，只对实际丢弃的内容做摘要。
 * 摘要模型或解析失败时保留原压缩结果（不会因摘要失败阻断对话）。
 */
export function createSummaryCompactor(options: {
    modelKey: () => string;
    sessionId: string;
    /** 测试 / 自定义装配注入；缺省走当前模型 */
    generateSummary?: (prompt: string, signal?: AbortSignal) => Promise<string>;
}): Compactor {
    return {
        name: 'summary-fold-drop',
        async compact(input) {
            const result = await simpleCompactor.compact(input);
            if (result === null || result.removedEntries === undefined || result.removedEntries.length === 0) {
                return result;
            }
            // 把前次压缩说明一并作为摘要上下文，避免新摘要覆盖旧摘要后丢失更早信息。
            const priorNote = input.entries.find((entry) => entry.origin === 'note');
            const priorWasRemoved = priorNote !== undefined && result.removedEntries.includes(priorNote);
            const priorText = priorNote === undefined ? '' : messageText(priorNote.message);
            const droppedText = result.removedEntries.map((entry) => messageText(entry.message)).join('\n');
            const source = [priorWasRemoved ? '' : priorText, droppedText].filter(Boolean).join('\n\n');
            const turns = new Set(result.removedEntries.map((entry) => entry.turn).filter((turn) => turn !== undefined))
                .size;
            const clipped =
                source.length > 60_000
                    ? `${source.slice(0, 20_000)}\n[…中间内容省略…]\n${source.slice(-40_000)}`
                    : source;

            // 失败一律「压缩照常生效 + 如实记 summaryError」：压不下去会直接超窗，
            // 那是功能故障；摘要没生成只是质量问题，不能反悔压缩。
            const degraded = (reason: string): CompactionResult =>
                priorText === ''
                    ? { ...result, summaryError: reason }
                    : { ...result, summary: priorText, summaryError: reason };

            try {
                const prompt = summaryExtractionPrompt(clipped, turns);
                let text: string;
                if (options.generateSummary !== undefined) {
                    text = await options.generateSummary(prompt, input.signal);
                } else {
                    const { modelOf } = await import('./providers');
                    ({ text } = await generateText({
                        model: modelOf(options.modelKey(), { sessionId: options.sessionId }),
                        prompt,
                        // 同 agent.ts：这一层不重试（SDK 的 3 次会把一次额度满拖成 3 倍等待，
                        // 压缩是「压不动就算了」的活，失败就降级用旧摘要）。
                        maxRetries: 0,
                        ...(input.signal === undefined ? {} : { abortSignal: input.signal }),
                    }));
                }
                const data: SummaryData | null = parseSummary(text);
                if (data === null) return degraded('摘要格式无法解析');
                const summary = renderSummaryFallback({ ...data, turns });
                if (summary === '') return degraded('摘要为空');
                return { ...result, summary, summarized: true };
            } catch (error) {
                // 用户取消：**不是**「摘要失败」—— 整次压缩要作废（否则变成"悄悄按新边界压了、
                // 只是没有摘要"，与用户按下取消时的预期相反）。抛出去，由 session 回滚。
                if (input.signal?.aborted === true) throw error;
                // 生成失败仍保留旧摘要，避免旧 note 恰好被预算裁掉时连历史承接信息一起消失。
                return degraded(errorText(error));
            }
        },
    };
}

function errorText(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return text.trim() === '' ? '摘要生成失败' : text.split('\n')[0]!;
}

function messageText(message: ModelMessage): string {
    return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}
