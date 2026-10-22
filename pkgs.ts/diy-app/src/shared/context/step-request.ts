// src/shared/context/step-request.ts
// 🎯 流量日志里**一条真发请求** → 它的 `messages[]`（模型真正看到的东西）。
//
// 为什么放 shared 且是纯函数：这是「该步实际请求」view 的唯一数据来源，而它有两个消费面
// —— 格式化视图（人读）与 `<>` 原始视图（逐字核对）。两处必须**同一份解析**，否则
// 「渲染出来是这样、原文是那样」的争执永远说不清（这个 view 存在的理由就是终结这类争执）。
//
// 只取 `messages`，**不取请求头 / 工具定义 / sampling 参数**：用户口径是「不需要请求头，
// 只要消息内容」。想看完整请求体请去流量页（那里是逐字的 reqBody）。
//
// 约定：本文件只放纯函数，禁止 import node:*（renderer 会打进包）。

/** 消息里认出的一条工具调用（模型发起的 tool-call 分片） */
export interface StepToolCall {
    /** 工具名（上游没给 → `(未命名)`） */
    name: string;
    /** 参数 JSON 的字符数（长得离谱的参数一律不展开，只报量级） */
    argsChars: number;
    /** 参数预览（≤ PREVIEW 字，超了加 …） */
    argsPreview: string;
}

/** 一条消息（格式化视图的渲染单元） */
export interface StepMessage {
    /** 1 起（与 UI 序号一致） */
    index: number;
    role: string;
    /** 可读正文：字符串原样；分片数组按类型摊平（不展开 tool-result 的大 payload） */
    text: string;
    /** 该条里的工具调用（只有 assistant 消息会有） */
    toolCalls: StepToolCall[];
    /** 该条 content 的字符数（正文的"量"） */
    chars: number;
    /** 该条整段 JSON 的字节数（含 tool_calls，用于回答"是哪条撑爆了上下文"） */
    bytes: number;
    /** token 估算（见 `estimateTokens`；**不是**上游真实计数） */
    tokens: number;
}

/** 一次解析的结果 */
export interface StepRequest {
    /** 解析出的消息；`null` = 请求体不可用（截断 / 不是 JSON / 没有 messages） */
    messages: StepMessage[] | null;
    /** `<>` 原始视图的文本（messages 数组的美化 JSON；不可用时为 null） */
    raw: string | null;
    /** 给人看的一句话说明（截断 / 解析失败时非空） */
    note: string;
    /** 全部消息合计（不可用时为 0） */
    totalChars: number;
    totalBytes: number;
    totalTokens: number;
}

/** tool-result / tool-call 参数在正文里的预览长度 */
const PREVIEW = 160;

/**
 * token 估算：CJK 字符按 1 token、其余按 4 字符 1 token 折算。
 *
 * 为什么不用 `bytes/4` 一刀切：本系统提示词里中文占大头，`bytes/4` 会把中文**低估 3 倍**
 * （UTF-8 下一个汉字 3 字节，实际约 1 token）—— 上下文预算的判断全靠这个数，低估比没有更坏。
 * 它仍然是**估算**：上游 tokenizer 不同会有偏差，所以 UI 上标注「≈」。
 */
export function estimateTokens(text: string): number {
    let cjk = 0;
    let other = 0;
    for (const ch of text) {
        const cp = ch.codePointAt(0) ?? 0;
        // CJK 统一表意 / 扩展 A / 兼容 / 假名 / 谚文 / 全角标点
        if (
            (cp >= 0x4e00 && cp <= 0x9fff) ||
            (cp >= 0x3400 && cp <= 0x4dbf) ||
            (cp >= 0xf900 && cp <= 0xfaff) ||
            (cp >= 0x3040 && cp <= 0x30ff) ||
            (cp >= 0xac00 && cp <= 0xd7af) ||
            (cp >= 0xff00 && cp <= 0xffef)
        ) {
            cjk++;
        } else {
            other++;
        }
    }
    return Math.ceil(cjk + other / 4);
}

/** 字节数（UTF-8；渲染层没有 TextEncoder 之外的依赖，直接用它） */
function bytesOf(s: string): number {
    return new TextEncoder().encode(s).length;
}

function preview(s: string): string {
    if (s.length <= PREVIEW) return s;
    return `${s.slice(0, PREVIEW)}…（共 ${s.length} 字）`;
}

/** 分片数组里的一项 → 可读文本（tool-result 只报输出长度，避免把大 payload 糊满屏） */
function partText(p: unknown): string {
    const o = p as { type?: unknown; text?: unknown; output?: unknown };
    if (typeof o?.text === "string") return o.text;
    if (o?.type === "tool-result") {
        const out = typeof o.output === "string" ? o.output : JSON.stringify(o.output ?? "");
        return `[tool-result] ${preview(out)}`;
    }
    return JSON.stringify(p);
}

/** content 数组里的 tool-call 分片 → 结构化（形状与上游对齐：`{type:"tool-call", toolName, input}`） */
function readToolCalls(content: unknown): StepToolCall[] {
    if (!Array.isArray(content)) return [];
    const out: StepToolCall[] = [];
    for (const p of content) {
        const o = p as { type?: unknown; toolName?: unknown; name?: unknown; input?: unknown; args?: unknown };
        if (o?.type !== "tool-call") continue;
        const rawArgs = JSON.stringify(o.input ?? o.args ?? {});
        out.push({
            name: typeof o.toolName === "string" ? o.toolName : typeof o.name === "string" ? o.name : "(未命名)",
            argsChars: rawArgs.length,
            argsPreview: preview(rawArgs),
        });
    }
    return out;
}

/** content → 可读文本（字符串原样；分片数组按类型摊平；tool-call 只在正文留一行摘要） */
function contentText(c: unknown): string {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
        return c
            .map((p) => {
                const o = p as { type?: unknown; toolName?: unknown; name?: unknown; input?: unknown; args?: unknown };
                if (o?.type === "tool-call") {
                    const name = typeof o.toolName === "string" ? o.toolName : typeof o.name === "string" ? o.name : "(未命名)";
                    return `[tool-call ${name}] ${preview(JSON.stringify(o.input ?? o.args ?? {}))}`;
                }
                return partText(p);
            })
            .join("\n");
    }
    return c === undefined || c === null ? "" : JSON.stringify(c);
}

/** 请求体里我们只关心这一小片（`traffic.query` 的 reqBody 是它的超集） */
export interface RequestBodyLike {
    head?: string;
    tail?: string;
    truncated?: boolean;
    totalBytes?: number;
}

/**
 * 一条流量记录 → 该步真发的消息。
 *
 * 判据（刻意保守，宁可给不出也不编）：
 *   · 请求体缺席 / 空串 → `messages: null` + note；
 *   · `truncated`（默认只留首尾）→ 解不开就如实说，**不把半截 JSON 当正文**渲染；
 *   · 解开了但没有 `messages` 数组 → 同样 `null`（可能是摘要 / 探测请求）。
 */
export function parseStepRequest(rb: RequestBodyLike | null | undefined): StepRequest {
    const empty = (note: string): StepRequest => ({
        messages: null,
        raw: null,
        note,
        totalChars: 0,
        totalBytes: 0,
        totalTokens: 0,
    });
    if (!rb || typeof rb.head !== "string" || rb.head === "") return empty("这条记录没有请求正文。");
    let json: { messages?: unknown };
    try {
        json = JSON.parse(rb.head) as { messages?: unknown };
    } catch {
        return empty(
            rb.truncated
                ? `请求正文被截断（共 ${rb.totalBytes ?? 0} 字节，默认只留首尾）—— 在流量页打开「记录完整请求内容」后重发一轮即可见全文。`
                : "请求正文不是合法 JSON。",
        );
    }
    if (!Array.isArray(json.messages)) return empty("请求体里没有 messages 数组（可能是摘要 / 探测请求）。");
    const messages: StepMessage[] = (json.messages as Array<{ role?: unknown; content?: unknown }>).map((m, i) => {
        const text = contentText(m?.content);
        const toolCalls = readToolCalls(m?.content);
        return {
            index: i + 1,
            role: String(m?.role ?? "?"),
            text,
            toolCalls,
            chars: text.length,
            bytes: bytesOf(JSON.stringify(m ?? null)),
            tokens: estimateTokens(text),
        };
    });
    const totalChars = messages.reduce((n, m) => n + m.chars, 0);
    const totalBytes = messages.reduce((n, m) => n + m.bytes, 0);
    const totalTokens = estimateTokens(messages.map((m) => m.text).join("\n"));
    return {
        messages,
        // `<>` 视图给 messages 数组本身（不含请求头 / 工具定义）—— 逐字、可复制、可 diff
        raw: JSON.stringify(json.messages, null, 2),
        note: "",
        totalChars,
        totalBytes,
        totalTokens,
    };
}
