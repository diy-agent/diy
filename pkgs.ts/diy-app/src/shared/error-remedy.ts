/**
 * error-remedy.ts — 「这个错该去哪修」的**唯一判据**（##407；纯函数、零 IO、零网络）。
 *
 * ── 为什么要有这一份、为什么必须静态 ──
 *   `error-triage.ts`（##394）只回答「这是哪一档」；`model-unavailable.ts`（##369）只回答
 *   「这个模型能不能用」。而用户真正卡住的那一问是「**我现在该点哪里**」——
 *   尤其在认证失败 / 模型不可用 / 配额限流时：**agent 本身已经不能干活**（LLM 不可用），
 *   用户没法让 agent 帮他改配置。所以引导必须**纯静态、自足、不进 LLM**：
 *   判据（本文件）+ 目标页锚点 + 静态的可用模型清单，不请求任何模型、不依赖网络。
 *
 * ── 与 ##391 / ##394 的分工（同一族，别各写一套）──
 *   · 判据归这张表（`remedyOf`），**文案也在表里**（但只在 shared，渲染层不拼句子）；
 *   · 二级信息（来源 / 原因 / 机制）仍归 `renderer_solid/lib/notice.ts` 的 `NoticeMeta`；
 *   · **拿不到映射 ⇒ 返回 null，不给按钮** —— 与 ##394「不猜」同一原则：
 *     造一个假入口比没有入口更糟（用户点进去发现无处可改，就不再信任何提示）。
 *
 * ── target 的形状 ──
 *   `{ page: "models", anchor }` —— 目前只有模型配置页（设置 → 模型）。`anchor` 是页内
 *   `data-focus-target` 的值：`provider-std-<key>` / `provider-custom-<key>` / `models-pick`。
 *   渲染侧只按属性值匹配，不认识业务语义（依赖倒置：本文件不需要知道 Solid / 组件结构）。
 */

import { FREE_MODEL_CANDIDATES, FREE_MODEL_CHECKED_AT, FALLBACK_MODEL } from "./model-default";
import type { ModelUnavailableKind } from "./model-unavailable";

// ═══════════════════════════════════════════════
//  形状
// ═══════════════════════════════════════════════

/** 引导目标页：目前只有模型配置页（设置 → 模型） */
export type RemedyPage = "models";

export interface RemedyTarget {
    page: RemedyPage;
    /** 页内锚点（= 目标元素的 `data-focus-target`） */
    anchor: string;
}

export interface Remedy {
    /** 按钮文案（一级入口上直接可读，如「去配密钥」） */
    label: string;
    /** 去哪 */
    target: RemedyTarget;
    /**
     * 引导卡正文（自足：**改哪个字段 / 填什么 / 为什么不能自动改**）。
     * 多行文本，渲染层原样 `whitespace-pre-wrap` —— 不在这里拼 HTML，也不在渲染层拼句子。
     */
    hint: string;
}

/** 判定修复动作时能拿到的**事实**（都可缺：错误链上形状不止一种） */
export interface RemedyContext {
    /** provider 段（std = models.dev id；custom = `custom:<key>`），拿不到 = null/缺省 */
    provider?: string | null;
    /** 模型 id（bar 的主角；引导卡里点名用） */
    model?: string | null;
    /** 模型不可用判据的类别（shared/model-unavailable 的 kind） */
    kind?: ModelUnavailableKind | null;
    /** 上游 HTTP 状态码（另一条独立证据） */
    httpStatus?: number | null;
}

export interface RemedyInput {
    /** 归一化 code（`error-triage.ts::triageOf` 给的那种，如 `llm/unauthorized`） */
    code?: string | null;
    /** 人读理由（进引导卡的"为什么"一句；可缺省） */
    reason?: string | null;
    ctx?: RemedyContext;
}

// ═══════════════════════════════════════════════
//  锚点 + 静态清单
// ═══════════════════════════════════════════════

/** 「换模型」的锚点：模型配置页顶部的静态引导块（不用先找到哪张卡片） */
export const ANCHOR_MODEL_PICK = "models-pick";

/**
 * provider 段 → 卡片锚点（与 ModelConfigPage 的 `data-focus-target` 一一对应）。
 * 拿不到 provider 就返回 null（调用方回落到 {@link ANCHOR_MODEL_PICK}，不编造卡片名）。
 */
export function providerAnchor(provider: string | null | undefined): string | null {
    const p = (provider ?? "").trim();
    if (!p) return null;
    if (p.startsWith("custom:")) {
        const key = p.slice("custom:".length).trim();
        return key ? `provider-custom-${key}` : null;
    }
    return `provider-std-${p}`;
}

/** 静态可用模型清单（**内置、不请求任何模型**；核对日期跟着 shared/model-default 走） */
export function staticModelChoices(): string[] {
    return [...FREE_MODEL_CANDIDATES, FALLBACK_MODEL];
}

/** 清单的一句话形态（引导卡里直接可读；带核对日期，免得把过期清单当承诺） */
export function staticModelChoicesText(): string {
    return `${staticModelChoices().join(" · ")}（内置清单，核对于 ${FREE_MODEL_CHECKED_AT}）`;
}

// ═══════════════════════════════════════════════
//  判据表（顺序即优先级；第一条命中即返回）
// ═══════════════════════════════════════════════

function targetOf(ctx: RemedyContext): RemedyTarget {
    return { page: "models", anchor: providerAnchor(ctx.provider) ?? ANCHOR_MODEL_PICK };
}

/** 引导卡公用尾句：为什么不能自动改（三条都一样的理由：这是用户的决定 + 此刻没有 LLM） */
const WHY_MANUAL = "为什么不能自动改：key / 模型都是你的配置与决定，应用不替你改；且此刻 LLM 已不可用，这条引导也不调用任何模型。";

/** 判定时的**事实视图**（ctx + 顶层两项，拍平后可逐条读） */
interface RemedyProbe extends RemedyContext {
    code: string | null;
    httpStatus: number | null;
    kind: ModelUnavailableKind | null;
}

interface RemedyRule {
    /** 命中判据（表驱动：加一类只加一行） */
    test: (p: RemedyProbe) => boolean;
    build: (i: { code: string | null; reason: string; ctx: RemedyContext }) => Remedy;
}

const RULES: readonly RemedyRule[] = [
    {
        // 认证失败：401 / 403 —— 唯一的动作是「去把那把 key 配好」
        test: (c) =>
            c.kind === "auth" ||
            c.httpStatus === 401 ||
            c.httpStatus === 403 ||
            c.code === "llm/unauthorized" ||
            c.code === "llm/forbidden",
        build: ({ reason, ctx }) => ({
            label: "去配 provider 密钥",
            target: targetOf(ctx),
            hint: [
                "改哪个字段：模型配置页里对应 provider 卡片的「密钥」输入框（model.yaml 的 accounts[0].value）。",
                "填什么：该 provider 的有效 API key；也可以写 $ENV 名，把 key 放进环境变量（页面会提示哪个变量名）。",
                reason ? `为什么是这条：${reason}` : "",
                WHY_MANUAL,
            ]
                .filter(Boolean)
                .join("\n"),
        }),
    },
    {
        // 配额 / 限流：等额度，或换一个模型（换模型比等更可操作）
        test: (c) => c.kind === "quota" || c.httpStatus === 429 || c.code === "llm/rate-limited",
        build: ({ reason, ctx }) => ({
            label: "换一个可用模型",
            target: targetOf(ctx),
            hint: [
                "改哪个字段：会话左侧「人物」抽屉里的「模型」下拉（模型本身由人物持有，不在这张卡片上）。",
                `填什么：优先 free 模型 —— ${staticModelChoicesText()}；也可以等额度/限流窗口过去后原样重试。`,
                reason ? `为什么是这条：${reason}` : "",
                "为什么不能自动改：换模型还是等额度，是你的决定（引导只负责把你送到该点的地方）。",
            ]
                .filter(Boolean)
                .join("\n"),
        }),
    },
    {
        // 模型本身不可用（未上架 / id 不认识）—— 只能换模型
        test: (c) => c.kind === "coming-soon" || c.kind === "unknown-model",
        build: ({ reason, ctx }) => ({
            label: "换一个可用模型",
            target: { page: "models", anchor: ANCHOR_MODEL_PICK },
            hint: [
                `改哪个字段：会话左侧「人物」抽屉里的「模型」下拉${ctx.model ? `（当前失败的是 ${ctx.model}）` : ""}。`,
                `填什么：从内置清单里选一个 —— ${staticModelChoicesText()}。`,
                reason ? `为什么是这条：${reason}` : "",
                "为什么不能自动改：换哪个模型是你的决定；这份清单是内置静态的，不请求任何模型。",
            ]
                .filter(Boolean)
                .join("\n"),
        }),
    },
];

/**
 * 判「这个错该去哪修」。
 *
 * - 命中判据表 → `{ label, target, hint }`；表里没有 → **null（不给按钮）**。
 * - 纯函数：不碰 fs / 网络 / Date；表驱动单测见 `tests/core/error-remedy.test.ts`。
 */
export function remedyOf(input: RemedyInput): Remedy | null {
    const ctx: RemedyContext = input.ctx ?? {};
    const code = input.code?.trim() ? input.code.trim() : null;
    const reason = (input.reason ?? "").trim();
    const httpStatus = ctx.httpStatus ?? null;
    const probe: RemedyProbe = { ...ctx, code, httpStatus, kind: ctx.kind ?? null };
    for (const rule of RULES) {
        if (rule.test(probe)) return rule.build({ code, reason, ctx });
    }
    return null;
}
