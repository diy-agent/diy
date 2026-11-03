// compaction.ts — bot 会话的**上下文压缩**（##517）
//
// 为什么要有：一个 bot 一条长期会话，聊久了必然撞窗口上限。以前没有任何保护：
// 要么上游报错，要么整段历史被静默截掉。这里做的是「超了就压、压了有痕、压失败不挡路」。
//
// ── 算法一律照 `@diy-agent/compaction`（**不自己写判据、不自己写摘要 prompt**）──
//   · 触发线 `triggerTokensOf(W)` = `W − max(10%W, 16k)`；保留量 `retainTokensOf(W)` = `W × 0.16`
//   · 切点 `selectCompactableRange`（只落 user 消息；不保头、不事后配平）
//   · 摘要 `summaryExtractionPrompt` + `parseSummary` + `renderSummaryFallback`
// 本文件只做装配：判「这一轮该不该压」、把压缩结果拼回历史、把痕迹留给界面。
//
// ── 三件事（##517 判据）──
//   ① 阈值：每轮（= 每次 `compact` 回调）先看「上一步实测用量」(input+output)，
//      没实测（进程刚起 / 第一次跑）就退回按历史粗估 —— 窗口未知则**不压**（不猜数）。
//   ② 压缩：把将被丢弃的那段交给模型生成结构化摘要 → 摘要消息 + 保留段 = 新历史。
//   ③ 有痕：压缩成功插一条 `agent-notice`（丢了几条 / 保留多少 / 摘要有没有），
//      失败也插一条并附原因 —— **绝不静默丢消息**。
//
// ── 失败降级（判据 4）──
// 摘要调用 / 状态落盘 / 边界计算任一步抛错：**返回原历史**，对话照常继续，下一轮再试。
// 历史本身永远合法（切点落 user，工具调用/结果不会被拆开）。
//
// ── 边界持久化 ──
// 压缩后 store 里仍是全量历史（压缩只改「这一轮看到的历史」）；重建会话时靠
// `<session>/compaction.json` 里的 `cutSeq` 重放同一次切分。状态读写由宿主注入
// （本文件不碰 fs，便于单测）。

import type { ChatMessage, Compactor, LlmPort } from "@diy-agent/session";
import {
    type CompactableMessage,
    emptySummary,
    estimateTokensOf,
    parseSummary,
    renderSummaryFallback,
    retainTokensOf,
    selectCompactableRange,
    summaryExtractionPrompt,
    summaryHasContent,
    triggerTokensOf,
    type SummaryData,
} from "@diy-agent/compaction";

/** 落盘的压缩状态（`<session>/compaction.json`） */
export interface BotCompactionState {
    /** 最后一条被丢弃消息的 seq；重放时把它及之前的全部丢掉 */
    readonly cutSeq: number;
    /** 那次压缩发生的时刻（ISO） */
    readonly at: string;
    /** 丢掉的条数（展示用） */
    readonly dropped: number;
    /** 那次生效的窗口 / 保留量（换模型后窗口变小 ⇒ 旧状态仍可用，切点只按 seq） */
    readonly windowTokens: number;
    readonly retainTokens: number;
    /** 结构化摘要；空 = 摘要没生成（`self` 模式 / 生成失败） */
    readonly summary: SummaryData;
}

/** 压缩事件（宿主拿去做日志 / 观测；UI 那条痕走消息流里的 agent-notice） */
export type BotCompactionEvent =
    | {
          readonly kind: "compacted";
          readonly dropped: number;
          readonly retainedTokens: number;
          readonly windowTokens: number;
          readonly hasSummary: boolean;
          readonly at: string;
      }
    | { readonly kind: "failed"; readonly error: string; readonly at: string };

export interface BotCompactorOptions {
    /** 模型窗口上限（token）；`null` = 未知 ⇒ 永不自动压缩（不猜数） */
    readonly windowTokens: number | null;
    /** 摘要用的 LLM（与对话同一个模型；`summaryExtractionPrompt` 只要一段短 JSON） */
    readonly llm: LlmPort;
    /** 传 LlmPort 的模型标识（可缺省） */
    readonly model?: string;
    /** 读上次落盘的压缩状态（没有 = null） */
    readonly loadState: () => Promise<BotCompactionState | null>;
    /** 落盘压缩状态；失败不应阻断对话（本模块会 catch） */
    readonly saveState: (state: BotCompactionState) => Promise<void>;
    /** 事件回调（日志 / 观测；不会抛进对话） */
    readonly onEvent?: (event: BotCompactionEvent) => void;
    /** 时钟（缺省真时间；注入只为测试确定） */
    readonly now?: () => Date;
}

export interface BotCompactor {
    /** 交给 `createSession({ compact })` 的回调 */
    readonly compact: Compactor;
    /** 每轮结束后记「上一步实测用量」（input + output）；下一轮阈值判定用它 */
    noteStepTokens(tokens: number): void;
    /** 当前生效的压缩状态（没有 = 从没压过） */
    state(): BotCompactionState | null;
}

/** 摘要输入上限（字符）：被丢段可能极大（工具输出），超了取头 + 尾，中间标注省略 */
export const SUMMARY_INPUT_MAX_CHARS = 60_000;
/** 头 / 尾各留多少（尾更重要：越近的历史越有用） */
const SUMMARY_HEAD_CHARS = 20_000;

/** 一条 agent-notice 的 data 标记（`wireOf` 不解释它；只用于识别「这条是压缩痕迹」） */
const NOTICE_MARK = "compaction";

/**
 * 造一个 bot 压缩器。
 *
 * 用法（装配器）：
 *   const compactor = createBotCompactor({ windowTokens, llm, loadState, saveState });
 *   const session = createSession({ id, llm, store, compact: compactor.compact });
 *   // 每轮结束后：compactor.noteStepTokens(last.inputTokens + last.outputTokens)
 */
export function createBotCompactor(options: BotCompactorOptions): BotCompactor {
    const now = options.now ?? (() => new Date());
    let state: BotCompactionState | null = null;
    let stateLoaded = false;
    /** 上一步实测用量（null = 还没有；退回历史粗估） */
    let stepTokens: number | null = null;

    const note = (event: BotCompactionEvent): void => {
        try {
            options.onEvent?.(event);
        } catch {
            // 观测回调自己炸了不能影响对话
        }
    };

    const ensureState = async (): Promise<BotCompactionState | null> => {
        if (!stateLoaded) {
            state = await options.loadState();
            stateLoaded = true;
        }
        return state;
    };

    const compact: Compactor = async (history) => {
        const windowTokens = options.windowTokens;
        // ① 窗口未知 ⇒ 不压（判据：不猜数；与 compaction 包口径一致）
        if (windowTokens === null || !(windowTokens > 0)) return history;

        const triggerTokens = triggerTokensOf(windowTokens);
        const retainTokens = retainTokensOf(windowTokens);
        if (!(retainTokens > 0) || !(triggerTokens > retainTokens)) return history;

        const at = now().toISOString();
        try {
            const prev = await ensureState();
            // 历史里被丢段还在（内存历史未经落盘切分）⇒ 先套上已有边界；
            // 已套过（重建时 `applyPriorBoundary` 已做）则原样返回
            const all = applyPriorBoundary(history, prev);

            // ② 阈值：上一步实测优先，没有就按历史粗估
            const used = stepTokens ?? estimateHistory(all);
            if (used < triggerTokens) return history;

            // ③ 边界（切点只落 user；工具调用/结果不会被拆开）
            //    `selectCompactableRange` 只认 `{ role, content }`，适配一下就交给唯一判据
            const compactable: CompactableMessage[] = all.map((message) => ({
                role: message.role,
                content: messageContent(message),
            }));
            const range = selectCompactableRange(compactable, {
                windowTokens,
                costOf: (m) => estimateTokensOf(JSON.stringify(m.content ?? "")),
            });
            if (range === null) return history;
            // system 消息（行为指令 / 系统上下文）一律不丢：切点必须在它之后
            const head = all.findIndex((message) => message.role !== "system");
            if (head >= 0 && range.cut <= head) return history;

            const dropped = all.slice(0, range.cut);
            const kept = all.slice(range.cut);
            const lastDropped = dropped.at(-1);

            // ④ 摘要：失败按「没摘要」处理，不阻断压缩本身（丢消息也要有痕）
            const summary = await summarize(dropped);
            const summaryText = renderSummaryFallback(summary);

            const nextState: BotCompactionState = {
                cutSeq: lastDropped?.seq ?? prev?.cutSeq ?? 0,
                at,
                dropped: range.dropped + (prev?.dropped ?? 0),
                windowTokens,
                retainTokens,
                summary,
            };
            // 先落盘再改历史：落盘失败 ⇒ 不压（否则重启后切分对不上）
            await options.saveState(nextState);
            state = nextState;
            stateLoaded = true;
            // 压完「上一步实测」就过期了（它是压前那么大）；下一轮按新的历史粗估，
            // 否则会拿着旧读数每轮都再压一次
            stepTokens = null;

            const rebuilt: ChatMessage[] = [];
            if (summaryText !== "") {
                rebuilt.push({
                    role: "user",
                    type: "human",
                    text: summaryText,
                    at: now().getTime(),
                    data: { summary: { kind: "history-summary", turns: summary.turns } },
                });
            }
            const notice = [
                `上下文已压缩：丢弃 ${range.dropped} 条早前消息（保留 ${range.retainedTokens} token，窗口 ${windowTokens}）。`,
                summaryText === "" ? "摘要未生成，需要细节请查会话日志。" : "以上是摘要，据此接续。",
            ].join("");
            rebuilt.push(noticeOf(notice, at));
            rebuilt.push(...kept);

            note({
                kind: "compacted",
                dropped: range.dropped,
                retainedTokens: range.retainedTokens,
                windowTokens,
                hasSummary: summaryText !== "",
                at,
            });
            return rebuilt;
        } catch (error) {
            // ⑤ 降级：不压，原历史照常投递；痕迹留在消息流里（同一轮不会重复插）
            const message = error instanceof Error ? error.message : String(error);
            note({ kind: "failed", error: message, at });
            // 连续失败不刷屏：最近几条里已有失败痕迹就不再插
            if (hasFailureNotice(history)) return history;
            return [...history, noticeOf(`上下文压缩失败（本轮不压，下轮再试）：${message}`, at)];
        }
    };

    /** 对被丢弃段生成结构化摘要；任何失败都退化成空摘要（压缩照做，只是没摘要） */
    async function summarize(dropped: readonly ChatMessage[]): Promise<SummaryData> {
        const turns = dropped.filter((message) => message.type === "human").length;
        const text = clipForSummary(dropped);
        if (text === "") return emptySummary(turns);
        let raw = "";
        for await (const delta of options.llm.chat(
            [{ role: "user", text: summaryExtractionPrompt(text, turns) }],
            options.model === undefined ? {} : { model: options.model },
        )) {
            if (delta.type === "text") raw += delta.text;
        }
        const parsed = parseSummary(raw);
        if (parsed === null) {
            note({ kind: "failed", error: "摘要返回的不是合法 JSON（压缩继续，摘要为空）", at: now().toISOString() });
            return emptySummary(turns);
        }
        return summaryHasContent(parsed) || parsed.turns > 0 ? { ...parsed, turns: parsed.turns || turns } : emptySummary(turns);
    }

    return {
        compact,
        noteStepTokens(tokens: number): void {
            stepTokens = Number.isFinite(tokens) && tokens > 0 ? tokens : null;
        },
        state: () => state,
    };
}

/**
 * 把「上一次落盘的切分」套回全量历史（**重建会话时必须用**）。
 *
 * 压缩后的内存历史不含被丢段，而 store 里是**全量**；重放靠 `cutSeq` 定位，
 * 找不到（store 已被清理 / 切点比现有最早一条还早）⇒ 原样返回（不猜）。
 *
 * 摘要消息要带 `seq`：`createSession({ initialMessages })` 要求恢复历史每条都有 seq，
 * 且严格递增 —— 给它被丢段的末尾 seq（`cutSeq`），保留段自然全部大于它。
 */
export function applyPriorBoundary(
    history: readonly ChatMessage[],
    prev: BotCompactionState | null,
): readonly ChatMessage[] {
    if (prev === null || prev.cutSeq <= 0) return history;
    const cut = history.findIndex((message) => (message.seq ?? 0) > prev.cutSeq);
    if (cut <= 0) return history;
    const kept = history.slice(cut);
    const rebuilt: ChatMessage[] = [];
    const summaryText = renderSummaryFallback(prev.summary);
    if (summaryText !== "") {
        rebuilt.push({
            seq: prev.cutSeq,
            role: "user",
            type: "human",
            text: summaryText,
            data: { summary: { kind: "history-summary", turns: prev.summary.turns } },
        });
    }
    rebuilt.push(...kept);
    return rebuilt;
}

/** 最近几条里有没有「压缩失败」痕迹（避免每轮失败都往历史里塞一条） */
function hasFailureNotice(history: readonly ChatMessage[]): boolean {
    return history
        .slice(-3)
        .some((message) => message.type === "agent-notice" && (message.text ?? "").startsWith("上下文压缩失败"));
}

/** 历史 → token 粗估（CJK 感知，与 compaction 包同一把尺子） */
function estimateHistory(messages: readonly ChatMessage[]): number {
    return messages.reduce(
        (sum, message) => sum + estimateTokensOf(JSON.stringify(messageContent(message) ?? "")),
        0,
    );
}

/** 一条消息的正文（文本 + 结构载荷；工具结果都在 `data` 里） */
function messageContent(message: ChatMessage): unknown {
    return message.text ?? message.data ?? "";
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value) ?? "";
    } catch {
        return "";
    }
}

/** 被丢弃段 → 摘要输入（超长取头 + 尾；工具输出常是几万字符） */
function clipForSummary(dropped: readonly ChatMessage[]): string {
    const lines = dropped
        .map((message) => {
            const who = message.role === "user" ? "用户" : message.role === "tool" ? "工具结果" : message.role;
            const text = message.text ?? (message.data === undefined ? "" : safeJson(message.data));
            return `[${who}] ${text}`;
        })
        .join("\n");
    if (lines.length <= SUMMARY_INPUT_MAX_CHARS) return lines;
    const head = lines.slice(0, SUMMARY_HEAD_CHARS);
    const tail = lines.slice(-(SUMMARY_INPUT_MAX_CHARS - SUMMARY_HEAD_CHARS));
    return `${head}\n……（中间省略 ${lines.length - SUMMARY_INPUT_MAX_CHARS} 字符）……\n${tail}`;
}

/** 一条压缩痕迹（`agent-notice`：进消息流 / 进 UI，也进下一轮上下文） */
function noticeOf(text: string, at: string): ChatMessage {
    return {
        role: "assistant",
        type: "agent-notice",
        text,
        at: Date.parse(at),
        data: { [NOTICE_MARK]: { kind: "notice" } },
    };
}
