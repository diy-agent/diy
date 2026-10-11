// src/shared/context/attribution.ts
// 🎯 「归属」与「归因」的**纯函数**：一个变量路径落在哪个投递单元；system 全量重建由谁引起。
//
// 为什么抽出来（review RV-10）：这两件事原先各写一份、住在 `ContextLabPage.tsx` 里（review1 各修一处），
// 同一概念两份代码迟早分裂；且封闭在 UI 组件里只能靠 UI 级探针取证。提为纯函数后：
//   · `sysCauses` 复用 `attributionOf`（一份实现）；
//   · 可在 `tests/core/` 直接单测（RV-09 / RV-11 的证据不再依赖 Electron）。
//
// 约定：本文件只放纯函数，禁止 import node:*（renderer 会打进包）。

import { unitPathsOf } from "./delivery";
import type { ContextContainer, ContextPath } from "./types";

/** 一个投递单元（path → 容器） */
export interface PlaceUnit {
    place: ContextPath;
    container: ContextContainer;
}

/**
 * 一个变量路径的**投递归属**。三态，不能压成一种（review RV-01）：
 *   · unit      —— 被某个投递单元覆盖（path 是该单元或其后代）→ 报单元名 + 容器；
 *   · container —— 是若干单元的**祖先**（如 `task`：子字段横跨 system/runtime）→ 报跨哪几个单元；
 *   · none      —— 既不被单元覆盖、也不是单元的祖先（如 `persona.name`：根本不在投递里，
 *                  `PLACE_CANDIDATES` 刻意不列 persona）→ 必须说"未投递"，不能谎报成 runtime。
 */
export type Attribution =
    | { kind: "unit"; place: ContextPath; container: ContextContainer }
    | { kind: "container"; units: PlaceUnit[] }
    | { kind: "none" };

/** 划分表（`LabRule[]`）→ 单元 map */
export function unitsFromRules(rules: readonly PlaceUnit[]): Map<string, ContextContainer> {
    return new Map(rules.map((r) => [r.place, r.container]));
}

/**
 * **某一轮快照的划分**（`systemPlaces`）→ 单元 map（未进名单的单元 = runtime）。
 * 用于历史归因：那时生效的是这一轮的划分，不是页面当前那把刀（review RV-02）。
 *
 * 单元名单必须与当轮**真发**同一份（`unitPathsOf` = 候选 ∪ 名单 − 与名单互斥的候选）。
 * 只遍历 `PLACE_CANDIDATES` 会两个方向都说错话（review RV-14，探针三实现对照）：
 *   · 候选外的手填单元被整个丢掉 → 该单元的变化报"无原因"；
 *   · 名单里是祖先级单元（手填 `task`）时，被挤掉的候选被当幽灵单元造出来 →
 *     `task.title` 被谎报成 `task.title(runtime)`，而该轮实际单元是 `task(system)`。
 * `systemPlaces` 缺失时按空名单处理（读侧兜底是 main 的活，这里再兜一层不冲突 —— RV-17）。
 */
export function unitsFromSystemPlaces(systemPlaces: readonly string[] | undefined): Map<string, ContextContainer> {
    const sys = new Set(systemPlaces ?? []);
    return new Map(unitPathsOf(systemPlaces ?? []).map((p) => [p, (sys.has(p) ? "system" : "runtime") as ContextContainer]));
}

export function attributionOf(units: ReadonlyMap<string, ContextContainer>, path: string): Attribution {
    // ① 覆盖它的最深单元（`chain.0.path` → `chain`）
    let best: string | null = null;
    for (const u of units.keys()) {
        if ((path === u || path.startsWith(`${u}.`)) && (best === null || u.length > best.length)) best = u;
    }
    if (best !== null) return { kind: "unit", place: best, container: units.get(best)! };
    // ② 它是某些单元的祖先 → 容器行（子字段分属多个单元）
    const spanned = [...units.entries()].filter(([u]) => u.startsWith(`${path}.`));
    if (spanned.length > 0) {
        return { kind: "container", units: spanned.map(([place, container]) => ({ place, container })) };
    }
    // ③ 不在投递里
    return { kind: "none" };
}

/**
 * system 全量重建的**原因**：把变化的变量收拢到该轮 system 单元（叶子 `chain.0.path` → `chain`）。
 * 用**当轮快照**的 `systemPlaces`（不是页面当前划分 —— 改划分不该改写历史，review RV-02），
 * 并复用 `attributionOf`：容器 path（如 `task`）展开成其子字段所属的单元（一份实现，RV-10）。
 * 空数组 = 不是值变化引起的（说明头/渲染变了，或变化落在未投递路径）。
 */
export function sysCauses(changed: readonly string[] | undefined, systemPlaces: readonly string[] | undefined): ContextPath[] {
    const units = unitsFromSystemPlaces(systemPlaces);
    const out = new Set<ContextPath>();
    for (const p of changed ?? []) {
        const a = attributionOf(units, p);
        if (a.kind === "unit") {
            if (a.container === "system") out.add(a.place);
        } else if (a.kind === "container") {
            for (const u of a.units) if (u.container === "system") out.add(u.place);
        }
    }
    return [...out].sort();
}

/**
 * 统计表的行粒度（review RV-03）：中间容器（有后代同时上榜）且自身**不是投递单元** → 折叠。
 * 容器的变化恒由后代解释（父 hash = 子树 hash），单列只会稀释"该不该待在 system"的判据。
 * `units` 取自**页面当前划分**（统计是"今天这把刀切哪"的操作视角；与 sys 徽章的当轮快照口径有意不同，
 * 见 `ContextLabPage.tsx` 的 statsPane 注）。`units` 为空（划分未加载）时不折叠 —— 否则会瞬时误折叠单元行。
 */
export function foldStatRows(
    allPaths: readonly string[],
    units: ReadonlyMap<string, ContextContainer>,
): { rows: string[]; collapsed: number } {
    if (units.size === 0) return { rows: [...allPaths], collapsed: 0 };
    const isUnit = (p: string): boolean => units.has(p);
    const isContainer = (p: string): boolean => allPaths.some((q) => q !== p && q.startsWith(`${p}.`));
    const rows = allPaths.filter((p) => isUnit(p) || !isContainer(p));
    return { rows, collapsed: allPaths.length - rows.length };
}
