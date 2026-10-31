// src/shared/context/step-delta.ts
// 🎯 一步的**控制增量**（user 消息里的 `system:` / `runtime:` 两段）—— 真发与单测的唯一口径。
//
// ── 契约（##442 用户 2026-10-27）──
//   · 变量没变 ⇒ 空串（调用方据此**不注入**：不发消息、不加字节 ⇒ 前缀缓存不动）
//   · 变了 ⇒ 只列**变化的原子单元**，值是变更后的新值；"变几个字段就发几个字段"
//   · 单元整体消失 ⇒ 该 path 落 `null`（不是静默不发 —— 否则模型一直按旧值干活）
//   · 按**该步的划分**分流：划进 system 名单的走 `system:` 段，其余走 `runtime:` 段
//   · 段内顺序 = path 字典序（同一份变化两次渲染逐字节相同）
//
// ── 为什么只有这一条路（不要把增量塞回 system）──
//   段首 system 是快照（`segment-snapshot.ts`），压缩点前不重建。任何"这里改一下 system
//   更直接"的写法都会让整段历史每轮按 cache miss 计费 —— 实测 ##266 单步成本 ×12。
//
// 约定：本文件只放纯函数，禁止 import node:*（renderer 会打进包）。

import { controlDeltaDelivery, isRuntimePlace, type DeliveryPart } from "@diy-agent/context/delivery";
import type { ContextPath } from "@diy-agent/context/types";
import { atomicUnitPaths, changesOf, type CtxSnapshot } from "./changelog";

/** 本步增量的全部产出（文本给 wire；paths 给观测/断言；part 给需要行号的调用点） */
export interface StepDelta {
    /** 要追加进 user 消息的文本；空串 = 这一步什么都没变（**不要注入**） */
    text: string;
    /** 变化的原子单元（字典序） */
    paths: ContextPath[];
    /** 其中按本步划分归 system 的（增量里出现在 `system:` 段） */
    systemPaths: ContextPath[];
    /** 其中归 runtime 的（增量里出现在 `runtime:` 段） */
    runtimePaths: ContextPath[];
    /** 完整投递段（bytes / 行号映射） */
    part: DeliveryPart;
}

/** 只需要两份快照的值树 + hash 表（`Delivery` 与 `CtxSnapshot` 都满足） */
export type DeltaSnapshot = Pick<CtxSnapshot, "tree" | "valueHashes">;

/**
 * 两份快照 → 本步增量。
 *
 * `prev` **必须是"上一次给模型看过的树"**，不是本轮轮首值：跨轮变化（用户改完正文再来问）
 * 恰恰发生在轮首之前，用轮首值当基准就永远看不见（##310 五轮的老 bug）。
 */
export function stepDeltaOf(
    prev: DeltaSnapshot,
    next: DeltaSnapshot,
    units: readonly ContextPath[] = atomicUnitPaths(),
): StepDelta {
    const changed = changesOf(prev, next, units);
    const paths = changed.map((c) => c.path);
    const systemPaths = paths.filter((p) => !isRuntimePlace(next.tree, p));
    const runtimePaths = paths.filter((p) => isRuntimePlace(next.tree, p));
    const part = controlDeltaDelivery(next.tree, systemPaths, runtimePaths);
    return { text: part.text, paths, systemPaths, runtimePaths, part };
}
