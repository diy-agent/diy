// compaction.ts —— 压缩策略接口 + 默认的摘要压缩实现。
//
// 设计目标：**算法可换**。session 只负责"什么时候压、压完记账"，怎么压交给策略对象。
//   · `simpleCompactor` 只算边界（丢哪一段），判据来自 `@diy-agent/compaction` —— 与 diy1 同一份
//   · 默认 `createSummaryCompactor` 在同一边界上摘要被丢弃的内容
//
// 判据（2026-11-25 用户拍板「直接复用 @diy-agent/compaction」）：
//   · 触发线 = 窗口 − max(10%W, 16k)；保留量 = 窗口 × 0.16；切点吸附 user + 轮首
//   · 压完仍超触发线 ⇒ 不压（空转判据）；手工 force 跳过它
// 这里**不再有第二个旋钮**：原先的 `maxChars`（字符上限）已删 —— 字符与 token 在中英文之间
// 差 4 倍，同一个 24000 在中英会话里含义不同，等于一个没人能自圆其说的常量。
//
// 数据结构上只有一个要求：每条消息能回答"我属于哪一轮" —— TranscriptEntry 的 turn。

import { generateText, type ModelMessage } from 'ai';
import {
    estimateTokensOf,
    parseSummary,
    renderSummaryFallback,
    selectCompactableRange,
    summaryExtractionPrompt,
    triggerTokensOf,
    type CompactableMessage,
    type SummaryData,
} from '@diy-agent/compaction';

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
    /**
     * **手工压缩**保留的最近**轮数**（0 = 压到头）。自动压缩不看它：自动判据是 token 水位
     * （窗口 × 0.16），与 diy1 一致 —— 两个判据各自回答不同的问题，不该共用一个数。
     */
    keepTurns: number;
}

export interface CompactionInput {
    entries: readonly TranscriptEntry[];
    budget: CompactionBudget;
    turn: number;
    turnId: string;
    /**
     * 模型上下文窗口（token）—— 自动压缩的**唯一输入**（触发线与保留量都由它派生）。
     * 未知 = 不压：猜一个窗口会让「要么永远不触发、要么一上来就压光历史」。
     */
    windowTokens?: number;
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
    /** 整段丢弃几条（判据只整轮丢，不折条） */
    dropped: number;
    /** 被丢弃的条目，用于摘要提取（自定义策略可省略） */
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
    before: { entries: number; chars: number; tokens: number };
    after: { entries: number; chars: number; tokens: number };
    dropped: number;
    /** 本次是否新生成摘要 */
    summarized: boolean;
    /** 最终落进压缩说明的摘要正文（新生成的，或沿用的旧摘要） */
    summary?: string;
    /** 摘要失败原因；undefined = 成功或没试。压缩本身仍算成功 */
    summaryError?: string;
    usage?: TokenUsage;
}

export const DEFAULT_BUDGET: CompactionBudget = { keepTurns: 2 };

/**
 * 尾部 `keepTurns` 轮的 token 估算 —— **手工压缩**的保留量。
 *
 * 手工压缩不是「按水位压」，是「人指定留最近几轮」；换算成 token 后仍交给同一份判据
 * （`selectCompactableRange` 的 `retainTokens` 覆盖），切在哪一步不许自己另算。
 * 无轮号的条目各自算一轮，否则「保 2 轮」会变成「保住整段种子」。
 */
export function retainTokensForTurns(entries: readonly TranscriptEntry[], keepTurns: number): number {
    let acc = 0;
    let seen = 0;
    let last: number | undefined;
    let started = false;
    for (let i = entries.length - 1; i >= 0; i--) {
        const turn = entries[i]!.turn;
        if (!started || turn === undefined || turn !== last) {
            started = true;
            seen += 1;
            last = turn;
            if (seen > keepTurns) break;
        }
        acc += estimateTokensOf(JSON.stringify(entries[i]!.message.content ?? ''));
    }
    return Math.max(1, acc);
}

export function estimateChars(entries: readonly TranscriptEntry[]): number {
    let total = 0;
    for (const entry of entries) total += JSON.stringify(entry.message).length;
    return total;
}

/** 当前上下文的 token 估算（与判据同一口径：CJK 感知的粗估） */
export function estimateTokens(entries: readonly TranscriptEntry[]): number {
    let total = 0;
    for (const entry of entries) total += estimateTokensOf(JSON.stringify(entry.message.content ?? ''));
    return total;
}

/**
 * 确定性压缩基线：把判据直接交给 `@diy-agent/compaction` 的 `selectCompactableRange`
 * （diy1 同一份：触发线 / 保留量 / 吸附 user+轮首 / 空转判据全在那里）。
 *
 * 本函数只负责两件事：把 `TranscriptEntry[]` 映射成判据要的三样（role / content / turn），
 * 以及把「丢哪一段」翻译成结果。**不自己算边界** —— 两份判据是 diy2 之前最大的分叉来源。
 *
 * 不负责生成摘要，由 `createSummaryCompactor` 包装。
 */
export const simpleCompactor: Compactor = {
    name: 'simple-drop',

    compact({ entries, budget, windowTokens, usage, force = false }): CompactionResult | null {
        if (entries.length === 0) return null;
        // ① 什么时候压：没到触发线就不动（diy1 同一判据：实测用量或上下文估算超过
        //    窗口 − max(10%, 16k) 才压）。窗口未知 ⇒ 自动不压（不猜数）。
        //    取两者较大值：估算只看 transcript（不含 tools / system），实测是上一轮的，
        //    宁可早压一次也不赌「下一条工具结果刚好不超」。
        const triggerTokens = windowTokens === undefined ? 0 : triggerTokensOf(windowTokens);
        if (!force) {
            if (!(triggerTokens > 0)) return null;
            const used = Math.max(usage?.inputTokens ?? 0, estimateTokens(entries));
            if (used < triggerTokens) return null;
        }
        // ② 压到哪：判据全在 `selectCompactableRange`（保留量 / 吸附 user + 轮首 / 空转判据）。
        //    手工 force 时把「留最近几轮」换成 token 覆盖同一个判据 —— 切点仍由它吸，不另算。
        const messages: CompactableMessage[] = entries.map((entry) => ({
            role: entry.message.role,
            content: entry.message.content,
            ...(entry.turn === undefined ? {} : { turn: String(entry.turn) }),
        }));
        const range = selectCompactableRange(messages, {
            windowTokens: windowTokens ?? 0,
            force,
            ...(force ? { retainTokens: retainTokensForTurns(entries, budget.keepTurns) } : {}),
        });
        if (range === null || range.cut <= 0) return null;
        return {
            entries: entries.slice(range.cut),
            dropped: range.cut,
            removedEntries: entries.slice(0, range.cut),
            summarized: false,
        };
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
