// src/shared/context/compact-keep.ts
// 🎯 压缩装配管道的**配置面**：`auto-compact.yaml` 的 `history.keep[]`（级列表）的
//    契约 + 校验 + 回显（纯函数，禁止 import node:*）
//
// ── 为什么要有这一层（##344 M2）──
// ##343 M1 把「留什么 / 怎么裁」做成了**能力**（每级可声明 `clip`），但那条管道**写死在代码里**
// （`defaultBudgetPlan()`）—— 用户改不了、agent 生成不了、事后回放不了。M2 把 plan 升级成**数据**：
// 存 `history.keep[]`、可校验、可快照。于是「谁来留什么」变成一次**可 diff、可 review、可回滚的编辑**。
//
// ── 形状（遵 `rule.discriminated-union`）──
//   级 = `{ type, must?, limit?, clip?, data }`
//     · `type`  = **取法**（判别的**键**；对应 `compaction-plan.ts` 的 Picker 元件）
//     · 与 `type` 同级 = 每支都有的**公共**字段：`must`（必保、不占预算）/ `limit`（最多几个单元）/ `clip`（本级取中的消息怎么裁）
//     · `data`  = 该取法**私有**的参数（换 type 就换一整包）
//   `clip` 自带判别键（`full | path | headtail`，见 compaction.ts 的 ClipSpecSchema）—— 嵌套同构。
//
// ── 规格真源 ──
// `docs/plans/2026-10-08-compact-plan-config.md` §③/§④（用户 2026-10-08 定稿的存储原文）。
// ⚠️ 该规格里 `type` 是**取法**、`must` 是公共字段（不是 `type: exempt`）——本文件按规格实现。

import { z } from "zod";
import { ClipSpecSchema } from "./compaction";

/** 取法能筛的消息角色（`tool` = 工具结果；工具**调用**属于 assistant 消息） */
export const KeepRoleSchema = z.enum(["user", "assistant", "tool"]);
export type KeepRole = z.infer<typeof KeepRoleSchema>;

/** 每支都有的公共字段（与 `type` 同级；私有数据一律进 `data`） */
const common = {
    /** 必保：**不占预算**（`exempt` 级）。缺省 false = 计预算（`count` 级） */
    must: z.boolean().optional().describe("必保：不占预算（预算不足也不丢）"),
    /** 本级最多取几个**单元**（单元 = tool-call 与它的 result 算一个）；缺省不限 */
    limit: z.number().int().nonnegative().optional().describe("最多取几个单元（call+result=1）；缺省不限"),
    /** 本级取中的消息**怎么裁**；缺省 = 不声明 ⇒ 回落策略的全局 clip（`policy.modeData.toolResult`） */
    clip: ClipSpecSchema.optional().describe("本级取中的消息怎么裁；缺省回落全局策略"),
};

/**
 * 一级 = 一条**取法**声明。数组序 = 优先级序（**先声明的先挑**）；
 * 一条消息被多级选中时，**先选中它的那一级的 `clip` 生效**（先到先得，见 runPlan）。
 */
export const KeepStageSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("ladder").describe("纵向阶梯：用户 > 结论 > 过程 > 命令 > 结果，同层新的先（缺省兜底取法）"),
        ...common,
    }),
    z.object({
        type: z.literal("role").describe("某角色的**全部**消息（新的先）"),
        ...common,
        data: z.object({ role: KeepRoleSchema.describe("要保留的角色") }).describe("role 私有参数（只此支有）"),
    }),
    z.object({
        type: z.literal("recent").describe("最近 N 条消息（可选按角色过滤）"),
        ...common,
        data: z
            .object({
                n: z.number().int().positive().describe("最近的条数"),
                role: KeepRoleSchema.optional().describe("只取该角色；缺省不限"),
            })
            .describe("recent 私有参数（只此支有）"),
    }),
    z.object({
        type: z.literal("steps").describe("最近 N 个**步骤**的全部消息（新的步先；工作集）"),
        ...common,
        data: z.object({ n: z.number().int().positive().describe("最近的步数") }).describe("steps 私有参数（只此支有）"),
    }),
]);
export type KeepStage = z.infer<typeof KeepStageSchema>;
export type KeepStageType = KeepStage["type"];

/** 已实现的取法名（校验用；`summary` 等**留口**不在此列 ⇒ 报「尚未启用」而非「未知」） */
export const KEEP_STAGE_TYPES: readonly KeepStageType[] = ["ladder", "role", "recent", "steps"];

/** 已列入规格但**尚未启用**的取法（报错时区分「写错名」与「还没做」） */
export const KEEP_STAGE_TYPES_RESERVED: readonly string[] = ["summary"];

/** 「保底最近 N 步全量」的 N（用户 2026-10-15 定：**6 步全量**）—— 缺省 plan 的步数 */
export const DEFAULT_EXEMPT_STEPS = 6;

/**
 * **缺省 plan**（= `##343 M1` 的 `defaultBudgetPlan`，现以**数据**表达）——
 * ① 最近 6 步必保且 `clip: full`（字节保真：迷路的病灶是「留下的工具结果被裁成头尾」）；
 * ② 其余按纵向阶梯计预算、用全局 clip 裁。
 *
 * 单一真源：`compaction-plan.ts` 的 `defaultBudgetPlan()` 由它生成（代码与「配置面回显」不会分叉）。
 */
export const DEFAULT_KEEP: readonly KeepStage[] = [
    { type: "steps", must: true, clip: { type: "full" }, data: { n: DEFAULT_EXEMPT_STEPS } },
    { type: "ladder" },
];

/**
 * 「必保层撑爆硬上限」的**兜底上限**（字节）：`must` 级不占预算，理论上可以无限撑 ——
 * 上线前 `plan check` 要能量出来并拦住（超了就是「压缩等于没压，还白付重建代价」）。
 *
 * 值取 **1 MiB**：只在**拿不到模型上下文窗口**时用它（有窗口就用 `窗口 token × 4`；
 * 无 tokenizer 时按字节/4 的同一粗估口径，见 compaction.ts 的 `estimateTokens`）。
 */
export const DEFAULT_MUST_HARD_CAP_BYTES = 1024 * 1024;

/** 校验问题（`check` 的判据；level=error 即拒绝 —— 配置照旧、不落盘） */
export interface KeepIssue {
    level: "error" | "warn";
    code: string;
    message: string;
    /** 出错级的下标（0 起）；跨级问题（如整体形状）不填 */
    index?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * 宽松校验（**手写**而不是直接 zod.parse —— 要给人读的定位信息，且要区分「未知取法 / 保留字 / 参数错」）。
 * 返回 `stages`（无 error 时才有值）与 `issues`。
 *
 * 为什么校验必须发生在**写盘前**：`keep` 决定「哪些历史会发给模型」，写坏了就是静默丢上下文；
 * 而**读**（投递）侧另有宽松回落（见 compaction-plan.ts::keepStagesToPlan）—— 两面都硬就是自锁。
 */
export function validateKeepStages(raw: unknown): { stages: KeepStage[]; issues: KeepIssue[] } {
    const issues: KeepIssue[] = [];
    const stages: KeepStage[] = [];
    if (raw === undefined || raw === null) return { stages, issues };
    if (!Array.isArray(raw)) {
        return { stages, issues: [{ level: "error", code: "keep.notArray", message: "keep 必须是**级列表**（数组）" }] };
    }

    const seen = new Map<string, number>();
    raw.forEach((entry, i) => {
        const at = (m: string): KeepIssue => ({ level: "error", code: "keep.stage", message: `第 ${i + 1} 级：${m}`, index: i });
        if (!isObj(entry)) {
            issues.push(at("必须是对象（`{ type, must?, limit?, clip?, data }`）"));
            return;
        }
        const t = entry["type"];
        if (typeof t !== "string") {
            issues.push(at("缺 `type`（取法名）"));
            return;
        }
        if (KEEP_STAGE_TYPES_RESERVED.includes(t)) {
            issues.push(at(`取法 \`${t}\` 尚未启用（规格留口；见 ##282 M3 / ##273 P4）`));
            return;
        }
        if (!(KEEP_STAGE_TYPES as readonly string[]).includes(t)) {
            issues.push(at(`未知取法 \`${t}\`；可用：${KEEP_STAGE_TYPES.join(" / ")}`));
            return;
        }
        // 公共字段
        if (entry["must"] !== undefined && typeof entry["must"] !== "boolean") issues.push(at("`must` 必须是布尔"));
        const limit = entry["limit"];
        if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 0)) issues.push(at("`limit` 必须是非负整数"));
        if (entry["clip"] !== undefined) {
            const c = ClipSpecSchema.safeParse(entry["clip"]);
            if (!c.success) issues.push(at(`\`clip\` 形状不合法：${c.error.issues.map((x) => `${x.path.join(".") || "(根)"} ${x.message}`).join("；")}`));
        }
        // 每支私有数据
        const d = entry["data"];
        const key = t;
        if (seen.has(key)) {
            issues.push({ level: "warn", code: "keep.duplicate", message: `第 ${i + 1} 级与第 ${seen.get(key)! + 1} 级取法相同（\`${t}\`）—— 后面的级可能什么都挑不到`, index: i });
        } else {
            seen.set(key, i);
        }
        if (t === "ladder") {
            if (d !== undefined && isObj(d) && Object.keys(d).length > 0) issues.push(at("`ladder` 没有私有参数（不该有 `data`）"));
        } else if (t === "role") {
            if (!isObj(d) || !KeepRoleSchema.safeParse(d["role"]).success) issues.push(at("`role` 需要 `data.role`（user / assistant / tool）"));
        } else if (t === "recent") {
            if (!isObj(d) || !Number.isInteger(d["n"]) || (d["n"] as number) < 1) issues.push(at("`recent` 需要 `data.n`（正整数）"));
            else if (d["role"] !== undefined && !KeepRoleSchema.safeParse(d["role"]).success) issues.push(at("`recent` 的 `data.role` 只能是 user / assistant / tool"));
        } else if (t === "steps") {
            if (!isObj(d) || !Number.isInteger(d["n"]) || (d["n"] as number) < 1) issues.push(at("`steps` 需要 `data.n`（正整数）"));
        }
        // 通过单级校验 → 用 zod 收尾（拿到规范化对象；zod 报错理论上不会到这）
        const parsed = KeepStageSchema.safeParse(entry);
        if (parsed.success) stages.push(parsed.data);
        else issues.push(at(parsed.error.issues.map((x) => `${x.path.join(".") || "(根)"} ${x.message}`).join("；")));
    });

    if (!issues.some((x) => x.level === "error")) {
        // 全 must ⇒ 预算永不生效（用户多半不是这个意思）—— 只提醒，不拒绝
        if (stages.length > 0 && stages.every((s) => s.must === true)) {
            issues.push({ level: "warn", code: "keep.allMust", message: "每一级都是 `must`（必保、不占预算）⇒ 预算不会生效（等于不限量投递）" });
        }
    }
    return { stages: issues.some((x) => x.level === "error") ? [] : stages, issues };
}

/** 单级 → 人读短名（CLI 表格 / UI 徽标用；一处文案，不许两处各写） */
export function keepStageLabel(s: KeepStage): string {
    switch (s.type) {
        case "ladder":
            return "纵向阶梯";
        case "role":
            return `所有 ${s.data.role} 消息`;
        case "recent":
            return s.data.role ? `最近 ${s.data.n} 条 ${s.data.role}` : `最近 ${s.data.n} 条消息`;
        case "steps":
            return `最近 ${s.data.n} 步`;
    }
}

/** clip → 人读短名 */
export function clipLabel(clip: z.infer<typeof ClipSpecSchema> | undefined | null): string {
    if (!clip) return "回落全局";
    if (clip.type === "full") return "全量（不裁）";
    if (clip.type === "path") return "只留调用+路径";
    return `头尾 ${clip.data.head}/${clip.data.tail}`;
}
