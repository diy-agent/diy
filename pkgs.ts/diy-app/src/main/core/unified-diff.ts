// src/main/core/unified-diff.ts
// 🎯 行级 diff 的**唯一实现**：LCS + hunk 渲染 + unified patch 文本。
//
// 为什么单独成文件（##266 review2 裁决）：write（##414 整文件写的 diff 摘要）与
// edit（##415 局部编辑的 patch 回执）都要 diff。曾经各内嵌一份 LCS —— 两份实现就是
// 「一处修了另一处没修」的源头。这里只留一份；两个调用方只做**展示层**的事：
//   · write：新文件摘要、头尾截断（maxLines）、added/removed 真值
//   · edit ：直接返回全文 patch
//
// 纯函数、零 fs、零依赖。

export type DiffOpKind = "eq" | "del" | "add";

export interface DiffOp {
    kind: DiffOpKind;
    text: string;
}

/** 缺省上下文行数（同 git） */
export const DEFAULT_PATCH_CONTEXT = 3;

/** 中间区段 LCS 的规模上限（cells）——超过就退化成「整段删 + 整段加」，保证不卡住主进程。 */
const LCS_MAX_CELLS = 4_000_000;

const BOM = "\uFEFF";

/** 按 `\n` 切行（不保留行尾符；文件末尾无换行的最后一行也保留；BOM 不算内容） */
export function splitDiffLines(s: string): string[] {
    const body = s.startsWith(BOM) ? s.slice(1) : s;
    if (body === "") return [];
    const lines = body.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
}

/** 单行展示：去掉行尾 `\r`（CRLF 文件不让 diff 里挂一根看不见的控制符） */
export function displayDiffLine(line: string): string {
    return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** 规模超限返回 null（调用方退化成「整段删 + 整段加」）—— 用返回值而不是异常：这不是错误场景。 */
function lcsOps(a: string[], b: string[]): DiffOp[] | null {
    if (a.length === 0) return b.map((text) => ({ kind: "add" as const, text }));
    if (b.length === 0) return a.map((text) => ({ kind: "del" as const, text }));
    if (a.length * b.length > LCS_MAX_CELLS) return null;
    const n = a.length;
    const m = b.length;
    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i * w + j] =
                a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        }
    }
    const out: DiffOp[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            out.push({ kind: "eq", text: a[i] });
            i++;
            j++;
        } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
            out.push({ kind: "del", text: a[i] });
            i++;
        } else {
            out.push({ kind: "add", text: b[j] });
            j++;
        }
    }
    while (i < n) out.push({ kind: "del", text: a[i++] });
    while (j < m) out.push({ kind: "add", text: b[j++] });
    return out;
}

/** 行级 diff（掐掉公共前后缀再算 LCS —— 单点编辑的中间区段通常只有几行）。 */
export function diffLines(before: string[], after: string[]): DiffOp[] {
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head++;
    let tail = 0;
    while (
        tail < before.length - head &&
        tail < after.length - head &&
        before[before.length - 1 - tail] === after[after.length - 1 - tail]
    ) {
        tail++;
    }
    const a = before.slice(head, before.length - tail);
    const b = after.slice(head, after.length - tail);
    const middle =
        lcsOps(a, b) ??
        ([...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))] as DiffOp[]);
    return [
        ...before.slice(0, head).map((text) => ({ kind: "eq" as const, text })),
        ...middle,
        ...before.slice(before.length - tail).map((text) => ({ kind: "eq" as const, text })),
    ];
}

/**
 * 把 ops 渲染成带上下文的 hunks（相邻变更距离 ≤ 2·context 时并进同一块）。
 *
 * @param fileLabel 非 null 时在首部写 `--- a/<label>` / `+++ b/<label>`
 */
export function renderUnifiedHunks(ops: DiffOp[], context: number, fileLabel: string | null): string[] {
    // 每个 op 之前已消费的旧/新行数（用于 @@ 头的起点：hunk 首行前的位置 + 1）
    let oldNo = 0;
    let newNo = 0;
    const rows = ops.map((op) => {
        const row = { kind: op.kind, text: op.text, oldBefore: oldNo, newBefore: newNo };
        if (op.kind !== "add") oldNo++;
        if (op.kind !== "del") newNo++;
        return row;
    });

    const changeIdx = rows.map((r, i) => (r.kind === "eq" ? -1 : i)).filter((i) => i >= 0);
    if (changeIdx.length === 0) return [];
    const hunks: Array<{ start: number; end: number }> = [];
    for (const idx of changeIdx) {
        const cur = hunks[hunks.length - 1];
        if (cur && idx - cur.end <= context * 2) {
            cur.end = idx;
            continue;
        }
        hunks.push({ start: idx, end: idx });
    }

    const out: string[] = fileLabel === null ? [] : [`--- a/${fileLabel}`, `+++ b/${fileLabel}`];
    for (const h of hunks) {
        const from = Math.max(0, h.start - context);
        const to = Math.min(rows.length - 1, h.end + context);
        const slice = rows.slice(from, to + 1);
        const oldCount = slice.filter((r) => r.kind !== "add").length;
        const newCount = slice.filter((r) => r.kind !== "del").length;
        // 与 git 同一约定：count = 0 时起点写「前一行」，否则写 hunk 首行行号
        const oldStart = oldCount === 0 ? slice[0].oldBefore : slice[0].oldBefore + 1;
        const newStart = newCount === 0 ? slice[0].newBefore : slice[0].newBefore + 1;
        out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
        for (const r of slice) {
            out.push(`${r.kind === "eq" ? " " : r.kind === "del" ? "-" : "+"}${displayDiffLine(r.text)}`);
        }
    }
    return out;
}

export interface PatchOptions {
    /** 上下文行数（缺省 3，同 git） */
    context?: number;
}

/**
 * 生成 unified patch（`---` / `+++` / `@@`）。
 *
 * @param fileLabel 展示用路径（相对 cwd 更易读；不参与 IO）
 * @param before 变更前全文（LF）
 * @param after 变更后全文（LF）
 * @returns 无差异时返回 ""
 */
export function generateUnifiedPatch(fileLabel: string, before: string, after: string, opts: PatchOptions = {}): string {
    if (before === after) return "";
    const ops = diffLines(splitDiffLines(before), splitDiffLines(after));
    return renderUnifiedHunks(ops, opts.context ?? DEFAULT_PATCH_CONTEXT, fileLabel).join("\n");
}
