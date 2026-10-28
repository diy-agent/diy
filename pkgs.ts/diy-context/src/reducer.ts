// src/shared/context/reducer.ts
// 🎯 ContextFact → ContextTree 的状态转换（纯函数）。
//
// 两条死线（144 结论）：
//   1. **不静默合并**：baseHash 不匹配、路径非法、声明 hash 与实际不符 —— 一律拒绝该事实
//      并把 needRebaseline 置真，让上层重发 baseline。宁可重发，不可猜。
//   2. **变化只由最终值决定**：applyFact 只改状态；「算不算变化」由 step 前后比 hash 得出
//      （见 stepDelta）。中途改十次、最后改回原值 = 没变。

import { hashText, hashValue } from "./hash";
import { isValidPath } from "./path";
import {
    emptyState,
    getValue,
    isPlainObject,
    removePath,
    setRenderer,
    setValue,
    validatePlaces,
    valueHashOf,
} from "./tree";
import { WIRE_VERSION } from "./wire";
import type {
    ContextApplyResult,
    ContextFact,
    ContextPath,
    ContextStepDelta,
    ContextTreeState,
} from "./types";

/** 新树（空） */
export function createTree(wireVersion: string = WIRE_VERSION): ContextTreeState {
    return emptyState(wireVersion);
}

/** 应用一个事实 */
export function applyFact(state: ContextTreeState, fact: ContextFact): ContextApplyResult {
    switch (fact.type) {
        case "snapshot":
            return applySnapshot(fact.state);
        case "replace":
            return applyReplace(state, fact);
        case "patch":
            return applyPatch(state, fact);
        case "remove":
            return applyRemove(state, fact);
    }
}

/** 应用一串事实（前一个的 rejected 不阻断后续；needRebaseline 取或） */
export function applyFacts(state: ContextTreeState, facts: readonly ContextFact[]): ContextApplyResult {
    let cur = state;
    let rejected: ContextApplyResult["rejected"];
    let needRebaseline = false;
    for (const f of facts) {
        const r = applyFact(cur, f);
        cur = r.state;
        if (r.rejected) rejected = r.rejected;
        needRebaseline ||= r.needRebaseline;
    }
    return { state: cur, rejected, needRebaseline };
}

// ─── 各事实类型 ────────────────────────────────────────

function applySnapshot(next: ContextTreeState): ContextApplyResult {
    const check = validatePlaces(next.places ?? []);
    const state = check.ok ? next : { ...next, places: [] };
    // 快照是「唯一版本兼容点」：恢复后必须重发 runtime baseline，否则模型历史里的旧
    // patch 仍会与新状态混在一起（144 结论）。
    return {
        state,
        rejected: check.ok ? undefined : "invalid-path",
        needRebaseline: true,
    };
}

function applyReplace(
    state: ContextTreeState,
    fact: Extract<ContextFact, { type: "replace" }>,
): ContextApplyResult {
    if (!isValidPath(fact.path)) return { state, rejected: "invalid-path", needRebaseline: false };
    if (fact.baseHash !== undefined && valueHashOf(state, fact.path) !== fact.baseHash) {
        return { state, rejected: "base-hash-mismatch", needRebaseline: true };
    }
    // 两种内容格式，两种落法（各自自洽，不引 YAML 解析器）：
    //   template-text —— content 是模板源码 → 换渲染方式，值树不动
    //   yaml          —— content 是该节点**已渲染文本**（yaml 只标明来源格式）→ 原样存值
    const next =
        fact.contentFormat === "template-text"
            ? setRenderer(state, fact.path, { renderer: "template", source: fact.content })
            : setRenderer(setValue(state, fact.path, fact.content), fact.path, { renderer: "text" });
    // 发送方声明的 hash 与实际不符 = adapter 转错（探针，不静默接受）
    if (fact.valueHash !== undefined && valueHashOf(next, fact.path) !== fact.valueHash) {
        return { state, rejected: "hash-mismatch", needRebaseline: true };
    }
    if (
        fact.contentFormat !== "template-text" &&
        fact.renderedHash !== undefined &&
        hashText(fact.content) !== fact.renderedHash
    ) {
        return { state, rejected: "hash-mismatch", needRebaseline: true };
    }
    return { state: next, needRebaseline: false };
}

function applyPatch(
    state: ContextTreeState,
    fact: Extract<ContextFact, { type: "patch" }>,
): ContextApplyResult {
    if (!isValidPath(fact.path)) return { state, rejected: "invalid-path", needRebaseline: false };
    if (fact.op === "remove") return applyRemove(state, { type: "remove", path: fact.path });

    if (fact.baseHash !== undefined && valueHashOf(state, fact.path) !== fact.baseHash) {
        return { state, rejected: "base-hash-mismatch", needRebaseline: true };
    }
    if (fact.op === "replace" && getValue(state, fact.path) === undefined) {
        return { state, rejected: "not-found", needRebaseline: false };
    }
    return { state: setValue(state, fact.path, fact.value), needRebaseline: false };
}

function applyRemove(
    state: ContextTreeState,
    fact: Extract<ContextFact, { type: "remove" }>,
): ContextApplyResult {
    if (!isValidPath(fact.path)) return { state, rejected: "invalid-path", needRebaseline: false };
    if (!hasAnythingAt(state, fact.path)) {
        return { state, rejected: "not-found", needRebaseline: false };
    }
    return { state: removePath(state, fact.path), needRebaseline: false };
}

/** path 处是否「有东西」（值或渲染声明），用于 remove 的 not-found 判定 */
function hasAnythingAt(state: ContextTreeState, path: ContextPath): boolean {
    if (getValue(state, path) !== undefined) return true;
    return Object.keys(state.renderers).some((k) => k === path || k.startsWith(`${path}.`));
}

// ─── step 统计 ─────────────────────────────────────────

/**
 * 值树里**所有** path 的值 hash（含中间节点：父节点的 hash 就是它整棵子树的值 hash，
 * 所以「父节点比自身最终 hash」天然成立，不需要给父节点累加子节点计数）。
 */
export function valueHashes(state: ContextTreeState): Record<ContextPath, string> {
    const out: Record<ContextPath, string> = {};
    const walk = (node: unknown, base: string): void => {
        if (base) out[base] = hashValue(node);
        if (!isPlainObject(node)) return;
        for (const [k, v] of Object.entries(node)) walk(v, base ? `${base}.${k}` : k);
    };
    walk(state.values, "");
    for (const [p, spec] of Object.entries(state.renderers)) {
        if (spec.renderer === "template") out[p] = hashValue(spec.source);
    }
    return out;
}

/**
 * step 前后比较（144 用例 11~13）：只比**最终** hash。
 * 同一 step 内改多次 → 一次；改回原值 → 零次；父节点按自身最终 hash 判，不累加子节点。
 */
export function stepDelta(before: ContextTreeState, after: ContextTreeState): ContextStepDelta {
    const a = valueHashes(before);
    const b = valueHashes(after);
    const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .filter((p) => a[p] !== b[p])
        .sort();
    const counts: Record<ContextPath, number> = {};
    for (const p of changed) counts[p] = 1;
    return { changed, counts };
}

// ─── placement 迁移 ────────────────────────────────────

/**
 * 改一个 place 的容器归属：**递增 placementEpoch**（144 用例 17）。
 * 迁移后 runtime 必须重发 baseline —— 否则模型历史里的旧 patch 会指向已经不存在的 place。
 */
export function setPlacement(
    state: ContextTreeState,
    place: ContextPath,
    container: ContextTreeState["placement"][string],
): ContextTreeState {
    return {
        ...state,
        placement: { ...state.placement, [place]: container },
        placementEpoch: state.placementEpoch + 1,
    };
}

/** 整体替换 places 配置（同样递增 epoch；校验不过则原样返回） */
export function setPlaces(state: ContextTreeState, places: readonly ContextPath[]): ContextTreeState {
    const check = validatePlaces(places);
    if (!check.ok) return state;
    return { ...state, places: check.places, placementEpoch: state.placementEpoch + 1 };
}
