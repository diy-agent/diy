// src/main/services/compact-plan-service.ts
// 🎯 装配管道（plan）的**判据组装**：`compact plan check` 的纯逻辑（##344 M2）
//
// 为什么把这段从 api-impl 里抽出来：判据里有「must 层实占字节」这一项 —— 它**必须量**（预算是管不到
// must 的，只有实算才知道会不会撑爆），而"量"要读会话（I/O）。于是这里只做**判据组装**，测量由调用方
// **注入**：api-impl 注入真测量（`LocalAgent.measureMustStages`），单测注入假的 —— 判据本身可确定性测。

import { fmtBytes } from "../../shared/context/compaction";
import { validateKeepStages, type KeepIssue, type KeepStage } from "../../shared/context/compact-keep";

export interface PlanMustFootprint {
    mustBytes: number;
    hardCapBytes: number;
    over: boolean;
}

export interface PlanCheckReport {
    ok: boolean;
    /** 被校验的 plan 从哪来：`config` = 盘上配置（或显式传入的文本）/ `default` = 缺省回落 */
    source: "config" | "default";
    budgetBytes: number;
    /** 校验通过的级列表（有 error 时为空 —— 别让人拿半截 plan 去用） */
    keep: KeepStage[];
    issues: KeepIssue[];
    /** must 层实占字节（无 must 级 / 未测量时缺省） */
    must?: PlanMustFootprint;
}

/**
 * 组装校验报告。
 * `measure` 缺省 ⇒ 跳过「must 层撑爆硬上限」这一项（只做静态校验）。
 */
export function checkKeep(args: {
    rawKeep: unknown;
    source: "config" | "default";
    budgetBytes: number;
    measure?: (keep: KeepStage[]) => { mustBytes: number; hardCapBytes: number };
}): PlanCheckReport {
    const { stages, issues } = validateKeepStages(args.rawKeep);
    let must: PlanMustFootprint | undefined;
    // 只有**存在 must 级**时才量：没有必保级就谈不上「必保层撑爆硬上限」（也不白读一遍会话）
    if (args.measure && stages.some((s) => s.must === true)) {
        const m = args.measure(stages);
        must = { ...m, over: m.mustBytes > m.hardCapBytes };
        if (must.over) {
            issues.push({
                level: "error",
                code: "keep.mustOverCap",
                message:
                    `必保层（must）实占 ${fmtBytes(m.mustBytes)} 超过硬上限 ${fmtBytes(m.hardCapBytes)} —— ` +
                    `压缩等于没压（还白付重建代价）。请给 must 级加 limit / 去掉一级 / 或改小它的取法范围。`,
            });
        }
    }
    const ok = !issues.some((i) => i.level === "error");
    return {
        ok,
        source: args.source,
        budgetBytes: args.budgetBytes,
        keep: ok ? stages : [],
        issues,
        ...(must ? { must } : {}),
    };
}

/** 校验失败的**人读**消息（CLI 打印 / UI 提示同一份文案，不许两处各写） */
export function formatCheckFailure(r: PlanCheckReport): string {
    const errors = r.issues.filter((i) => i.level === "error");
    return `plan 校验未通过：\n${errors.map((e) => `· ${e.message}`).join("\n")}`;
}
