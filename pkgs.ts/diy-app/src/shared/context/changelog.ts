// src/shared/context/changelog.ts
// 🎯 上下文**变更历史**（纯函数 + 类型）：**每步**真发一条「有变才写」的变更记录 + 值摘要。
//
// 二版（##310 用户 2026-10-14 拍板）与一版的差别：
//   · **有变才写**（空不写）—— 一版"每轮一条、0 变更也写"已废；
//   · **一步一条**：`streamText` 内一步 = 一次真发请求（`stepId = <turnId>_sN`），不再只到轮；
//   · **变更单位 = 原子单元**（`PLACE_CANDIDATES`，数组不下钻）：`chain` 整体一条，
//     **禁止** `chain.0.content` —— 原子字段要变一起变，下钻会谎报"半棵树变了"（旧实现是 bug）；
//   · **before/after 自带**（落盘自包含）→ 读侧不再回放；`baseline` 首条给整棵树。
//
// 为什么与 steps.jsonl 并存：steps 每步一份**全文**（大，体积治理见 ##410），changelog 每步只有
// **变更 + 一行摘要**（小、可长期留）。审计 / debug / 统计看它；精确回溯看 steps。
//
// 约定：本文件只放纯函数，禁止 import node:*（renderer 会打进包）。

import { PLACE_CANDIDATES } from "./delivery";
import { getValue, removePath, setValue } from "./tree";
import type { ContextPath, ContextTreeState } from "./types";

/** 一次变更的种类 */
export type CtxChangeKind = "add" | "update" | "remove";

/** 记录类型：首条（整棵树）/ 之后有变的每条 */
export type CtxLogType = "baseline" | "changed";

/** 实体横向关联一律用 ref（turnId / stepId / 该轮第几步） */
export interface CtxLogRef {
    turnId: string;
    /** 该轮内第几步的 id（`<turnId>_sN`） */
    stepId: string;
    /** 该轮内第几步（1 基 = 第几次真发请求） */
    step: number;
}

/** 一次变更的旧/新摘要（`truncated` = 任一侧没给全文，只是示意） */
export interface CtxValueSummary {
    before: string | null;
    after: string | null;
    truncated?: boolean;
}

/** 一条变更（二版） */
export interface CtxChangeItem {
    type: CtxChangeKind;
    path: ContextPath;
    data: CtxValueSummary;
}

/** 一条变更记录（落盘形状：会话目录 `$DIY_HOME/local/<uri 路径>/<key>/changelog.jsonl`（##379 前是平铺 `local/<key>.changelog.jsonl`） 一行一条，append-only） */
export interface CtxLogEntry {
    /** **文件内**单调序号（0-based；重启后从末行 +1 续） */
    seq: number;
    type: CtxLogType;
    ts: string;
    model: string;
    /** 投递编码版本（变了 = 前后不可比） */
    wireVersion: string;
    ref: CtxLogRef;
    /** 判别键 `type` 同级 = 公共字段；分支私有数据进 `data`（baseline → tree / changed → changes） */
    data: { tree: ContextTreeState } | { changes: CtxChangeItem[] };
}

/** 变更单位（原子单元）集：静态，**不随 systemPlaces 变**（名单是投递偏好，不是变更口径） */
export function atomicUnitPaths(): ContextPath[] {
    return PLACE_CANDIDATES.map((c) => c.path);
}

/**
 * **变更历史**用的单位集 = 原子单元里"结果来自外部变化"的那些。
 *
 * 与 `atomicUnitPaths` 的差别只有一类：候选显式声明 `changelog: false`（目前仅 `self`）。
 * 它每步必变（窗口占用 / 上一步花费），但它变的原因是"我们刚量了一次"，不是"世界变了" ——
 * 放进变更历史等于每步一条 `changed`，把真变化淹掉。
 *
 * 但**投递仍要它**（模型必须看到最新窗口占用），所以两个口径都留着，别合并。
 */
export function changelogUnitPaths(): ContextPath[] {
    return PLACE_CANDIDATES.filter((c) => c.changelog !== false).map((c) => c.path);
}

/** 参与比较的最小快照（Delivery 结构上满足它；不直接依赖 delivery，避开 render 链） */
export interface CtxSnapshot {
    tree: ContextTreeState;
    /** path → 值 hash（delivery.valueHashes） */
    valueHashes: Record<string, string>;
}

const SUMMARY_MAX = 72;
const ITEM_MAX = 24;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** 单个元素的一行标签（数组 / 对象里用，取自业务字段而非通用 JSON） */
function labelOf(v: unknown): string {
    if (v === null) return "null";
    if (typeof v === "string") {
        const t = oneLine(v);
        return t.length <= ITEM_MAX ? t : `${t.slice(0, ITEM_MAX)}…`;
    }
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) return `[${v.length} 项]`;
    if (typeof v === "object") {
        const o = v as Record<string, unknown>;
        // AGENTS.md 链元素有 path（`~/git/AGENTS.md` 比 `{3 键}` 有用得多）
        if (typeof o["path"] === "string") return (o["path"] as string).replace(/^\/Users\/[^/]+/, "~");
        if (typeof o["name"] === "string") return o["name"] as string;
        return `{${Object.keys(o).length} 键}`;
    }
    return String(v);
}

/**
 * 值 → 一行摘要：短标量给原值，长串截断，数组/对象给「计数 + 元素标签 + 新增」。
 * `truncated` = "这不是全文"（全文在 steps.jsonl 的快照里）。
 */
export function summarizeValue(v: unknown): { text: string; truncated: boolean } {
    if (v === undefined) return { text: "", truncated: false };
    if (v === null) return { text: "null", truncated: false };
    if (typeof v === "string") {
        const t = oneLine(v);
        return t.length <= SUMMARY_MAX
            ? { text: t, truncated: false }
            : { text: `${t.slice(0, SUMMARY_MAX)}…`, truncated: true };
    }
    if (typeof v === "number" || typeof v === "boolean") return { text: String(v), truncated: false };
    if (Array.isArray(v)) {
        const labels = v.slice(0, 4).map(labelOf);
        const more = v.length > 4 ? ` · +${v.length - 4}` : "";
        return { text: `[${v.length} 项] ${labels.join(" · ")}${more}`, truncated: true };
    }
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    const labels = keys.slice(0, 4).map((k) => `${k}: ${labelOf(o[k])}`);
    const more = keys.length > 4 ? ` · +${keys.length - 4}` : "";
    return { text: `{${keys.length} 键} ${labels.join(" · ")}${more}`, truncated: true };
}

/**
 * 两份快照 → 变更项（按**原子单元**比较；顺序 = 单元字典序，稳定可比对）。
 * 与一版 `opsFromHashes` 的关键差别：这里**不下钻数组**（`chain` 整体一条），且直接给出
 * before/after 摘要（落盘自包含 ⇒ 读侧不必回放）。
 */
export function changesOf(
    prev: CtxSnapshot,
    next: CtxSnapshot,
    units: readonly ContextPath[] = atomicUnitPaths(),
): CtxChangeItem[] {
    const out: CtxChangeItem[] = [];
    for (const p of [...units].sort()) {
        const a = prev.valueHashes[p];
        const b = next.valueHashes[p];
        if (a === b) continue; // 两边都没有 / 值没变 → 不是变更
        const type: CtxChangeKind = a === undefined ? "add" : b === undefined ? "remove" : "update";
        const before = a === undefined ? null : summarizeValue(getValue(prev.tree, p));
        const after = b === undefined ? null : summarizeValue(getValue(next.tree, p));
        out.push({
            type,
            path: p,
            data: {
                before: before ? before.text : null,
                after: after ? after.text : null,
                ...(before?.truncated || after?.truncated ? { truncated: true } : {}),
            },
        });
    }
    return out;
}

/** 一条记录的变更数（baseline = 整棵树，不计入"变了几次"） */
export function changeCountOf(entry: CtxLogEntry): number {
    return entry.type === "changed" ? (entry.data as { changes: CtxChangeItem[] }).changes.length : 0;
}

// ══════════════════════════════════════════════════════════════════════════
// legacy（一版）：老任务文件里已落盘、**不再回放**，读侧仅作降级兼容
// ══════════════════════════════════════════════════════════════════════════

/** @deprecated 一版落盘形状（{ts,turnId,model,wireVersion,ops}）；只为读老文件 */
export interface CtxLogRecord {
    ts: string;
    turnId: string;
    model: string;
    wireVersion: string;
    ops: CtxChangeOp[];
}

/** @deprecated 一版变更事件 */
export interface CtxChangeOp {
    kind: CtxChangeKind;
    path: ContextPath;
    preview: string | null;
}

/** @deprecated 一版折叠输出 */
export interface CtxTurnHistory {
    index: number;
    ts: string;
    turnId: string;
    model: string;
    wireVersion: string;
    baseline: boolean;
    changes: CtxChangeRow[];
}

/** @deprecated 一版折叠行 */
export interface CtxChangeRow {
    kind: CtxChangeKind;
    path: ContextPath;
    before: string | null;
    after: string | null;
}

/** 判别一条读入记录是不是二版（有 `type` 就是） */
export function isV2Entry(rec: unknown): rec is CtxLogEntry {
    return !!rec && typeof rec === "object" && typeof (rec as { type?: unknown }).type === "string";
}

/** @deprecated 一版：两份 hash 表 → 事件（老任务的降级折算仍用它） */
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
        if (a === b) continue;
        const kind: CtxChangeKind = a === undefined ? "add" : b === undefined ? "remove" : "update";
        out.push({ kind, path: p, preview: kind === "remove" ? null : (previewFor?.(p) ?? null) });
    }
    return out;
}

/** @deprecated 一版：从基线逐轮回放（新格式不再回放） */
export function foldCtxLog(records: readonly CtxLogRecord[]): CtxTurnHistory[] {
    const values = new Map<ContextPath, string | null>();
    return records.map((r, i) => {
        const changes: CtxChangeRow[] = r.ops.map((op) => {
            const before = values.has(op.path) ? values.get(op.path)! : null;
            if (op.kind === "remove") values.delete(op.path);
            else values.set(op.path, op.preview);
            return { kind: op.kind, path: op.path, before, after: op.kind === "remove" ? null : op.preview };
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

/** 一条二版记录 → 折叠行（UI 统一渲染用；baseline 无 changes） */
export function entryToRows(entry: CtxLogEntry): CtxChangeRow[] {
    if (entry.type === "baseline") return [];
    return (entry.data as { changes: CtxChangeItem[] }).changes.map((c) => ({
        kind: c.type,
        path: c.path,
        before: c.data.before,
        after: c.data.after,
    }));
}

/**
 * 从**变更日志**重放出"上一次真发时的值树"（跨进程重启后的游标播种用）。
 *
 * 为什么需要：变更比较的基准 `LocalAgentManager.ctxSnap` 是**内存 Map**，进程重启即空。
 * 空游标会让重启后第一轮只能拿"轮首值"当基准 → **跨轮变化漏报**（少报不错报，但确实丢了）。
 * 落盘材料齐全，故可播种：`valueHashes` 取 `steps.jsonl` 末条（真值 hash），
 * 值树取最后一条 `baseline` 的全量树 + 之后各 `changed` 的 `after`。
 *
 * ⚠️ 精度边界（别拿它当值树真源）：`changed` 里存的是 `summarizeValue` 的**摘要**
 * （长串截断、数组/对象只留一行标签），所以重放是**单元级**——整单元被摘要串替换
 * （不做深合并）。对**长值**这棵树不是全文；它只够产出 **before 摘要**（本用途，摘要再过一次
 * `summarizeValue` 仍是同一行），全文在 `steps.jsonl` 的 `systemText` / `runtimeText`。
 * 也别把它喂 UI 当真值树显示（`baseline` 段那部分是真值，被 `changed` 覆盖的段不是）。
 *
 * 没有 `baseline`（老任务 / 还没写过起点）→ 返回 `null`：调用方应**退回"不播种"**
 * （少报），而不是拿当前值冒充旧值（错报）。
 */
export function foldCtxTree(records: readonly CtxLogEntry[]): ContextTreeState | null {
    const lastBaseline = records.map((r) => r.type).lastIndexOf("baseline");
    if (lastBaseline < 0) return null;
    const base = records[lastBaseline]!;
    let tree = (base.data as { tree: ContextTreeState }).tree;
    for (const rec of records.slice(lastBaseline + 1)) {
        if (rec.type !== "changed") continue;
        for (const c of (rec.data as { changes: CtxChangeItem[] }).changes) {
            // `remove` = 该单元此刻不存在；其余（add/update）写回 after 摘要串。
            tree = c.type === "remove" ? removePath(tree, c.path) : setValue(tree, c.path, c.data.after ?? null);
        }
    }
    return tree;
}

// ══════════════════════════════════════════════════════════════════════════
// 树节点 × 变更：把一条变更标到**整棵变量树**的对应节点上（##310 变量树 diff view）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 树上一个节点路径是否被某条变更命中。
 *
 * 命中的两种情形（**只有这两种**）：
 *   · 同路径（变更就发生在该节点）；
 *   · 落在变更单元**之下**（`chain` 变了 → `chain.0` / `chain.0.content` 也算它变的）。
 *
 * 反向（`chain.0` 变了命中 `chain`）**不成立**：变更单位是原子单元，`chain.0` 那种记录
 * 本身就不该存在（旧实现的 bug）。这里如实反映"这条变更是谁引起的"。
 */
export function nodeHitByChange(nodePath: string, changePath: string): boolean {
    return nodePath === changePath || nodePath.startsWith(`${changePath}.`);
}

/** 某节点命中的**最具体**那条变更（同路径优先，其次最近的祖先单元）；都没有 = null */
export function changeForNode<T extends { path: string }>(
    nodePath: string,
    changes: readonly T[],
): T | null {
    let best: T | null = null;
    for (const c of changes) {
        if (!nodeHitByChange(nodePath, c.path)) continue;
        if (best === null || c.path.length > best.path.length) best = c;
    }
    return best;
}
