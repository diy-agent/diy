// src/shared/context/history-limit.ts
// 🎯 **唯一的压缩算法**（##432 刀 2）：一条上限 + 从后往前数 step + 保头 600 token。
//
// 删掉的东西（用户 2026-10-25 拍板）：`ladder / role / recent / steps` 四级取法、
// `must`（不占预算）、`budgetBytes` 多级挑拣、`clip` 策略矩阵 —— 那些让人连作者自己都看不懂，
// 且 `must` 不占预算导致「压完还超预算」。现在的规则只有一条：
//
//   从最后一步往前累加 token（字符数 / 4 的粗估），装得下就装，装不下就停；
//   切点必须 tool 配对平衡（不平衡就往前挪）；**保头 600 token 硬编码**（不参与累加、永不被丢）。
//
// 「边界只在压缩事件时算一次并落盘」——算一次的入口就是这里的 `selectCompactableRange`，
// 落盘与之后的每步追加由 `@diy/persistence` / `local-agent` 负责（本文件是**纯函数**，禁止 node:*）。

import { z } from "zod";

import { selectKeptBoundary, type BoundaryMessage } from "./select-kept-boundary";

/**
 * 保头 token 数 / 保留比例：**唯一真源在 `./select-kept-boundary.ts`**（与界面范例预览共用同一份判据），
 * 这里只做再导出，别在本文件另起常量。
 */
export { HEAD_KEEP_TOKENS as HISTORY_HEAD_TOKENS, RETAIN_RATIO as HISTORY_RETAIN_RATIO } from "./select-kept-boundary";

/** 单条上限的缺省值（token）。旧 `budgetBytes: 20480` ≈ 5120 token —— 新口径放开到 20000。 */
export const DEFAULT_HISTORY_LIMIT_TOKENS = 20_000;

/**
 * 单条上限的**下限**（token），低于它一律夹上来 —— 理由（##432 review 第 2 条）：
 *
 * 保头 `HEAD_KEEP_TOKENS = 600` 是硬编码、不参与累加；一次压缩只保留到 `limitTokens × RETAIN_RATIO(0.5)`。
 * 于是 `tailBudget = limitTokens × 0.5 − headTokens`，当 `limitTokens ≤ 1200` 时 tailBudget ≤ 0，
 * 保留段**必然**超上限 ⇒ 每一步都重算切点、每一步都可能写一条 compaction entry ——
 * 「压缩是罕见事件」从后门失效（正是 `##432` 要治的病）。
 *
 * 4000 的选择：`4000 × 0.5 − 600 = 1400` token 的尾部额度，约等于 2~3 个 step 的正文，
 * 保证「压一次能顶住之后若干步的新增量」；再小就没有压缩的意义了（不如不压）。
 */
export const MIN_HISTORY_LIMIT_TOKENS = 4_000;

/**
 * 历史预算的配置面（唯一的一项）。
 *
 * `summary.enabled` 缺省 **false**：v1 **不做摘要 LLM 调用**，丢掉的部分靠注记一行 + ref 指回去查。
 * 留这个开关是为了将来抄 checkpoint 摘要时打开（而不是现在就多一条花钱的路径）。
 */
export const HistoryLimitSchema = z.object({
    limitTokens: z
        // ⚠️ 用 transform **夹**而不是 `.min()` 拒绝：配置里小于下限的值不该让整份配置读不出来
        //    （读不出 = 回落缺省 + 一条 warning，用户只会看到"我配的没生效"）。夹取与
        //    `normalizeHistoryLimit` 是同一个口径（MIN_HISTORY_LIMIT_TOKENS 的理由见那里）。
        .transform((v: number) => Math.max(MIN_HISTORY_LIMIT_TOKENS, Math.floor(v)))
        .describe(
            "历史消息可占的 **token** 上限（字符数 / 4 粗估）：从最后一步往前累加，装得下就装，装不下就停。" +
                `低于 ${MIN_HISTORY_LIMIT_TOKENS} 会被夹上来（再小则保头 + 保留比例让每步都重算）`,
        ),
    summary: z
        .object({
            enabled: z.boolean().describe("是否对丢掉的那段做摘要（v1 缺省 false：只留一行注记 + ref 指回原文）"),
        })
        .describe("摘要开关"),
});

export type HistoryLimit = z.infer<typeof HistoryLimitSchema>;

export const DEFAULT_HISTORY_LIMIT: HistoryLimit = {
    limitTokens: DEFAULT_HISTORY_LIMIT_TOKENS,
    summary: { enabled: false },
};

/**
 * 宽松归一：手写 / LLM 写的配置可能缺字段、给成 0 / 负数 / 小于下限 / 旧字段名。
 * `limitTokens` 一律夹到 `[MIN_HISTORY_LIMIT_TOKENS, ∞)`（理由见该常量的注释）。
 */
export function normalizeHistoryLimit(raw: unknown): HistoryLimit {
    const src = (raw ?? {}) as Record<string, unknown>;
    const n = src["limitTokens"];
    const limitTokens =
        typeof n === "number" && Number.isFinite(n) && n > 0
            ? Math.max(MIN_HISTORY_LIMIT_TOKENS, Math.floor(n))
            : DEFAULT_HISTORY_LIMIT_TOKENS;
    const sum = src["summary"] as Record<string, unknown> | undefined;
    return { limitTokens, summary: { enabled: sum?.["enabled"] === true } };
}

/** token 粗估：**字符数 / 4**（不做 meter —— 精确计量要 tokenizer，且每步付一次代价不值得） */
export function estimateTokensOf(text: string): number {
    // 用 UTF-16 长度近似字符数：中文 1 字 ≈ 1 token 的量级，英文 1 词 ≈ 2 字符 → 两者都在这个粗估里可接受
    return Math.ceil(text.length / 4);
}

/** 算法只需要这几样（不绑 LocalModelMessage，便于单测与跨层复用） */
export interface CompactableMessage {
    role: string;
    content: unknown;
    /** 属于哪一步（缺省 = 开场 user / 无步消息，归到前一个组） */
    step?: string;
}

export interface CompactableRange {
    /** 切点的消息下标（**这条及之后保留**；它之前的非保头部分被丢弃） */
    cut: number;
    /** 保头结束的下标（`[0, headEnd)` 永远保留） */
    headEnd: number;
    /** 本次丢掉的消息条数（不含保头） */
    dropped: number;
}

const callIds = (m: CompactableMessage): string[] => {
    if (!Array.isArray(m.content)) return [];
    return (m.content as { type?: string; toolCallId?: string }[])
        .filter((p) => p.type === "tool-call" && typeof p.toolCallId === "string")
        .map((p) => p.toolCallId!);
};

const resultIds = (m: CompactableMessage): string[] => {
    if (!Array.isArray(m.content)) return [];
    return (m.content as { type?: string; toolCallId?: string }[])
        .filter((p) => p.type === "tool-result" && typeof p.toolCallId === "string")
        .map((p) => p.toolCallId!);
};

/**
 * 按 **step** 把消息切成若干连续组：同 step 的消息成组；没有 step 的消息**并入前一组**
 * （开场 user 属于它后面那一轮的第一步）。返回每组的起始下标（升序，首项恒为 0）。
 */
export function stepStarts(all: readonly CompactableMessage[]): number[] {
    const starts: number[] = [];
    let prev = "";
    for (let i = 0; i < all.length; i++) {
        const key = all[i]!.step ?? "";
        if (i === 0) {
            starts.push(0);
            prev = key;
            continue;
        }
        if (key !== "" && key !== prev) starts.push(i);
        if (key !== "") prev = key;
    }
    return starts;
}

/**
 * 把 core 的消息形状适配成边界判据的最小形状（工具配对与 step 都带过去）。
 *
 * ⚠️ 无 step 的消息（开场 user）**归属到它后面那一轮的第一步**（与 `stepStarts` 同语义），
 * 因为边界判据把「没有 step」解释成「每条自成一组」（UI 预览需要它）—— 差别的处理只在这一处。
 */
export function toBoundaryMessages(
    all: readonly CompactableMessage[],
    costOf: (m: CompactableMessage, index: number) => number,
): BoundaryMessage[] {
    const stepOf: (string | undefined)[] = new Array(all.length);
    let next: string | undefined;
    for (let i = all.length - 1; i >= 0; i--) {
        const s = all[i]!.step;
        if (s) next = s;
        stepOf[i] = s ?? next;
    }
    return all.map((m, i) => {
        const calls = callIds(m);
        const results = resultIds(m);
        const kind = calls.length > 0 ? "call" : results.length > 0 ? "result" : m.role === "user" ? "user" : "text";
        const callId = calls[0] ?? results[0];
        return {
            tokens: costOf(m, i),
            kind,
            ...(callId ? { callId } : {}),
            ...(stepOf[i] ? { step: stepOf[i] } : {}),
        };
    });
}

export interface SelectRangeOpts {
    /** 每条消息的 token 成本（缺省 = 渲染后 JSON 字符数 / 4） */
    costOf?: (m: CompactableMessage, index: number) => number;
    /** 保头 token（缺省 `HEAD_KEEP_TOKENS`；单测可传更小的值） */
    headTokens?: number;
}

/**
 * **core 侧的适配层**：把消息序列喂给唯一判据 `selectKeptBoundary`（`./select-kept-boundary.ts`），
 * 再把下标换算成 core 的 `{ cut, headEnd, dropped }`（`headEnd` 在这里是**开区间右端**，
 * 边界判据用的是**保头末条下标** —— 差一，换算只此一处）。
 *
 * 返回 `null` = 没有可丢的（什么都没发生，不写边界）。
 */
export function selectCompactableRange(
    all: readonly CompactableMessage[],
    limitTokens: number,
    opts: SelectRangeOpts = {},
): CompactableRange | null {
    if (all.length === 0 || !(limitTokens > 0)) return null;
    const cost = opts.costOf ?? ((m: CompactableMessage) => estimateTokensOf(JSON.stringify(m.content ?? "")));
    const msgs = toBoundaryMessages(all, cost);
    // 单测可以调小保头（不传就是真实口径）；判据本身仍只有一份
    const boundary = selectKeptBoundary(msgs, limitTokens, opts.headTokens === undefined ? {} : { headTokens: opts.headTokens });
    const headEnd = boundary.headEnd + 1;
    if (boundary.cut <= headEnd) return null;
    return { cut: boundary.cut, headEnd, dropped: boundary.cut - headEnd };
}
