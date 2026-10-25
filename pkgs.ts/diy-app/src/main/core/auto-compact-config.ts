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
    normalizeAutoCompact,
    type AutoCompactConfig,
    type AutoCompactIssue,
} from "../../shared/context/auto-compact";
import { validateKeepStages, type KeepIssue, type KeepStage } from "../../shared/context/compact-keep";

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
export function loadAutoCompactDetailed(home: string): AutoCompactLoadResult {
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
    const parsed = AutoCompactConfigSchema.safeParse(raw);
    // 读侧也走宽松归一：单位迁移（旧比例 → token 默认）等**只在归一里做一次**，
    // 否则手改的旧配置文件会绕过迁移，被当成 token 阈值。
    const issues: AutoCompactIssue[] = [];
    const config = normalizeAutoCompact(raw, issues);
    if (!parsed.success) {
        // zod 的问题排在前面（缺键/类型错是"更硬"的原因，归一的出声随后）
        issues.unshift(...autoCompactIssuesFromZod(parsed.error, config));
        console.warn(
            `[auto-compact] ${p} 结构不符（${parsed.error.issues.map((i) => i.path.join(".") || "（根）").join("，")}），` +
                `已逐键回落缺省（详见「compact plan get」/ UI 的出声）`,
        );
    }
    return { config, issues };
}

/** 读自动压缩配置（只要配置本身；要「为什么」用 `loadAutoCompactDetailed`） */
export function loadAutoCompact(home: string): AutoCompactConfig {
    return loadAutoCompactDetailed(home).config;
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

/**
 * 解析 plan 文本（YAML 或 JSON）→ 待校验的原始值。
 *
 * 接受两种写法（都是人/agent 自然会写出来的）：**级列表数组**，或 `{ keep: [...] }`
 * （后者可直接从 `auto-compact.yaml` 里粘一段过来，零改写）。形状是否合法由 `validateKeepStages` 判 ——
 * 这里只负责「把文本变成值」，不做任何猜测性修复（猜错了就是静默丢上下文）。
 */
export function parseKeepText(text: string): unknown {
    const src = text.trim();
    if (src === "") throw new Error("plan 文本为空（要给级列表数组，或 `{ keep: [...] }`）");
    let v: unknown;
    try {
        v = yaml.load(src);
    } catch (e) {
        throw new Error(`plan 文本解析失败（YAML/JSON）：${e instanceof Error ? e.message : String(e)}`);
    }
    if (v === null || typeof v !== "object") throw new Error("plan 文本不是级列表（应为数组，或 `{ keep: [...] }`）");
    if (Array.isArray(v)) return v;
    const keep = (v as Record<string, unknown>)["keep"];
    if (keep === undefined) throw new Error("plan 文本既不是数组、也没有 `keep` 字段");
    return keep;
}

/**
 * 写 `history.keep[]`（**校验后才落地**）—— `compact plan set` 与 UI 级列表编辑器的**唯一写入口**。
 * 非法 ⇒ 抛错且**不改文件**：写好 plan 就是决定「哪些历史发给模型」，静默写坏等于静默丢上下文。
 * （读侧是另一回事：坏 `keep` 只丢 `history`、回落缺省管道，见 normalizeHistory —— 两面都硬就是自锁。）
 */
export function saveKeepConfig(home: string, rawKeep: unknown): { keep: KeepStage[]; issues: KeepIssue[] } {
    const { stages, issues } = validateKeepStages(rawKeep);
    const errors = issues.filter((i) => i.level === "error");
    if (errors.length > 0) {
        throw new Error(`plan 非法，已拒绝写入（配置未改动）：\n${errors.map((e) => `· ${e.message}`).join("\n")}`);
    }
    if (stages.length === 0) {
        throw new Error("keep 不能是空级列表（要清零请把预算 `policy.modeData.budgetBytes` 设为 0）");
    }
    // ⚠️ 必须**保留 history 的其余字段**（`allowAgentWrite` 等）：整包换成 `{ keep }` 会顺手把闸关掉
    // —— 那意味着「agent 写一次 set 就自动失去写权限」，闸等于一次性；##362 M3a 实测复现过。
    const cur = loadAutoCompact(home);
    saveAutoCompact(home, { ...cur, history: { ...(cur.history ?? {}), keep: stages } });
    return { keep: stages, issues };
}

/**
 * 删除 `history.keep[]` —— **回到「未配置」状态**（= 回落出厂缺省管道）。`compact plan reset` 的写入口。
 *
 * 与 `saveKeepConfig` 的差别就是**删键 vs 写值**：写死缺省的字面量会把配置**冻结**在当时那一版缺省
 * （将来缺省演进它不跟随）；删键则永远回落到**当前**缺省（`DEFAULT_KEEP` / `defaultBudgetPlan`）。
 * ⚠️ 只删 `keep`，**保留 `history` 其余字段**（`allowAgentWrite`）—— 与 `saveKeepConfig` 同一条教训
 * （##362 实测过：整包换成 `{ keep }` 会顺手把闸关掉）。
 */
export function deleteKeepConfig(home: string): void {
    const cur = loadAutoCompact(home);
    const h = cur.history ?? {};
    const rest: { allowAgentWrite?: boolean } = {};
    if (h.allowAgentWrite !== undefined) rest.allowAgentWrite = h.allowAgentWrite;
    // 不带 `keep`：`normalizeAutoCompact` 会把 `keep` 缺席视为「回落缺省管道」；
    // 若连 `allowAgentWrite` 都没有，`history` 会整个缺席 —— 正是「未配置」的样子。
    saveAutoCompact(home, { ...cur, history: rest });
}

/** 写自动压缩配置（原子：tmp → rename）。宽松归一后再写（不存坏数据）。 */
export function saveAutoCompact(home: string, cfg: unknown): AutoCompactConfig {
    const norm = normalizeAutoCompact(cfg);
    const p = autoCompactFile(home);
    mkdirSync(dirname(p), { recursive: true });
    const header =
        "# 自动压缩配置 —— 唯一真源（手改或经 UI 写回；下一轮真发生效）\n" +
        "# mode: off 不检测 / notify 检测并提示（默认）/ auto 检测到就压\n" +
        "# triggers: 三个都是**可判定的确定事实**（不是「划不划算」的预测）\n" +
        "#   systemContextChanged 系统上下文变了 → 前缀缓存必作废，此刻压缩零重建代价\n" +
        "#   cacheExpired         缓存已过期（距上次请求 > 生效 TTL）→ 冷启动，压缩是白赚\n" +
        "#   contextWindowOver    上下文窗口占用上限（**token 数**，= 该会话最后一步实测用量；0 = 关闭）\n" +
        "# policy: 压缩策略（自动与手动**同一套**）。\n" +
        "#   mode: budget 目标式预算（现役；只有这一种算法）\n" +
        "#   modeData: **只属于该 mode** 的私有参数（换 mode 就换一整包；与 mode 同级的 summary 才是所有算法共有）\n" +
        "#     · budget：budgetBytes 历史字节上限（0=清零）· toolResult 工具结果呈现\n" +
        "#         toolResult.render: asis 原样 / headtail 头尾裁剪（私有参数在 renderData）/ callpath 只留调用\n" +
        "# history: **历史预算**（##432 刀 2：唯一旋钮）\n" +
        "#   limit.limitTokens: 单条 token 上限（字符数 / 4 粗估）—— 从最后一步往前累加，装得下就装、装不下就停；\n" +
        "#     切点必须 tool 配对平衡（不平衡往前挪）；**保头 600 token 硬编码**（不参与累加、永不被丢）\n" +
        "#   limit.summary.enabled: 对丢掉那段做摘要（v1 缺省 false：只留一行注记 + ref 指回原文）\n" +
        "#   口径：**边界只在压缩事件时算一次**并落 turns.jsonl（compaction entry），之后每步只追加不重算\n" +
        "#   ⚠️ 旧字段 `history.keep[]`（ladder/role/recent/steps + must）与 `policy.modeData.budgetBytes`\n" +
        "#      **已不决定投递**（只为旧调用点保留形状；删除待后续 PR）—— 改它们不会改变发给模型的历史。\n" +
        "#   allowAgentWrite: 允许本地 agent 经 compact_plan 工具改写 plan（缺省 false = 只读；##362 M3a）\n" +
        "# 契约：pkgs.ts/diy-app/src/shared/context/auto-compact.ts 的 AutoCompactConfigSchema\n";
    writeFileAtomic(p, header + yaml.dump(norm, { indent: 2, noRefs: true }));
    return norm;
}
