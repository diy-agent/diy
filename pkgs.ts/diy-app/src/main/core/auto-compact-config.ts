// src/main/core/auto-compact-config.ts
// 🎯 自动压缩配置的**文件层**：$DIY_HOME/auto-compact.yaml 的读写。
//
// 分层同 core/context-config.ts：契约与归一在 shared/context/auto-compact.ts（纯函数、可单测），
// 本文件只做文件 I/O（existsSync → yaml.load → safeParse **当探测器** → 宽松归一 → 出声回落 → 原子写）。
//
// 【##370】读侧不许"一失败就整份回默认"：缺键/类型错走 `normalizeAutoCompact` 逐键兜底，
//   改过哪里由 `AutoCompactIssue` 出声（`loadAutoCompactDetailed`）—— 只在应用日志里说 = 没说。
//
// 为什么不放面板 localStorage（用户 2026-10-06 要"配置项"）：localStorage 是**有损**且
// serve 与 Electron 各持一份（见 pit.localstorage）；而"要不要自动压"会**改用户的会话历史**，
// 必须是真源、可版本管理、可手改。

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic-write";
import * as yaml from "js-yaml";
import {
    AutoCompactConfigSchema,
    DEFAULT_AUTO_COMPACT,
    autoCompactIssuesFromZod,
    needsWindowRatioMigration,
    normalizeAutoCompact,
    type AutoCompactConfig,
    type AutoCompactIssue,
} from "../../shared/context/auto-compact";
import { MIN_HISTORY_LIMIT_TOKENS } from "../../shared/context/history-limit";

export function autoCompactFile(home: string): string {
    return join(home, "auto-compact.yaml");
}

/**
 * 读配置的**详细结果**（##370）：配置本身 + **出声条目**。
 *
 * `issues` 空 = 干净读入（含"文件不存在 ⇒ 缺省"这种**正常态** —— 那不是问题）。
 */
export interface AutoCompactLoadResult {
    config: AutoCompactConfig;
    /** 出声条目：文件坏 / 必填键缺 / 值被归一（每条都带「已回落成什么」） */
    issues: AutoCompactIssue[];
}

/**
 * 读自动压缩配置（**带出声**）。三态：
 *   · 文件不存在 → 缺省（notify），**不算问题**（issues 为空）；
 *   · YAML 语法坏 → 整份缺省 + 出声（这条口径**保留**：语法坏 = 没得救，也绝不用坏数据）；
 *   · YAML 能读但**结构不符**（缺必填键 / 类型错）→ **逐键宽松归一**（缺的补缺省、保留用户写对的部分）
 *     + 出声报「哪一层缺什么、回落成什么」。
 *
 * 第三态是本任务（##370）改的：旧行为是 `safeParse` 一失败就 `return DEFAULT_AUTO_COMPACT` ——
 * 用户只写漏 `policy.summary` 一个键，整份配置（含精心写的 `history.keep[]`）就没了，
 * 而 `PlanView.raw` 仍是原文、`source` 已是 `default`：**看得见原文、看不见因**。
 * 而 `normalizeAutoCompact` 本就是为「缺字段/越界」写的宽松归一，旧代码把它挡在严格校验**之后**
 * ⇒ 缺键场景**永远跑不到**（等于死代码）。现在：严格 schema 只当**探测器**（它才说得出"缺了哪个必填键"），
 * 值走宽松归一，归一改过的地方由 `issues` 出声。
 */
export interface AutoCompactLoadOptions {
    /**
     * 当前模型窗口上限（token，`contextLimitOf(model)`）。
     * 只用于**旧 token 阈值 → 比例**的一次性折算：`>=1` 的旧值按它折算后写回。
     * 缺省 / null = 窗口未知（不做折算，本次按缺省比例判定）。
     */
    windowLimitTokens?: number | null;
}

export function loadAutoCompactDetailed(
    home: string,
    opts?: AutoCompactLoadOptions,
): AutoCompactLoadResult {
    const p = autoCompactFile(home);
    if (!existsSync(p)) return { config: DEFAULT_AUTO_COMPACT, issues: [] };
    let raw: unknown;
    try {
        raw = yaml.load(readFileSync(p, "utf-8"));
    } catch (e) {
        const message = `YAML 解析失败（${e instanceof Error ? e.message : String(e)}）；整份回落缺省`;
        console.warn(`[auto-compact] ${p} ${message}`);
        return { config: DEFAULT_AUTO_COMPACT, issues: [{ path: "", message }] };
    }
    // 旧键 `triggers.contextWindowOver` 读时改名为 `windowOverRatio` —— 先映射再做**严格探测**，
    // 否则 schema 会把「旧键存在」误报成「新键缺失」（判据④：旧比例 0.8 直接采纳、不告警）。
    const parseRaw = (() => {
        if (raw === null || typeof raw !== "object") return raw;
        const src = raw as Record<string, unknown>;
        const t = src["triggers"];
        if (t === null || typeof t !== "object") return raw;
        const tr = t as Record<string, unknown>;
        if (tr["contextWindowOver"] === undefined || tr["windowOverRatio"] !== undefined) return raw;
        return { ...src, triggers: { ...tr, windowOverRatio: tr["contextWindowOver"] } };
    })();
    const parsed = AutoCompactConfigSchema.safeParse(parseRaw);
    // 读侧也走宽松归一：单位迁移（旧比例 → token 默认）等**只在归一里做一次**，
    // 否则手改的旧配置文件会绕过迁移，被当成 token 阈值。
    const issues: AutoCompactIssue[] = [];
    const windowLimitTokens = opts?.windowLimitTokens ?? null;
    const config = normalizeAutoCompact(raw, issues, windowLimitTokens);
    // 旧 token 阈值 → 比例：**一次性**折算后写回新形状（写回失败出声，绝不静默）。
    // 窗口未知时不写（还没有折算结果，留着下次读到窗口再迁）。
    if (
        needsWindowRatioMigration(raw) &&
        typeof windowLimitTokens === "number" &&
        Number.isFinite(windowLimitTokens) &&
        windowLimitTokens > 0
    ) {
        try {
            saveAutoCompact(home, config);
        } catch (e) {
            const message =
                `旧窗口阈值折算后写回失败（${e instanceof Error ? e.message : String(e)}）；` +
                `本次仍按 windowOverRatio=${config.triggers.windowOverRatio} 判定`;
            console.warn(`[auto-compact] ${p} ${message}`);
            issues.push({ path: "triggers.windowOverRatio", message });
        }
    }
    if (!parsed.success) {
        // zod 的问题排在前面（缺键/类型错是"更硬"的原因，归一的出声随后）
        issues.unshift(...autoCompactIssuesFromZod(parsed.error, config));
        console.warn(
            `[auto-compact] ${p} 结构不符（${parsed.error.issues.map((i) => i.path.join(".") || "（根）").join("，")}），` +
                `已逐键回落缺省（详见 UI 压缩 tab 的出声）`,
        );
    }
    return { config, issues };
}

/** 读自动压缩配置（只要配置本身；要「为什么」用 `loadAutoCompactDetailed`） */
export function loadAutoCompact(home: string, opts?: AutoCompactLoadOptions): AutoCompactConfig {
    return loadAutoCompactDetailed(home, opts).config;
}

/**
 * 读自动压缩配置的**原始全文**（`$DIY_HOME/auto-compact.yaml`，含注释）—— 供 UI「原始配置」
 * 只读视图（用户 2026-10-07：「我希望 app 能尽量有显示原始数据的能力」）。缺失 → 空串。
 */
export function readAutoCompactText(home: string): string {
    const p = autoCompactFile(home);
    try {
        return existsSync(p) ? readFileSync(p, "utf-8") : "";
    } catch (e) {
        console.warn(`[auto-compact] ${p} 读取失败:`, e);
        return "";
    }
}

/** 写自动压缩配置（原子：tmp → rename）。宽松归一后再写（不存坏数据）。 */
export function saveAutoCompact(
    home: string,
    cfg: unknown,
    opts?: AutoCompactLoadOptions,
): AutoCompactConfig {
    const norm = normalizeAutoCompact(cfg, undefined, opts?.windowLimitTokens ?? null);
    const p = autoCompactFile(home);
    mkdirSync(dirname(p), { recursive: true });
    const header =
        "# 自动压缩配置 —— 唯一真源（手改或经 UI 写回；下一轮真发生效）\n" +
        "#\n" +
        "# 没有 mode（##442，用户 2026-10-26）：**到点就压**，不再有 off/notify/auto 三态。\n" +
        "#   ⚠️ 自动压缩不是「裁不裁」：投递**始终**按 history.limit 切；压缩只改切点边界。\n" +
        "# triggers: 三个都是**可判定的确定事实**（不是「划不划算」的预测）\n" +
        "#   systemContextChanged 系统上下文变了 → 前缀缓存必作废，此刻压缩零重建代价\n" +
        "#   cacheExpired         缓存已过期（距上次请求 > 生效 TTL）→ 冷启动，压缩是白赚\n" +
        "#   windowOverRatio      上下文窗口占用**比例**（0~1，缺省 0.5）：\n" +
        "#                        最后一步实测用量 >= 模型窗口 contextLimit × 本值 ⇒ 压；0 = 关闭；\n" +
        "#                        窗口上限取不到 ⇒ 不触发（不猜数）。\n" +
        "#                        旧的 token 绝对数（>=1，如 800000）读取时按窗口一次性折算并写回。\n" +
        "#\n" +
        "# history.limit.limitTokens: **唯一的历史旋钮**（token）\n" +
        "#   算法（只有这一套）：从最后一步往前累加，装得下就装、装不下就停；\n" +
        "#     · token 粗估 = CJK 1 token/字、其余 字符数/4；\n" +
        "#     · 切点必须 tool 配对平衡（不平衡就往前挪到那条 call 所在的组）；\n" +
        "#     · **保头 600 token 硬编码**（首条 user / 任务目标，不参与累加、永不被丢）；\n" +
        "#     · 一次压缩只保留到上限的 **一半**（留余量给后续步骤，否则每步都要重压）；\n" +
        "#     · 下限 " + String(MIN_HISTORY_LIMIT_TOKENS) + "（再小则「保头 + 半额」让每步都重算，会被夹上来）；\n" +
        "#     · **边界只在压缩事件时算一次**并落 turns.jsonl，之后每步只追加不重算。\n" +
        "# history.limit.summary.enabled: 对丢掉那段做摘要（缺省 false：只留一行注记 + ref 指回原文）\n" +
        "#\n" +
        "# policy.modeData.toolResult: **工具结果呈现**的真源（asis / headtail / callpath）—— 与历史选择无关\n" +
        "#\n" +
        "# 已删除（##432，2026-10-25 用户拍板）：history.keep[] 级列表（ladder/role/recent/steps + must）、\n" +
        "#   policy.modeData.budgetBytes（字节预算）、history.allowAgentWrite、plan 版本链。\n" +
        "#   写了它们会被读侧忽略并出声；旧 budgetBytes 会**一次性**折算成 limitTokens（bytes/4）后写回新形状。\n" +
        "# 契约：pkgs.ts/diy-app/src/shared/context/auto-compact.ts 的 AutoCompactConfigSchema\n";
    writeFileAtomic(p, header + yaml.dump(norm, { indent: 2, noRefs: true }));
    return norm;
}
