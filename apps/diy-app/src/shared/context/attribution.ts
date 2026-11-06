// src/shared/context/attribution.ts
// 🎯 「归属」的**纯函数**：一个变量路径落在哪个投递单元。
//
// 为什么抽出来（review RV-10）：原先各写一份、住在 `ContextLabPage.tsx` 里，同一概念两份代码
// 迟早分裂；且封闭在 UI 组件里只能靠 UI 级探针取证。提为纯函数后可在 `tests/core/` 直接单测。
//
// ##520 起没有 system / runtime 两容器：单元只回答「这个 path 的增量/变更记在哪一条」。

import { unitPaths } from "@diy-agent/context/delivery";
import type { ContextPath } from "@diy-agent/context/types";

/** 一个投递单元 */
export interface PlaceUnit {
    place: ContextPath;
}

/**
 * 一个变量路径的**投递归属**。三态，不能压成一种（review RV-01）：
 *   · unit      —— 被某个投递单元覆盖（path 是该单元或其后代）→ 报单元名；
 *   · container —— 是若干单元的**祖先**（如 `task`：子字段各自成单元）→ 报跨哪几个单元；
 *   · none      —— 既不被单元覆盖、也不是单元的祖先（如 `persona.name`：根本不在投递里，
 *                  `PLACE_CANDIDATES` 刻意不列 persona）→ 必须说"未投递"，不能谎报。
 */
export type Attribution =
    | { kind: "unit"; place: ContextPath }
    | { kind: "container"; units: ContextPath[] }
    | { kind: "none" };

/** 单元名单（`LabRule[]` 或任何带 `place` 的列表）→ 集合 */
export function unitsFromRules(rules: readonly PlaceUnit[]): Set<string> {
    return new Set(rules.map((r) => r.place));
}

/** 全量候选单元（help / 统计表的判据与真发同一份） */
export function allUnits(): Set<string> {
    return new Set(unitPaths());
}

export function attributionOf(units: ReadonlySet<string>, path: string): Attribution {
    // ① 覆盖它的最深单元（`chain.0.path` → `chain`）
    let best: string | null = null;
    for (const u of units) {
        if ((path === u || path.startsWith(`${u}.`)) && (best === null || u.length > best.length)) best = u;
    }
    if (best !== null) return { kind: "unit", place: best };
    // ② 它是某些单元的祖先 → 容器行（子字段分属多个单元）
    const spanned = [...units].filter((u) => u.startsWith(`${path}.`)).sort();
    if (spanned.length > 0) return { kind: "container", units: spanned };
    // ③ 不在投递里
    return { kind: "none" };
}

/**
 * 统计表的行粒度（review RV-03）：中间容器（有后代同时上榜）且自身**不是投递单元** → 折叠。
 * 容器的变化恒由后代解释（父 hash = 子树 hash），单列只会稀释"这个单元变得多不多"的判据。
 * `units` 为空（名单未加载）时不折叠 —— 否则会瞬时误折叠单元行。
 */
export function foldStatRows(
    allPaths: readonly string[],
    units: ReadonlySet<string>,
): { rows: string[]; collapsed: number } {
    if (units.size === 0) return { rows: [...allPaths], collapsed: 0 };
    const isUnit = (p: string): boolean => units.has(p);
    const isContainer = (p: string): boolean => allPaths.some((q) => q !== p && q.startsWith(`${p}.`));
    const rows = allPaths.filter((p) => isUnit(p) || !isContainer(p));
    return { rows, collapsed: allPaths.length - rows.length };
}
