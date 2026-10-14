// src/shared/context/changelog.ts
// 🎯 上下文**变更历史**（纯函数 + 类型）：每轮真发一条变更事件流 + 折叠回放。
//
// 与 steps.jsonl 的分工（为什么另开一份，不是从快照折算）：
//   steps.jsonl  每轮一条**全文**（两份容器文本）→ 大，按任务、可被清理；是"这一步发了什么"
//   changelog    每轮一条**只有事件**（op + path + 一行值预览）→ 小，可长期留；是"什么时候什么变了"
// 折算（只拿 valueHashes 做差）看不出 **add/remove 的方向**，也拿不到值预览（快照不存值）——
// 那正是「变更历史」要看的东西。老任务没有这份日志时，读侧仍会从快照折算一个**降级**视图
// （见 main 的 app.context.changelog：`source: "derived"`）。
//
// 为什么每轮都写一条（哪怕 0 变更）：轮序 = 真发投递快照的轮序（两条日志同点写、同序 append），
// 「这一轮什么都没变」本身就是事实（缓存没被砸）。
//
// 约定：本文件只放纯函数，禁止 import node:*（renderer 会打进包）。

import type { ContextPath } from "./types";

/** 一次变更的种类 */
export type CtxChangeKind = "add" | "update" | "remove";

/** 一条变更事件（落盘形状的一半） */
export interface CtxChangeOp {
    kind: CtxChangeKind;
    path: ContextPath;
    /**
     * 变更**后**的单行值预览（`previewOf`，72 字截断）；`remove` = null。
     * 存预览不存全文：预览够"一眼认出是哪一版"，全文由 steps.jsonl 承担（体积差一个量级）。
     */
    preview: string | null;
}

/** 一轮的变更日志（落盘形状；`$DIY_HOME/local/<key>.changelog.jsonl` 一行一条，append-only） */
export interface CtxLogRecord {
    /** 记录时刻（ISO） */
    ts: string;
    /** 轮次 id（与 ops / 投递快照 / 用量账本同一套 turnId，便于交叉检索） */
    turnId: string;
    model: string;
    /** 投递编码版本（变了 = 前后不可比） */
    wireVersion: string;
    /** 该轮相对上一轮的事件；首轮 = 基线（每个 path 一条 add）；可为空（这轮什么都没变） */
    ops: CtxChangeOp[];
}

/** 折叠后的一行变更（before/after 由回放得出 —— 落盘只存 after） */
export interface CtxChangeRow {
    kind: CtxChangeKind;
    path: ContextPath;
    /** 变化前的预览（该 path 首次出现 = null） */
    before: string | null;
    /** 变化后的预览（删除 = null） */
    after: string | null;
}

/** 一轮的变更历史（供 UI 直接渲染） */
export interface CtxTurnHistory {
    /** 1 基轮序（与真发投递快照的 index 同序 —— 两条日志同点写） */
    index: number;
    ts: string;
    turnId: string;
    model: string;
    wireVersion: string;
    /** 首轮（基线）：没有"上一轮"，changes 是全部 path 的 add */
    baseline: boolean;
    changes: CtxChangeRow[];
}

/**
 * 两份值 hash 表 → 变更事件（字典序，稳定可比对）。落盘**不**存 from/to hash：
 * 方向由 `kind` 表达（add/remove 由 hash 的有无判定），值由 `preview` 表达 —— 存 hash 只是重复
 * steps.jsonl（那边已经有整份 valueHashes）。
 *
 * `prev` 为 null（某任务首轮）→ 全部算 `add`：这是**基线**，不是"变了 n 次"（同 stats.ts 的 RV-15 口径，
 * 但那边把基线抹成空、这边**保留**基线 —— 变更历史要回放，没有基线就没有起点）。
 * 折算路径（老任务，见主文件头注）拿不到值 → `previewFor` 缺省给 null，行显示只到 path 粒度。
 */
export function opsFromHashes(
    prev: Record<string, string> | null,
    next: Record<string, string>,
    previewFor?: (path: ContextPath) => string | null,
): CtxChangeOp[] {
    const keys = new Set([...(prev ? Object.keys(prev) : []), ...Object.keys(next)]);
    const out: CtxChangeOp[] = [];
    for (const p of [...keys].sort()) {
        const a = prev?.[p];
        const b = next[p];
        if (a === b) continue; // 两边都没有 / 值没变 → 不是变更
        const kind: CtxChangeKind = a === undefined ? "add" : b === undefined ? "remove" : "update";
        out.push({ kind, path: p, preview: kind === "remove" ? null : (previewFor?.(p) ?? null) });
    }
    return out;
}

/**
 * 从基线开始**逐轮回放**事件 → 每轮的变更行（before/after 都在）。
 * 回放是这份日志能自洽的全部原因：落盘只存"改成了什么"，"原来是什么"由前缀推出来。
 */
export function foldCtxLog(records: readonly CtxLogRecord[]): CtxTurnHistory[] {
    /**
     * path → 当前预览（随回放推进）。值可以是 **null = 值未知**（折算路径的事件没有预览）——
     * 与"这个 path 不存在"由 `has()` 区分：`before` 为 null 有两种可能（不存在 / 未知），
     * 而 `kind` 恰好把"不存在"那一侧说清了（add 之前必不存在、remove 之后必不存在）。
     */
    const values = new Map<ContextPath, string | null>();
    return records.map((r, i) => {
        const changes: CtxChangeRow[] = r.ops.map((op) => {
            const before = values.has(op.path) ? values.get(op.path)! : null;
            if (op.kind === "remove") values.delete(op.path);
            else values.set(op.path, op.preview);
            return {
                kind: op.kind,
                path: op.path,
                before,
                after: op.kind === "remove" ? null : op.preview,
            };
        });
        return {
            index: i + 1,
            ts: r.ts,
            turnId: r.turnId,
            model: r.model,
            wireVersion: r.wireVersion,
            baseline: i === 0,
            changes,
        };
    });
}

/** 某轮变化的 path（喂 sysCauses / 归因；与投递快照的 `sincePrev.changed` 同集） */
export function changedOf(record: CtxLogRecord): ContextPath[] {
    return record.ops.map((o) => o.path).sort();
}
