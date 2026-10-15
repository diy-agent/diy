// src/shared/context/diff-view.ts
// 🎯 行级 diff 的**阅读形态**（纯函数）：把 `lineDiff` 的平铺结果折成"改动块 + 折叠的空隙"。
//
// ── 为什么要有它（用户 2026-10-15）──
// 「变量树变更 view 看起来还是不行，不够直观……加个纯文本的 view，类似文本比较 diff 的方式
//   直观显示变化」。平铺 diff 有两个毛病：① 只有 `+`/`-` 行（旧 UI 把上下文行全滤掉）导致
//   **改了哪一段看不出来**；② 两份全场文本（system 二十几 KB）摊开 = 找不着重点。
//   折成 hunk（改动 ± 若干行上下文、中间空隙折叠成一行）才是"像 vscode 那样一眼看出改了啥"。
//
// ── 为什么要行号 ──
// 上下文树这一整套的说法都是"**定位**"：`path` 定位变量、文件:行 定位日志。diff 也一样 ——
// 给出旧/新两侧的行号，才能说"第 42 行那处改了"，也才能跟 `steps.jsonl` 的全文对上。
//
// 约定：本文件只放纯函数，禁止 import node:*（renderer 会打进包）。

import type { DiffLine } from "../line-diff";

/** 带旧/新行号的 diff 行（`null` = 该侧不存在这一行） */
export interface NumberedDiffLine {
    /** ' ' 原文 | '-' 删除 | '+' 新增 */
    t: string;
    s: string;
    oldNo: number | null;
    newNo: number | null;
}

/** 折叠形态的一行：要么是真行，要么是被折掉的一段空隙 */
export type DiffRow =
    | { kind: "line"; line: NumberedDiffLine }
    | {
          kind: "gap";
          /** 被折掉的行数 */
          count: number;
          /** 空隙覆盖的下标区间（指向**平铺 diff 数组**，闭区间）—— UI 展开时按它切回来 */
          fromIdx: number;
          toIdx: number;
          /** 空隙前一行在旧/新两侧的行号（0 = 文件开头之前） */
          oldFrom: number;
          newFrom: number;
          /** 稳定的 key（同一份 diff 内唯一，UI 用它记"哪几个空隙被展开了"） */
          id: string;
          /** 尾部截断标记（超过 `maxLines` 时只剩这一行） */
          truncated?: boolean;
      };

/** 给平铺 diff 补行号 */
export function numberDiff(diff: readonly DiffLine[]): NumberedDiffLine[] {
    let oldNo = 0;
    let newNo = 0;
    return diff.map((d) => {
        const oldN = d.t === "+" ? null : ++oldNo;
        const newN = d.t === "-" ? null : ++newNo;
        return { t: d.t, s: d.s, oldNo: oldN, newNo: newN };
    });
}

export const gapId = (fromIdx: number, truncated = false): string =>
    `gap:${fromIdx}${truncated ? ":trunc" : ""}`;

/**
 * 折成 hunk：改动行各留 ±`context` 行上下文，其余折成 `gap`。
 *
 * 没改动的行（全是 ' '）→ 返回 `[]`（调用方据此显示"无实质变化"，而不是给一大坨原文）。
 * `maxLines` 兜住渲染量：系统上下文几千行时，一张展开的 diff 会把页面拖死 —
 * 超了就截断并留一个 `truncated` 的 gap（读侧一眼知道"后面还有，别看漏"）。
 */
export function foldDiff(
    diff: readonly DiffLine[],
    opts: { context?: number; maxLines?: number } = {},
): DiffRow[] {
    const ctx = Math.max(0, opts.context ?? 3);
    const numbered = numberDiff(diff);
    const changed: number[] = [];
    numbered.forEach((l, i) => {
        if (l.t !== " ") changed.push(i);
    });
    if (changed.length === 0) return [];

    // 保留区间：每个改动行 ±ctx，重叠/相邻即合并
    const ranges: Array<[number, number]> = [];
    for (const i of changed) {
        const start = Math.max(0, i - ctx);
        const end = Math.min(numbered.length - 1, i + ctx);
        const last = ranges[ranges.length - 1];
        if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
        else ranges.push([start, end]);
    }

    const out: DiffRow[] = [];
    const maxLines = opts.maxLines ?? 0;
    let emitted = 0;
    const budgetLeft = (): boolean => maxLines <= 0 || emitted < maxLines;

    const pushGap = (from: number, to: number, truncated = false): void => {
        if (to < from) return;
        // 空隙紧跟在上一行之后 → 行号从"上一行的行号"起算（开头之前记 0）
        const prev = from > 0 ? numbered[from - 1]! : null;
        out.push({
            kind: "gap",
            count: to - from + 1,
            fromIdx: from,
            toIdx: to,
            oldFrom: prev?.oldNo ?? 0,
            newFrom: prev?.newNo ?? 0,
            id: gapId(from, truncated),
            ...(truncated ? { truncated: true } : {}),
        });
    };

    let cursor = 0;
    for (const [start, end] of ranges) {
        if (!budgetLeft()) break;
        pushGap(cursor, start - 1);
        for (let i = start; i <= end; i++) {
            if (!budgetLeft()) {
                pushGap(i, numbered.length - 1, true);
                return out;
            }
            out.push({ kind: "line", line: numbered[i]! });
            emitted++;
        }
        cursor = end + 1;
    }
    if (cursor < numbered.length) pushGap(cursor, numbered.length - 1);
    return out;
}

/** 折叠形态的增删计数（列表/标题里一眼看变化量） */
export function foldCounts(rows: readonly DiffRow[]): { add: number; del: number; gapLines: number } {
    let add = 0;
    let del = 0;
    let gapLines = 0;
    for (const r of rows) {
        if (r.kind === "gap") gapLines += r.count;
        else if (r.line.t === "+") add++;
        else if (r.line.t === "-") del++;
    }
    return { add, del, gapLines };
}
