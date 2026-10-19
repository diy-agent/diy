// src/shared/usage.ts
// 🎯 用量桶 / 单价 / 金额的**唯一口径定义处**（纯数据 + 纯函数，无 node 依赖）。
//
// 为什么单独一个文件：落盘（local-agent）、展示（renderer 页脚/明细/看板）、CLI 三处
// 必须同源同口径 —— 各算各的必然出现「UI 说是 3 块、CLI 说是 5 块」那种不可信的数
// （##227 的核心诉求就是「数字可信才敢用来决定何时重置」）。真值设计见 ##211 §六b/§四。
//
// ── 术语契约（禁止把包含关系显示成并列关系）──
//   总输入 = 非缓存 + 缓存读 + 缓存写
//   总输出 = 文本输出 + 思考输出       （思考是总输出的**子集**：展示可拆、计价不另加）
//   窗口占用 = 总输入 + 总输出
//   计费桶 4 个 = 非缓存 / 缓存读 / 缓存写 / **总输出**
//   ——❌ 不写「输出 29 · 思考 7」（歧义） → ✅ 写「总输出 29（文本 22 + 思考 7）」
//
// ⚠️ **桶名一律不带「输入」后缀**（##354 ①）：组行才叫「总输入」，三个子桶是
//   「非缓存 / 缓存读 / 缓存写」—— 有的带后缀有的不带就不是一组（且与金额列「非缓存$」自相矛盾）。
//   这三个词与上游 `noCacheTokens / cacheReadTokens / cacheWriteTokens` 同构，UI 与 CLI 同词。
//
// **不可测 ≠ 0**：`api:"chat"` 面拿不到 cacheWrite（ai-sdk 的 openai-compatible 恒返回
// undefined），该桶一律 `null`（不可测），绝不落 0（0 = 实测为零，是另一个事实，混了就是静默低估算钱）。

import { z } from "zod";
import { formatMinuteOfDay, formatOffset, matchUtcRange, type CalendarTable, type UtcRangeWindow } from "./calendars";

/** 单价（$ / 1M tokens）。缺字段 = 该 provider 未给该桶定价 */
export interface ModelRates {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
}

/**
 * 阶梯价条目的**触发条件**（运行时归一形状；判别键 `kind`）。
 *
 * 两类**不可比大小**，故规则不同：
 *   · `context`   —— 总输入 token **严格大于** `size` 时整档生效（models.dev 的 `tier.size`）；
 *                    有多个时取「满足条件的**最大**阈值」（pi / opencode 两家一致，##211 §四.2）。
 *   · `utc-range` —— 请求时刻落在 `[startMin, endMin)` 且日历判为工作日 → 命中；
 *                    这是**分类**而非阈值，故取「**按序首个命中**」（两个时段窗之间没有大小可言）。
 *
 * 匹配优先级：**时段价先于上下文阶梯**（时段更具体；两类不叠加 —— DeepSeek 的峰谷与上下文长度无关）。
 */
export type TierWhen = { kind: "context"; size: number } | ({ kind: "utc-range" } & UtcRangeWindow);

/** 阶梯价条目：价目（公共字段）+ 触发条件（`when` 私有） */
export type ModelTier = ModelRates & { when: TierWhen };

/** 模型表里的价格配置（真源 models.dev，抓取日期见 models.ts；diy 补丁见 ##281） */
export interface ModelCost extends ModelRates {
    tiers?: ModelTier[];
    /** 时段档「未命中任何窗」时的展示名（如 `"off-peak"`）；缺省 `"base"` */
    baseLabel?: string;
}

/**
 * 运行时价目形状的**线上 schema**（`kind` 判别；与 `ModelCost` 同构）。
 *
 * 为什么要有：RPC 的 `outputSchema` **只用于类型推导、运行期不校验**（见 diy-rpc meta.ts）——
 * 所以「类型漏写 tiers/baseLabel」不会报错，只在**消费端**表现为「拿不到、画不出」，极难发现。
 * 这里把形状固化成 schema，api-def 与 renderer 都引用它：漂移 = 编译期报错，而不是静默丢字段。
 * 与写侧 schema（`shared/model-config.ts` 的 `TierWhenSchema`，判别键 `type` + `data`）是**两套**：
 * 那边是 YAML 人写形状，这边是解析后的 camelCase 运行时形状。
 */
export const RuntimeTierWhenSchema: z.ZodType<TierWhen> = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("context"),
        /** 总输入 token 严格大于它 → 整档生效 */
        size: z.number(),
    }),
    z.object({
        kind: z.literal("utc-range"),
        startMin: z.number(),
        endMin: z.number(),
        offsetMs: z.number(),
        calendar: z.string().optional(),
        label: z.string().optional(),
    }),
]);

/** 单条档（价目 + 触发条件） */
export const RuntimeModelTierSchema: z.ZodType<ModelTier> = z.object({
    when: RuntimeTierWhenSchema,
    input: z.number(),
    output: z.number(),
    cacheRead: z.number().optional(),
    cacheWrite: z.number().optional(),
});

/** 生效价目（camelCase 运行时形状）：RPC 下发 / UI 展示 / CLI 输出共用 */
export const ModelCostSchema: z.ZodType<ModelCost> = z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number().optional(),
    cacheWrite: z.number().optional(),
    baseLabel: z.string().optional(),
    tiers: z.array(RuntimeModelTierSchema).optional(),
});

/**
 * 分档价 → 逐行说明（UI tooltip / CLI 排错用）。
 *
 * 为什么需要：模型表的「输入$/1M」等列**只能画 base 档**。有分档却不写出来 = 最坏的静默：
 * 看着 0.15 的价，实际按 0.5 收（峰价），或按 3 收（长上下文）—— 用户会以为账算错了。
 */
export function describeTiers(cost: ModelCost | null | undefined): string[] {
    const out: string[] = [];
    for (const t of cost?.tiers ?? []) {
        const w = t.when;
        if (w.kind === "utc-range") {
            const scope = `${formatMinuteOfDay(w.startMin)}–${formatMinuteOfDay(w.endMin)} ${formatOffset(w.offsetMs)}` +
                (w.calendar ? ` · ${w.calendar}` : "");
            out.push(`${w.label ?? "时段档"}（${scope}）：in ${t.input} / out ${t.output}${t.cacheRead === undefined ? "" : ` / cache ${t.cacheRead}`}`);
        } else {
            out.push(`总输入 > ${w.size} tokens：in ${t.input} / out ${t.output}${t.cacheRead === undefined ? "" : ` / cache ${t.cacheRead}`}`);
        }
    }
    return out;
}

/** 生效单价快照：选中的那一档 + 来源。**单价会变，历史账不能漂**，故随每行落盘 */
export interface EffectiveRates extends ModelRates {
    /** "base" | "input>272000" —— 直观说明为什么是这组价（**上下文档**） */
    tier: string;
    /** 时段档标（如 "peak" / "off-peak"）；该模型无时段价 → 缺省 */
    window?: string;
    /** 真源标识（如 "models.dev@2026-10-02"） */
    source: string;
}

export const COST_SOURCE = "models.dev";

/**
 * 一步的「计价依据」（##372）：查价用的是**哪个模型标识**，而不是"算出来多少"。
 *
 *   · `response` —— 命中**上游回执**的模型（正常路径；上游路由改写时按实际模型计价，##211 §四.4.4）
 *   · `request`  —— 回执**根本没报模型** → 按**本请求**模型（同 provider/account；用户口径 2026-10-17
 *                   仍允许：请求的即用于计价，**不是**跨 provider 回退）
 *   · `none`     —— 回执报的模型本家无报价 / 无从归属 provider → 该行 `cost` 为 null
 *                   （**不是 0**，UI 显示「—」）。**用户口径：绝不回退**（不拿别家/别模型的价顶上）
 */
export type PriceBasis = "response" | "request" | "none";

/**
 * 计费/展示四桶（+ 两个明细）。全部来自 ai-sdk 归一化后的 `LanguageModelUsage`：
 *   inputTokens.total  = noCacheTokens + cacheReadTokens + cacheWriteTokens
 *   outputTokens.total = textTokens + reasoningTokens
 * （权威关系见 ##211 §1b，实测自 ai/dist/index.js 的 asLanguageModelUsage）
 */
export interface UsageBuckets {
    /** 非缓存（未命中前缀缓存、按全价计的部分） */
    noCache: number;
    /** 缓存读（暖输入，按 cache_read 单价） */
    cacheRead: number;
    /** 缓存写；**null = 该 API 面不可测**（不是 0） */
    cacheWrite: number | null;
    /** 文本输出 */
    text: number;
    /** 思考输出（**总输出的子集**，不另加价） */
    reasoning: number;
    /** 总输出 = text + reasoning */
    outputTotal: number;
    /** 总输入 = noCache + cacheRead + (cacheWrite ?? 0) */
    inputTotal: number;
    /** 总输入 + 总输出（= 窗口占用分子） */
    total: number;
}

/** 形状宽松的 usage 输入：ai-sdk 的字段在运行时可能 undefined，故全部可缺省 */
export interface UsageLike {
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    inputTokenDetails?: {
        noCacheTokens?: number | null;
        cacheReadTokens?: number | null;
        cacheWriteTokens?: number | null;
    } | null;
    outputTokenDetails?: {
        textTokens?: number | null;
        reasoningTokens?: number | null;
    } | null;
    /** provider 原始 usage 对象（ai-sdk `LanguageModelUsage.raw`） */
    raw?: unknown;
}

const num = (v: number | null | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** 可缺省的计数：undefined/null → null（**不可测**语义，与 0 区分） */
const opt = (v: number | null | undefined): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * `LanguageModelUsage` → 四桶。
 *
 * 兜底逻辑（上游偶发只给总数、不给明细）：
 *   · 缺 `noCacheTokens` 时按 `inputTokens.total - cacheRead - cacheWrite` 反推（≥0）；
 *   · 缺 `textTokens` 时按 `outputTokens.total - reasoningTokens` 反推。
 * 反推只用于**展示与估算**，桶本身仍以 provider 上报为真（##211 §五.5：估算绝不用于计费）。
 */
export function bucketsOf(u: UsageLike | undefined | null): UsageBuckets {
    const d = u?.inputTokenDetails ?? {};
    const od = u?.outputTokenDetails ?? {};
    const cacheWrite = opt(d.cacheWriteTokens);
    const cacheRead = num(d.cacheReadTokens);
    const inputTotal = num(u?.inputTokens);
    const noCache = d.noCacheTokens != null ? num(d.noCacheTokens) : Math.max(0, inputTotal - cacheRead - (cacheWrite ?? 0));
    const outputTotal = num(u?.outputTokens);
    const reasoning = num(od.reasoningTokens);
    const text = od.textTokens != null ? num(od.textTokens) : Math.max(0, outputTotal - reasoning);
    return {
        noCache,
        cacheRead,
        cacheWrite,
        text,
        reasoning,
        outputTotal,
        inputTotal: noCache + cacheRead + (cacheWrite ?? 0),
        total: noCache + cacheRead + (cacheWrite ?? 0) + outputTotal,
    };
}

/**
 * 选出生效单价。**两段规则**（顺序即优先级，见 `TierWhen`）：
 *   ① 时段价（`utc-range`）：命中即用 —— **按序首个命中**，`atMs` = 请求发起时刻。
 *      引用了不存在的日历 → 该窗不命中（`matchUtcRange` 语义），退到 base 价，**绝不静默用错价**。
 *   ② 上下文阶梯（`context`）：按**总输入 token**（非缓存 + 缓存读 + 缓存写）比阈值，
 *      取满足条件的**最大阈值**（pi / opencode 两家一致，##211 §四.2）。
 *
 * `tier` = 上下文档位（"base" / "input>272000"）；`window` = 时段标（"peak" / "off-peak"）。
 * 两者是**不同轴**，分开落盘 —— 混成一个字符串日后无法回答「这轮贵是因为长上下文还是峰价」。
 */
export function ratesOf(
    cost: ModelCost | undefined,
    promptTokens: number,
    atMs?: number,
    calendars?: CalendarTable,
): EffectiveRates | null {
    if (!cost) return null;
    const tiers = cost.tiers ?? [];

    // ① 时段价：分类，故「按序首个命中」
    if (calendars && tiers.length > 0) {
        const at = atMs ?? Date.now();
        for (const t of tiers) {
            if (t.when.kind !== "utc-range") continue;
            if (matchUtcRange(t.when, at, calendars)) {
                return {
                    input: t.input,
                    output: t.output,
                    cacheRead: t.cacheRead,
                    cacheWrite: t.cacheWrite,
                    tier: "base",
                    window: t.when.label ?? cost.baseLabel ?? "base",
                    source: COST_SOURCE,
                };
            }
        }
    }

    // ② 上下文阶梯：取满足条件的最大阈值
    let rates: ModelRates = cost;
    let tier = "base";
    let matched = -1;
    for (const t of tiers) {
        if (t.when.kind !== "context") continue;
        if (promptTokens > t.when.size && t.when.size > matched) {
            rates = t;
            matched = t.when.size;
            tier = `input>${t.when.size}`;
        }
    }
    return {
        input: rates.input,
        output: rates.output,
        cacheRead: rates.cacheRead,
        cacheWrite: rates.cacheWrite,
        tier,
        source: COST_SOURCE,
        ...(cost.baseLabel ? { window: cost.baseLabel } : {}),
    };
}

/**
 * 金额分解（$）。`total` 只把「总输出」收一次 —— 思考是总输出的子集，**不另加**。
 * 用 type（对象字面量类型）而非 interface：Op 的 fields 是 `Record<string, JSONVal>`，
 * 只有字面量类型能满足索引签名（interface 不满足，TS 会拒绝赋值）。
 */
export type CostBreakdown = {
    /** 非缓存金额 */
    noCache: number;
    /** 缓存读金额 */
    cacheRead: number;
    /** 缓存写金额；**null = 该桶不可测**（不是 0） */
    cacheWrite: number | null;
    /** 文本输出金额 */
    text: number;
    /** 思考输出金额（**总输出金额的拆解子项**，不额外加进 total） */
    reasoning: number;
    /** = noCache + cacheRead + cacheWrite + 文本 + 思考 */
    total: number;
};

const PER_M = 1_000_000;

/**
 * 桶 × 单价 → 金额。
 * 不可测桶（`cacheWrite: null`）→ 金额也是 null（**不按 0 算**，否则静默低估）；
 * 若该模型无 cacheWrite 价但有实测 token，按普通输入价兜底（保守且可解释）。
 */
export function costBreakdown(rates: EffectiveRates, b: Pick<UsageBuckets, "noCache" | "cacheRead" | "cacheWrite" | "text" | "reasoning">): CostBreakdown {
    const noCache = (rates.input * b.noCache) / PER_M;
    const cacheRead = ((rates.cacheRead ?? rates.input) * b.cacheRead) / PER_M;
    const cacheWrite = b.cacheWrite == null ? null : ((rates.cacheWrite ?? rates.input) * b.cacheWrite) / PER_M;
    const text = (rates.output * b.text) / PER_M;
    const reasoning = (rates.output * b.reasoning) / PER_M;
    return { noCache, cacheRead, cacheWrite, text, reasoning, total: noCache + cacheRead + (cacheWrite ?? 0) + text + reasoning };
}

/** 会话/分组累计（同口径相加；null 桶保持 null 直到有实测值） */
export function sumBuckets(list: UsageBuckets[]): UsageBuckets {
    const acc: UsageBuckets = { noCache: 0, cacheRead: 0, cacheWrite: null, text: 0, reasoning: 0, outputTotal: 0, inputTotal: 0, total: 0 };
    for (const b of list) {
        acc.noCache += b.noCache;
        acc.cacheRead += b.cacheRead;
        if (b.cacheWrite != null) acc.cacheWrite = (acc.cacheWrite ?? 0) + b.cacheWrite;
        acc.text += b.text;
        acc.reasoning += b.reasoning;
        acc.outputTotal += b.outputTotal;
        acc.inputTotal += b.inputTotal;
        acc.total += b.total;
    }
    return acc;
}

export function sumCosts(list: CostBreakdown[]): CostBreakdown {
    const acc: CostBreakdown = { noCache: 0, cacheRead: 0, cacheWrite: null, text: 0, reasoning: 0, total: 0 };
    for (const c of list) {
        acc.noCache += c.noCache;
        acc.cacheRead += c.cacheRead;
        if (c.cacheWrite != null) acc.cacheWrite = (acc.cacheWrite ?? 0) + c.cacheWrite;
        acc.text += c.text;
        acc.reasoning += c.reasoning;
        acc.total += c.total;
    }
    return acc;
}

/** 窗口占用率（0~1）；上限未知/为 0 → null（UI 显示"—"，不编一个百分比） */
export function windowRate(b: Pick<UsageBuckets, "total">, contextLimit: number | undefined): number | null {
    if (!contextLimit || contextLimit <= 0) return null;
    return b.total / contextLimit;
}

/** 缓存命中率 = 缓存读 / 总输入（0~1）；总输入为 0 → null */
export function cacheHitRate(b: Pick<UsageBuckets, "cacheRead" | "inputTotal">): number | null {
    return b.inputTotal > 0 ? b.cacheRead / b.inputTotal : null;
}

// ─── 展示格式化（UI 与 CLI 共用，避免两处各写一套导致"数一样但写法不同"）──

/** 千分位整数（token 数用；设计样例用 `1,050k` 这种，先做整数版） */
export function fmtInt(n: number): string {
    return n.toLocaleString("en-US");
}

/** token 计数：<10k 原样（带千分位）；否则 x.xk；≥1M 用 x.xxM */
export function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
    return fmtInt(Math.round(n));
}

/** 金额：小额保留 6 位（否则四舍五入成 0 就白显示了），常规 4 位 */
export function fmtCost(n: number): string {
    if (n === 0) return "0";
    if (n >= 0.01) return n.toFixed(4);
    return n.toFixed(6);
}

/**
 * 组成项文本：可测 → `非缓存54+缓存读198`；不可测项**省略**（不写 0）。
 * 钉死「总输入(组成)」这一种句式，UI/CLI 都调它，防止又冒出并列句式。
 */
export function composeInput(b: Pick<UsageBuckets, "noCache" | "cacheRead" | "cacheWrite">): string {
    const parts = [`非缓存${fmtTokens(b.noCache)}`, `缓存读${fmtTokens(b.cacheRead)}`];
    if (b.cacheWrite != null) parts.push(`缓存写${fmtTokens(b.cacheWrite)}`);
    return parts.join("+");
}

/** 组成项文本：`文本22+思考7`（思考可测时；不可测则不写） */
export function composeOutput(b: Pick<UsageBuckets, "text" | "reasoning">): string {
    return `文本${fmtTokens(b.text)}+思考${fmtTokens(b.reasoning)}`;
}

// ─── 落盘记录（`<key>.usage.jsonl` 一行 = 一个请求步）──

/** 照抄 ai-sdk `LanguageModelUsage` 的落盘形状：字段全在，缺失一律 `null`（不吞字段） */
export interface UsageSnapshot {
    inputTokens: number | null;
    inputTokenDetails: {
        noCacheTokens: number | null;
        cacheReadTokens: number | null;
        cacheWriteTokens: number | null;
    };
    outputTokens: number | null;
    outputTokenDetails: {
        textTokens: number | null;
        reasoningTokens: number | null;
    };
    totalTokens: number | null;
    /** provider 原始 usage（保后路：将来要新字段时不必回头补数据） */
    raw?: unknown;
}

/** `LanguageModelUsage` → 落盘快照（undefined → null：JSON 里必须看得见"没有这个数"） */
export function snapshotUsage(u: UsageLike | undefined | null): UsageSnapshot | null {
    if (!u) return null;
    const d = u.inputTokenDetails ?? {};
    const od = u.outputTokenDetails ?? {};
    return {
        inputTokens: opt(u.inputTokens),
        inputTokenDetails: {
            noCacheTokens: opt(d.noCacheTokens),
            cacheReadTokens: opt(d.cacheReadTokens),
            cacheWriteTokens: opt(d.cacheWriteTokens),
        },
        outputTokens: opt(u.outputTokens),
        outputTokenDetails: {
            textTokens: opt(od.textTokens),
            reasoningTokens: opt(od.reasoningTokens),
        },
        totalTokens: opt(u.totalTokens),
        ...(u.raw !== undefined ? { raw: u.raw } : {}),
    };
}

export interface StepPerformance {
    stepTimeMs?: number;
    /**
     * 模型**响应**耗时（不含客户端工具执行；ai-sdk 的 `performance.responseTimeMs`）。
     * **速度的分母就是它**（含首字等待 TTFT，##349 第四次修正）—— 用 `stepTimeMs` 会把工具执行
     * 时间算进去，工具跑 30s、模型写 1s 时除下来等于"没在写"（`stepRate` 头注）。
     */
    responseTimeMs?: number;
    timeToFirstOutputMs?: number;
    /** = `outputTokens / (responseTimeMs − timeToFirstOutputMs)`（ai-sdk 给的另一个值；**含**首字等待的口径见下一字段） */
    outputTokensPerSecond?: number;
    /**
     * = `outputTokens / responseTimeMs` —— **这就是我们要的口径**（token ÷ 总耗时，含首字等待；
     * ##349 第四次修正），`stepRate` 直接取它。旧注释曾写"不是我们的口径、别用"，已作废。
     */
    effectiveOutputTokensPerSecond?: number;
}

/**
 * 一步（= 一次上游请求）的用量记录。**行自带身份**：同一会话里每步的模型/人物/面/档位
 * 可以不同（切模型、子 agent 用别的模型），所以身份是行的属性而不是标题的属性（##211 §六b.6）。
 */
/** 一步 fullStream 的 part 形状：`order` 每出现一个 part 段首追加一字符（r=思考 t=文本 x=工具） */
export interface StepStreamShape {
    /** 段首顺序串，如 `rxx`（先思考、再两次工具调用）、`t`（纯文本结论） */
    order: string;
    textChunks: number;
    reasoningChunks: number;
    toolCalls: number;
}

export interface StepUsageRecord {
    ts: string;
    /** 与本任务 steps.jsonl 的 turnId 同源，可 join */
    turnId: string;
    /** 本轮第几步（1-based，与 UI `s1/s2/…` 对齐） */
    step: number;
    persona?: string;
    /** 请求模型 */
    model: string;
    apiFace: string;
    reasoningEffort?: string;
    contextLimit?: number;
    /** 请求 id（上游回执） */
    responseId?: string;
    /** 响应模型（**按它查价**：上游可能路由改写） */
    responseModel?: string;
    /**
     * 计价依据（##372）：实际查价用的是哪个模型标识。**必须落盘** —— 「无价目」与「金额 0」
     * 在账上要能区分，否则事后翻账只能看到一排 0，无法回答「是没价目还是真没花钱」。
     */
    priceBasis?: PriceBasis;
    /** 实际查价用的模型（完全限定名；`priceBasis === "none"` 时无此字段） */
    priceRef?: string;
    finishReason?: string;
    /**
     * 上游**原始** finish_reason（未经 ai-sdk 归一，如 `tool_calls` / `stop` / `max_tokens` /
     * `content_filter`）。与 `finishReason`（归一后的 `stop|length|tool-calls|content-filter|error|other`）
     * 一起记：归一会丢信息（多个原始值可能映到同一个统一值，见 ##288 研究）。
     */
    rawFinishReason?: string;
    /**
     * 该步 fullStream 里 part 的**形状**（观察位，不参与计价）：顺序串 + 计数。
     * 用途：判定「这一步到底有没有正文/思考、工具调用是不是最后发生的」（##288 轮次结束语义）。
     */
    streamShape?: StepStreamShape;
    usage: UsageSnapshot;
    performance?: StepPerformance;
    /** 生效单价快照（含选中 tier 与真源日期） */
    rates?: (EffectiveRates & { asOf?: string }) | null;
    /** 金额分解（$）；不可测桶为 null */
    cost?: CostBreakdown | null;
    /**
     * 该步真发的构成字节（UTF-8）：系统提示词容器 + tools 定义 JSON。
     * 窗口构成报表（按轮/按步）的数据源；消息段由「该步 prompt（精确）− 前两段÷4 估算」导出。
     * optional：本版上线前的账本没有 → 三段显示 `–`（不编 0）。
     */
    contextParts?: { systemBytes: number; toolsBytes: number };
    /**
     * 该轮**首步**（step===1）投递时的历史选择（**配置驱动压缩的事实**）—— 供 UI 在分表标注
     * 「本步投递被压过」。**每轮重建**（`runTurn` 轮首按当前配置算一次），与是否写了压缩事件无关。
     * optional：本版上线前的账本没有 → 分表不标注（不编造）。
     */
    historySelection?: {
        /** 生效预算（字节）；0 = 清零 */
        budgetBytes: number;
        /** 实际保留的渲染后字节 */
        keptBytes: number;
        /** 保留的连续区间段数 */
        keptRuns: number;
        /** 被省的消息条数 */
        droppedMessages: number;
        /** 全量投影消息条数 */
        totalMessages: number;
    };
}

/**
 * 对话流 turn 页脚用的紧凑视图（main 每步 patch 进块属性）。
 *
 * 命名一律用四桶口径的名字（`inputTotal` / `cacheRead` …），不再用旧的 in/out/cached ——
 * 旧名字正是「把含缓存的 input 当总量累加」那次口径事故的残留；历史 ops.jsonl 里的旧形状
 * 由读侧单独识别降级（见 UsagePanel 的 isLegacyUsage），不必让新结构背这个包袱。
 */
export type TurnUsagePatch = {
    /** 本轮累计：总输入（= 非缓存 + 缓存读 + 缓存写） */
    inputTotal: number;
    /** 本轮累计：总输出（= 文本 + 思考） */
    outputTotal: number;
    /** 本轮累计：缓存读 */
    cacheRead: number;
    /** 本轮累计：非缓存 */
    noCache: number;
    /** 本轮累计：缓存写（全轮都不可测 → null） */
    cacheWrite: number | null;
    /** 本轮累计：文本输出 */
    text: number;
    /** 本轮累计：思考输出（总输出的子集） */
    reasoning: number;
    /** 本轮累计：总输入 + 总输出（各步之和，用于解释"这一轮为什么贵"） */
    total: number;
    /**
     * 窗口占用分子：**最后一步**的总输入 + 总输出 —— 上下文压力口径。
     * ⚠️ 与上面的累计字段（`inputTotal`/`outputTotal`）**不是同一个数**，也绝不能相除：
     * 40 步的累加能到 1M，而真实上下文只有最后一步的 44k。混用会得出"窗口 96%"这种假象。
     */
    windowTotal: number;
    /**
     * 最后一步的总输入 / 总输出（组成窗口占用，UI 用它摊开算式）。
     * ⚠️ optional：ops.jsonl 是 append-only 的史书，老会话里没有这几个字段
     * （它们是"口径标注"这一版才加的）—— 读侧必须能降级，不能因为缺字段就整轮不显示。
     */
    lastInputTotal?: number;
    lastOutputTotal?: number;
    /** 本轮步数（解释"为什么累计远大于窗口"：每一步都要重发整个上下文）；同上 optional */
    steps?: number;
    /**
     * **实时档**速度（tok/s）：本轮**最后一步**的生成速度（口径见 `stepRate`）。给不出数 → null。
     * ⚠️ 是"最后一步"而不是"正在跑的那一步"：流内的 token 计数拿不到，跑着的一步只能沿用
     * 上一个已完成步的实测值（该步一结束即刷新）。optional：本版之前的记录没有 → bar 不画。
     */
    lastStepRate?: number | null;
    /**
     * **轮均档**速度（tok/s）= 本轮 Σ总输出 ÷ Σ各步响应耗时（含首字等待，口径见 `avgRate`）。
     * 每步结束时随累计桶一起刷新，故直播中也是实时增长的真值（不是轮末才算一次）。
     * 给不出数（本步无计时 / 一步都还没完成）→ null。optional：##349 之前的记录没有 → 回退逐步账本。
     */
    turnRate?: number | null;
    /** 上下文窗口上限（未知 → null；UI 显示「—」而不是编一个百分比） */
    contextLimit: number | null;
    /**
     * 本轮累计金额。**只累加有价目的步**（##372）：无价目的步不再塞一个全 0 对象进来 ——
     * 那会让 UI 把「没价目」画成「$0.0000」，是本任务要修的静默形态。
     * 全部步都无价目 → null（UI 显示「$—」）。
     */
    cost: CostBreakdown | null;
    /**
     * 本轮**无价目**的步数（>0 = 上面的 cost 是部分和）。optional：本版之前的记录没有。
     */
    unpriced?: number;
    /** 该轮真发的构成字节（轮内各步相同；L2 构成卡实时源）。optional：老记录没有 → 三段 – */
    contextParts?: { systemBytes: number; toolsBytes: number };
};

/** 由累计桶 + 最后一步桶 + 累计金额 → turn 页脚视图 */
export function turnUsagePatch(
    cumulative: UsageBuckets,
    lastStep: UsageBuckets | null,
    cost: CostBreakdown | null,
    contextLimit?: number,
    steps = 0,
    contextParts?: { systemBytes: number; toolsBytes: number },
    /** 实时档：本轮最后一步的生成速度（`stepRate`）；给不出 → 传 null */
    lastStepRate: number | null = null,
    /** 轮均档：本轮 Σ总输出 ÷ Σ响应耗时（`avgRate`）；给不出 → 传 null（UI 回退逐步账本） */
    turnRate: number | null = null,
    /** 本轮**无价目**的步数（##372）；>0 时 UI 要标注"合计是部分和"，不能当成完整的 $ */
    unpriced = 0,
): TurnUsagePatch {
    return {
        inputTotal: cumulative.inputTotal,
        outputTotal: cumulative.outputTotal,
        cacheRead: cumulative.cacheRead,
        total: cumulative.total,
        noCache: cumulative.noCache,
        cacheWrite: cumulative.cacheWrite,
        text: cumulative.text,
        reasoning: cumulative.reasoning,
        windowTotal: lastStep?.total ?? cumulative.total,
        lastInputTotal: lastStep?.inputTotal ?? cumulative.inputTotal,
        lastOutputTotal: lastStep?.outputTotal ?? cumulative.outputTotal,
        steps,
        lastStepRate,
        turnRate,
        contextLimit: contextLimit ?? null,
        cost,
        unpriced,
        ...(contextParts ? { contextParts } : {}),
    };
}

// ─── 速度（三档 · 状态栏与用量表共用） ─────────────

/**
 * 通用底座：**Σ 输出 token ÷ Σ 总耗时**（ms）→ tok/s。任一前提缺 → null（不给假数）。
 *
 * 单步 / 轮均 / 总均三档共用它，只是求和范围不同（一步 / 一轮 / 全会话）。
 */
export function rateFromTotals(outputTokens: number, totalMs: number): number | null {
    if (!(outputTokens > 0) || !(totalMs > 0)) return null;
    const r = (outputTokens / totalMs) * 1000;
    return Number.isFinite(r) && r > 0 ? r : null;
}

/**
 * **一步的生成速度**（tok/s）= 该步总输出 ÷ 该步**总耗时**。
 *
 * 口径（用户 2026-10-15 拍板，第四次修正 —— 前三版分别是"轮次平均"、"当轮已输出 ÷ 已耗时"、
 * "响应耗时 − TTFT"）：
 *   · 分子 = **该步**总输出（含思考，与用量同口径）。不是本轮累计：累计 ÷ 耗时是"轮次平均"，
 *     把中间等待、工具执行、别的步的输出全摊进来，答不了"这步写得多快"。
 *   · 分母 = 该步**总耗时** = `responseTimeMs`（模型响应耗时，**含首字等待 TTFT**）。
 *     为什么不再减 TTFT：有的模型头 token 等很久、之后一次性高速返回 —— 只除以"首字后耗时"
 *     会算出几万 tok/s 的假象（用户 2026-10-15 现象）；**含等待**才是"这一步到底花了多久"。
 *     仍用 `responseTimeMs` 而**不是** `stepTimeMs`：后者含客户端工具执行耗时，
 *     工具跑 30s、模型写 1s 时除下来等于"没在写"。
 *   · `effectiveOutputTokensPerSecond`（ai-sdk 流式步已给）= `outputTokens / responseTimeMs`，
 *     与上面的口径逐字一致 ⇒ **直接取它**（真值来自上游计时，不是我们拼的）；缺了才现算。
 *
 * ⚠️ **粒度 = 一步**：流内部的 token 计数拿不到（usage 由 provider 在每步收尾才给），
 * 所以"跑着的那一步"只能显示上一个已完成步的实测值，该步一结束立刻刷新 —— 不拿按流式文本
 * 估的假数占位（实测那种估算中位误差 41%、p90 200%）。
 *
 * 任一前提缺 → null（宁可不显示，也不给假数）。
 */
export function stepRate(p: StepPerformance | undefined | null, outputTokens: number): number | null {
    const given = p?.effectiveOutputTokensPerSecond;
    if (typeof given === "number" && Number.isFinite(given) && given > 0) return given;
    const resp = p?.responseTimeMs;
    if (resp == null) return null;
    return rateFromTotals(outputTokens, resp);
}

/**
 * **多步的平均速度**（tok/s）= Σ 各步总输出 ÷ Σ 各步总耗时（`responseTimeMs`，含首字等待）。
 *
 * 两档共用这一个函数（口径一致 → 数字可比）：
 *   · **轮均**：传该轮的全部步 → "这一轮平均写得多快"；
 *   · **总均**：传全部轮的步（`recordsAvgRate`）→ "这个会话整体平均写得多快"。
 *
 * **以耗时为权的加权平均**（不是各步速度的算术平均）：慢步本来就占更多时间，理应权重更大；
 * 也与单步同口径（单步就是这个式子在一步上的特例）。
 * 只计**有计时且确有输出**的步（`responseTimeMs > 0` 且输出 > 0）：老记录 / 空工具步不进分母，
 * 免得把"没数的步"当成"零耗时"把平均值抬高。
 */
export function avgRate(steps: readonly { performance?: StepPerformance | null; outputTokens: number }[]): number | null {
    let out = 0;
    let ms = 0;
    let counted = 0;
    for (const s of steps) {
        const r = s.performance?.responseTimeMs;
        if (r == null || !(r > 0) || !(s.outputTokens > 0)) continue;
        out += s.outputTokens;
        ms += r;
        counted++;
    }
    return counted === 0 ? null : rateFromTotals(out, ms);
}

/** 逐步账本（落盘记录）→ 平均速度（**轮均 / 总均同一口径**）：Σ总输出 ÷ Σ响应耗时 */
export function recordsAvgRate(records: readonly StepUsageRecord[]): number | null {
    return avgRate(records.map((r) => ({ performance: r.performance, outputTokens: stepView(r).buckets.outputTotal })));
}

/** 速度展示（UI 与 CLI 同字形，避免两处各写一套）：给不出数 → `–`（不写 0） */
export function fmtRate(r: number | null | undefined): string {
    return r == null || !Number.isFinite(r) || r <= 0 ? "–" : `${Math.round(r)} tok/s`;
}

// ─── 聚合（UI 明细/看板与 CLI 表格共用）──

/** 一步的桶与金额（从落盘记录还原；记录缺 rates/cost 时按模型表**现价**重算并标记） */
export interface StepView {
    record: StepUsageRecord;
    buckets: UsageBuckets;
    /** 金额：记录里有快照就用快照（历史账不漂）；没有则 null（不猜） */
    cost: CostBreakdown | null;
    /** 窗口占用率（该步总输入+总输出 / 窗口上限）；上限未知 → null */
    windowRate: number | null;
}

/**
 * 桶一律从 `usage` 现算（口径唯一），金额**优先用落盘快照** ——
 * 单价会变，历史记录必须用当时的价（##211 §四.4.6）。
 */
export function stepView(r: StepUsageRecord): StepView {
    const buckets = bucketsOf(r.usage as UsageLike);
    return {
        record: r,
        buckets,
        cost: r.cost ?? null,
        windowRate: windowRate(buckets, r.contextLimit),
    };
}

/** 一个 turn 的明细（步按 step 升序；金额为快照之和，全部缺价时 null） */
export interface TurnGroup {
    turnId: string;
    steps: StepView[];
    buckets: UsageBuckets;
    cost: CostBreakdown | null;
    /** 该轮**最后一步**（窗口占用口径） */
    last: StepView;
    /** 缺金额快照的步数（>0 表示合计不完整，UI 要标注） */
    unpriced: number;
}

export function groupByTurn(steps: StepUsageRecord[]): TurnGroup[] {
    const map = new Map<string, StepView[]>();
    for (const r of steps) {
        const arr = map.get(r.turnId) ?? [];
        arr.push(stepView(r));
        map.set(r.turnId, arr);
    }
    return [...map.entries()].map(([turnId, views]) => {
        const sorted = [...views].sort((a, b) => a.record.step - b.record.step);
        const priced = sorted.filter((v) => v.cost != null).map((v) => v.cost!);
        return {
            turnId,
            steps: sorted,
            buckets: sumBuckets(sorted.map((v) => v.buckets)),
            cost: priced.length ? sumCosts(priced) : null,
            last: sorted[sorted.length - 1]!,
            unpriced: sorted.length - priced.length,
        };
    });
}

/** 按「人物 + 模型 + 面 + 档位」分行（同一会话可换模型/换面 → 一行一个身份，##211 §六b.6） */
export interface AgentGroup {
    persona: string;
    // 注意：不带 model/apiFace/reasoningEffort —— 分组内各步可能不同（见 keyOfGroup 头注）
    stepCount: number;
    buckets: UsageBuckets;
    cost: CostBreakdown | null;
    unpriced: number;
    /** 单价依据：出现过的**上下文档**集合（如 ["base"] 或 ["base","input>272000"]） */
    tiers: string[];
    /** 单价依据：出现过的**时段档**集合（如 ["peak"] / ["off-peak"]）；无时段价 → 空 */
    windows: string[];
}

/**
 * 分组键 = 人物（唯一跨步稳定的维度）。
 * 模型 / 面 / 档位是**步级**属性：同一轮的多个 step 可能换模型（实测：mimo 的请求被上游
 * 路由到 gpt-6-luna；切人物、子 agent 也换）——拿它们当分组键会把同一个人物拆成多行，
 * 看板反而看不出「谁花了多少」（2026-10-03 用户纠正：这是错误的 group by）。
 * 需要步级身份时看 L3 轮明细（每行一步，模型/面/档位如实展示）。
 */
const keyOfGroup = (r: StepUsageRecord): string => r.persona ?? "—";

export function groupByAgent(steps: StepUsageRecord[]): AgentGroup[] {
    const map = new Map<string, StepView[]>();
    for (const r of steps) {
        const k = keyOfGroup(r);
        const arr = map.get(k) ?? [];
        arr.push(stepView(r));
        map.set(k, arr);
    }
    return [...map.values()].map((views) => {
        const r0 = views[0]!.record;
        const priced = views.filter((v) => v.cost != null).map((v) => v.cost!);
        const tiers = [...new Set(views.map((v) => v.record.rates?.tier).filter((t): t is string => !!t))];
        const windows = [...new Set(views.map((v) => v.record.rates?.window).filter((t): t is string => !!t))];
        return {
            persona: r0.persona ?? "—",
            stepCount: views.length,
            buckets: sumBuckets(views.map((v) => v.buckets)),
            cost: priced.length ? sumCosts(priced) : null,
            unpriced: views.length - priced.length,
            tiers,
            windows,
        };
    });
}
