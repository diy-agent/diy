// src/shared/context/projection.ts
// 🎯 Context Tree → 模型 wire 的投影（纯函数）。
//
// 只有一个投递形态（##520：system / runtime 两容器已删）：
//   · 全量 = 信封（`help:` + `vars:`），每次请求重建，放 system 参数
//   · 增量 = 按**原子单元**逐条比 `renderedHash`；变了的单元才发
//
// 增量判据只有一个：place 的 **renderedHash**（渲染出来的文本 hash）。
// 值变了但模板没引用到 → renderedHash 不变 → 不投递（144 用例 14）。
// 所有 place 消失 → 必须发**显式清空**，不能只是「什么都不发」（用例 5）。

import { hashText } from "./hash.js";
import { placeText } from "./wire-render.js";
import { dataText, varsEnvelope } from "./envelope.js";
import { WIRE_VERSION } from "./wire.js";
import type {
    ContextPath,
    ContextProjection,
    ContextTreeState,
    DeliveryCursor,
    DeltaDelivery,
    DeltaOp,
    ProjectionResult,
} from "./types.js";

/** 空水位（还没有任何一次投递） */
export function emptyCursor(): DeliveryCursor {
    return { delivered: {}, wireVersion: WIRE_VERSION };
}

/** 当前各原子单元的 renderedHash（增量比较的真源） */
export function renderedHashes(state: ContextTreeState): Record<ContextPath, string> {
    const out: Record<ContextPath, string> = {};
    for (const p of [...state.places].sort()) out[p] = hashText(placeText(state, p));
    return out;
}

/**
 * 信封全文（`help:` + `vars:`；每次请求重建，无状态）。
 * 与真发**同一处产出**（`envelope.ts` 的 `varsEnvelope`）—— 两处各造一份必然漂移。
 */
export function envelopeText(state: ContextTreeState): string {
    return varsEnvelope(state, state.places, state.places).text;
}

/**
 * 变量树的**纯数据部分**（不带 help 段）。
 * 存在的理由：help 是固定长文，golden 比对/调试时只想看数据本身。
 */
export function dataOf(state: ContextTreeState): string {
    return dataText(state, [...state.places].sort());
}

/**
 * 投影一次。
 * `prev` 为 null = 首次（发全量建立 baseline，不算 rebaseline）。
 * wire 版本变化 → 强制全量 + needRebaseline。
 */
export function project(state: ContextTreeState, prev: DeliveryCursor | null = null): ProjectionResult {
    const text = envelopeText(state);
    const data = dataOf(state);
    const next = renderedHashes(state);
    const versionChanged = prev !== null && prev.wireVersion !== state.wireVersion;

    let delta: DeltaDelivery;
    let needRebaseline = false;

    if (prev === null) {
        delta = { kind: "snapshot", text: text, supersedes: "all" };
        needRebaseline = true;
    } else if (versionChanged) {
        delta = { kind: "snapshot", text: text, supersedes: "all" };
        needRebaseline = true;
    } else {
        delta = diffUnits(state, prev.delivered, next);
    }

    const projection: ContextProjection = { text, data, delta, needRebaseline };
    return {
        projection,
        cursor: { delivered: next, wireVersion: state.wireVersion },
    };
}

/** 增量：新有旧无/内容变 → set；旧有新无 → remove；全空且有旧 → clear */
function diffUnits(
    state: ContextTreeState,
    prev: Record<ContextPath, string>,
    next: Record<ContextPath, string>,
): DeltaDelivery {
    const ops: DeltaOp[] = [];
    for (const [p, h] of Object.entries(next)) {
        if (prev[p] !== h) ops.push({ op: "set", path: p, content: placeText(state, p) });
    }
    for (const p of Object.keys(prev)) {
        if (!(p in next)) ops.push({ op: "remove", path: p });
    }
    const allGone = Object.keys(next).length === 0 && Object.keys(prev).length > 0;
    if (allGone) return { kind: "clear" };
    if (ops.length === 0) return { kind: "none" };
    return { kind: "patch", ops };
}
