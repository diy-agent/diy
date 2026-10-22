/**
 * model-unavailable.ts — 「模型不可用」的**唯一判据**（纯函数；main 与 renderer 同源）。
 *
 * 为什么要有这一份：真 LLM 实验里模型挂掉（下线 / id 写错 / key 失效 / 配额耗尽）时，
 * 失败**只落在会话流里** —— 用户不看会话就完全不知道"实验其实一次都没跑成"，
 * 于是 agent 要么悄悄失败、要么换模型乱试（##369）。本判据把"模型不可用"从
 * 一堆错误里**显式挑出来**，给上层（顶栏 bar / 通知 / 停工口径）一个可信信号。
 *
 * 边界（用户 2026-10-17 口径，写成判据就是这四类，**不多不少**）：
 *   · `coming-soon`   —— 上游声明模型还没上架（实测文案 `[model_coming_soon] ...`）
 *   · `unknown-model` —— 上游不认识这个模型 id（404 / unknown model / model not found…）
 *   · `auth`          —— 认证失败（401 / 403：key 没配、配错、被吊销）
 *   · `quota`         —— 配额 / 限流（429）
 *
 * **上游 5xx 与网络超时不算**：那是"服务端此刻不稳"，与"这个模型能不能用"是两件事 ——
 * 混进来会让 bar 天天亮，用户就不看了（告警疲劳），也分不清"该去配模型"还是"等一会儿再试"。
 *
 * 判据顺序即优先级：同一错误可能同时满足多条（如 401 + 文案里带 model 字样），
 * 先命中先算。`coming-soon` 排第一且**不看状态码** —— 上游就把它塞在 400/404 的 body 里，
 * 状态码不足以判它（拿状态码当判据会把"模型没上架"误报成"模型 id 写错"，指向完全不同的动作）。
 *
 * 纯函数：不碰 fs / 网络 / Date，输入即事实 —— 表驱动单测因此能穷举边界
 * （tests/core/model-unavailable.test.ts）。
 */

import { z } from "zod";

/** 判据命中的四类（顺序即优先级，见文件头） */
export const ModelUnavailableKindSchema = z.enum(["coming-soon", "unknown-model", "auth", "quota"]);
export type ModelUnavailableKind = z.infer<typeof ModelUnavailableKindSchema>;

/**
 * 四类判据 → 一句话标签（用户不必知道判据名，只需知道「该干什么」）。
 * 放 shared 而不是各组件里：顶栏 bar 与模型配置页的回看列表要**同一套词**（##407）。
 */
export const MODEL_UNAVAILABLE_KIND_LABEL: Record<ModelUnavailableKind, string> = {
    "coming-soon": "模型未上架",
    "unknown-model": "模型 id 不认识",
    auth: "认证失败",
    quota: "配额或限流",
};

/** 探测到的错误事实（各字段都可缺：上游可能只回 body、SDK 可能只填 message） */
export interface ModelErrorProbe {
    /** HTTP 状态码（拿不到 = null：网络错误 / 超时根本没有响应） */
    statusCode: number | null;
    /** 上游响应正文**原文**（不解析：不同 provider 的 JSON 形状不统一，正则比解析稳） */
    responseBody: string | null;
    /** 错误消息（SDK 的 message；常常就是上游原文，故与 responseBody 一起参与判据） */
    message: string | null;
}

export interface ModelUnavailableHit {
    hit: true;
    kind: ModelUnavailableKind;
    /** 人读的命中理由（bar 的小字 / 单测断言用） */
    reason: string;
    /** 上游原文（截断后的，给用户看"到底说了什么"） */
    upstream: string;
}

export interface ModelUnavailableMiss {
    hit: false;
    /** 为什么不算（写清楚，避免"为什么没提示"变成要读代码才能答的问题） */
    reason: string;
}

export type ModelUnavailableVerdict = ModelUnavailableHit | ModelUnavailableMiss;

/** 上游原文展示上限：bar 上放不下长正文，且超长 body 里只有第一句是有用的 */
export const MAX_UPSTREAM_CHARS = 300;

/** 把错误事实拍成一段可搜索文本（body 优先，message 兜底 —— 两者都可能各带一半原文） */
function searchText(p: ModelErrorProbe): string {
    return [p.responseBody, p.message].filter((s): s is string => typeof s === "string" && s.length > 0).join("\n");
}

/** 上游原文：优先 body，其次 message；压缩空白 + 截断（`maxLength` 之外的用省略号收口） */
export function upstreamText(p: ModelErrorProbe, maxLength = MAX_UPSTREAM_CHARS): string {
    const raw = p.responseBody ?? p.message ?? "";
    const flat = raw.replace(/\s+/g, " ").trim();
    return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat;
}

/**
 * 判据表：**顺序即优先级**（第一条命中即返回）。
 * 表驱动而非 if 链：加一类只加一行；单测也能逐行对照"这条为什么算/不算"。
 */
const RULES: ReadonlyArray<{
    kind: ModelUnavailableKind;
    reason: string;
    test: (p: ModelErrorProbe, text: string) => boolean;
}> = [
    {
        kind: "coming-soon",
        reason: "上游声明该模型尚未上架（model_coming_soon）",
        // 不看状态码：上游把它放在 400/404 的 body 里（实测过的形态）
        test: (_p, text) => /model_coming_soon|model coming soon/i.test(text),
    },
    {
        kind: "unknown-model",
        reason: "上游不认识该模型 id（404 / unknown model）",
        test: (p, text) =>
            p.statusCode === 404 ||
            /unknown model|model not found|no such model|unsupported model|model[^.\n]{0,40}does not exist/i.test(text),
    },
    {
        kind: "auth",
        reason: "认证失败（401 / 403：key 未配、配错或被吊销）",
        test: (p) => p.statusCode === 401 || p.statusCode === 403,
    },
    {
        kind: "quota",
        reason: "配额或限流（429）",
        test: (p) => p.statusCode === 429,
    },
];

/**
 * 判「这次失败是不是模型不可用」。命中给类别 + 原文；不命中给理由（都是可读的一句话）。
 */
export function classifyModelUnavailable(p: ModelErrorProbe): ModelUnavailableVerdict {
    const text = searchText(p);
    for (const rule of RULES) {
        if (rule.test(p, text)) {
            return { hit: true, kind: rule.kind, reason: rule.reason, upstream: upstreamText(p) };
        }
    }
    // ── 不命中：把"为什么不提示"说清楚（同一句话直接进单测断言） ──
    if (p.statusCode != null && p.statusCode >= 500) {
        return { hit: false, reason: `上游 ${p.statusCode}：服务端故障（另一类问题，不是模型不可用）` };
    }
    if (p.statusCode != null) {
        return { hit: false, reason: `HTTP ${p.statusCode}：不在「模型不可用」判据内` };
    }
    return { hit: false, reason: "没有 HTTP 状态码：网络错误 / 超时（另一类问题，不是模型不可用）" };
}

// ─── 从抛出来的异常里取事实 ──────────────────────────

/** 探测深度上限：RetryError 会包一层 lastError（SDK 重试耗尽后的形状） */
const MAX_PROBE_DEPTH = 3;

function asRecord(v: unknown): Record<string, unknown> | null {
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function asText(v: unknown): string | null {
    return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 从任意抛出的值里抽出 {@link ModelErrorProbe}。
 *
 * 为什么用**结构化读取**而不是 `APICallError.isInstance`：错误链上不止一种形状
 * （APICallError / RetryError（`lastError`）/ 普通 Error），逐个 `instanceof` 会漏；
 * 而这里要的只是三个字段，按名字读 + 顺着 `cause` / `lastError` 下一层就够，
 * 且不引入对 `ai` 包的依赖（本文件要能在 renderer 里跑）。
 *
 * 字段名按"常见优先"取第一个非空值：SDK 用 `statusCode`，手写错误可能用 `status`。
 */
export function probeModelError(e: unknown): ModelErrorProbe {
    let statusCode: number | null = null;
    let responseBody: string | null = null;
    let message: string | null = null;
    let cur: unknown = e;
    for (let depth = 0; depth < MAX_PROBE_DEPTH && cur != null; depth++) {
        const o = asRecord(cur);
        if (!o) {
            message ??= asText(cur);
            break;
        }
        statusCode ??= asNumber(o.statusCode) ?? asNumber(o.status);
        responseBody ??= asText(o.responseBody) ?? asText(o.body) ?? asText(o.text);
        message ??= asText(o.message);
        cur = o.cause ?? o.lastError ?? null;
    }
    return { statusCode, responseBody, message };
}

// ─── 通知契约（RPC 输出 / renderer 消费 / CLI 打印共用同一份 zod） ─────

/**
 * 一条「模型不可用」通知：字段即 bar 上要显示的东西。
 * 放这里（shared）而不是 main 侧：它是**跨层契约**（RPC output 直接用它，renderer 同源类型）。
 */
export const ModelUnavailableNoticeSchema = z.object({
    /** 幂等 id（dismiss 用它） */
    id: z.string(),
    /** 发生时刻（ISO） */
    ts: z.string(),
    kind: ModelUnavailableKindSchema,
    /** 判据理由（人读：为什么算「模型不可用」） */
    reason: z.string(),
    /** 上游原文（截断；用户要看到"上游到底说了什么"） */
    upstream: z.string(),
    /** HTTP 状态码（无响应 = null） */
    statusCode: z.number().nullable(),
    /** 人物：id + 显示名（"谁在用这个模型" → 用户知道该去改哪个人物） */
    personaId: z.string(),
    personaName: z.string(),
    /** 模型 id（bar 的主角） */
    model: z.string(),
    /**
     * provider 段（std = models.dev id；custom = `custom:<key>`；拿不到 = ""）。
     * 用途只有一个：##407 的修复引导据此定位到**那张 provider 卡片**（`providerAnchor()`）——
     * 提示说「去配 key」，总得知道去哪张卡上配。
     */
    provider: z.string(),
    /** 哪个任务触发的（可去会话里看上下文） */
    taskUri: z.string(),
});
export type ModelUnavailableNotice = z.infer<typeof ModelUnavailableNoticeSchema>;
