// src/shared/context/projection.ts
// 🎯 Context Tree → 模型 wire 的投影（纯函数）。
//
// 两个容器行为不同（144 结论）：
//   system   —— 每次请求**全量重建**，不进历史，因此天然没有补丁
//   runtime  —— **增量 patch**，只在必要时发全量 snapshot（声明 supersedes=all）
//
// 增量判据只有一个：place 的 **renderedHash**（渲染出来的文本 hash）。
// 值变了但模板没引用到 → renderedHash 不变 → 不投递（144 用例 14）。
// 所有 place 消失 → 必须发**显式清空**，不能只是「什么都不发」（用例 5）。

import { hashText } from "./hash";
import { placeText, renderPathsTraced, renderPlaces } from "./render";
import { CONTEXT_GUIDE } from "./guide";
import { placesIn } from "./tree";
import { WIRE_VERSION } from "./wire";
import type {
    ContextPath,
    ContextProjection,
    ContextTreeState,
    ProjectionResult,
    RuntimeCursor,
    RuntimeDelivery,
    RuntimePatchOp,
} from "./types";

/** 空水位（还没有任何一次投递） */
export function emptyCursor(): RuntimeCursor {
    return { delivered: {}, wireVersion: WIRE_VERSION, placementEpoch: 0 };
}

/** 当前 runtime 各 place 的 renderedHash（增量比较的真源） */
export function renderedHashes(state: ContextTreeState): Record<ContextPath, string> {
    const out: Record<ContextPath, string> = {};
    for (const p of placesIn(state, "runtime")) out[p] = hashText(placeText(state, p));
    return out;
}

/**
 * system 容器全量文本（每次请求重建，无状态）。
 * **带说明头**（结构 + 解读规则，纯文本，见 guide.ts）：这段就是"提示词"本体，
 * 要先告诉模型这是什么、怎么读，再给数据。
 */
export function systemText(state: ContextTreeState): string {
    return renderPathsTraced(state, placesIn(state, "system"), CONTEXT_GUIDE).text;
}

/**
 * system 的**纯数据部分**（不带说明头）。
 * 存在的理由：说明头是固定长文，golden 比对/调试时只想看数据本身；
 * 也让「说明头是否在位」可以单独断言（systemText 以 CONTEXT_GUIDE 开头）。
 */
export function systemData(state: ContextTreeState): string {
    return renderPlaces(state, placesIn(state, "system"));
}

/** runtime 容器全量文本（snapshot 内容 / 调试对照） */
export function runtimeText(state: ContextTreeState): string {
    return renderPlaces(state, placesIn(state, "runtime"));
}

/**
 * 投影一次。
 * `prev` 为 null = 首次（发 snapshot 建立 baseline，不算 rebaseline）。
 * wire 版本变化 / placement 迁移 → 强制 snapshot + needRebaseline。
 */
export function project(state: ContextTreeState, prev: RuntimeCursor | null = null): ProjectionResult {
    const system = systemText(state);
    const next = renderedHashes(state);
    const versionChanged = prev !== null && prev.wireVersion !== state.wireVersion;
    const placementChanged = prev !== null && prev.placementEpoch !== state.placementEpoch;

    let runtime: RuntimeDelivery;
    let needRebaseline = false;

    if (prev === null) {
        runtime = { kind: "snapshot", text: runtimeText(state), supersedes: "all" };
        needRebaseline = true;
    } else if (versionChanged || placementChanged) {
        runtime = { kind: "snapshot", text: runtimeText(state), supersedes: "all" };
        needRebaseline = true;
    } else {
        runtime = diffRuntime(state, prev.delivered, next);
    }

    const projection: ContextProjection = {
        system,
        runtime,
        runtimeText: runtimeText(state),
        needRebaseline,
    };
    return {
        projection,
        cursor: { delivered: next, wireVersion: state.wireVersion, placementEpoch: state.placementEpoch },
    };
}

/** 增量：新有旧无/内容变 → set；旧有新无 → remove；全空且有旧 → clear */
function diffRuntime(
    state: ContextTreeState,
    prev: Record<ContextPath, string>,
    next: Record<ContextPath, string>,
): RuntimeDelivery {
    const ops: RuntimePatchOp[] = [];
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
