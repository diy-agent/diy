// src/shared/yaml-lines.ts
// 🎯 值 → YAML 文本行（带缩进/可折叠标记）—— 纯函数，main/renderer 共用。
//
// 为什么不用现成 YAML 库：① renderer 包体积（js-yaml ~30KB）；② 我们要的不是"能解析回去"，
// 而是"人读得舒服 + 能按层级折叠 + 能逐行 diff" —— 库给的是字符串，折叠信息还得自己再解析一遍。
// 这里直接产出**带缩进的行模型**，折叠/对齐/diff 全在行上做，一步到位。
//
// 定位：这是**展示**用 YAML（键序按对象插入序、字符串按 JSON 转义），不承诺被解析。

/** 一行 YAML + 折叠/对齐所需的元信息 */
export interface YamlLine {
    /** 缩进层级（0 起） */
    indent: number;
    /** 行文本（含 `- ` / `key:` 前缀，不含缩进空格） */
    text: string;
    /** 该行是否有子行（可折叠头） */
    foldable: boolean;
    /** 稳定路径（从根起按 key/index），用于两侧对齐 */
    path: string;
}

const INDENT = "  ";

/** 标量原地渲染（含转义）；返回 null 表示"不是原地可写"，需换行块 */
function inlineScalar(v: unknown): string | null {
    if (v === null) return "null";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (typeof v === "string") {
        if (v === "") return '""';
        if (v.includes("\n")) return null; // 多行 → 块标量
        return JSON.stringify(v); // 统一加引号 + 转义，读起来无歧义
    }
    return null;
}

/** 是否"空容器"（渲染成 `{}` / `[]`） */
function isEmpty(v: unknown): boolean {
    if (Array.isArray(v)) return v.length === 0;
    if (v && typeof v === "object") return Object.keys(v as object).length === 0;
    return false;
}

/** 是否是容器（对象/数组，需要多行） */
function isContainer(v: unknown): boolean {
    return v !== null && typeof v === "object";
}

/**
 * 值 → 行列表。
 * @param value 任意 JSON 值
 * @param pathPrefix 该值自身的路径（用于子行）
 */
export function toYamlLines(value: unknown, pathPrefix = ""): YamlLine[] {
    const out: YamlLine[] = [];
    const push = (indent: number, text: string, path: string, foldable: boolean) =>
        out.push({ indent, text, foldable, path });

    /** 渲染容器内的一个「键: 值」 */
    const emitKey = (indent: number, key: string, v: unknown, path: string) => {
        const sk = inlineScalar(v);
        if (sk !== null) {
            push(indent, `${key}: ${sk}`, path, false);
            return;
        }
        if (isEmpty(v)) {
            push(indent, `${key}: ${Array.isArray(v) ? "[]" : "{}"}`, path, false);
            return;
        }
        if (typeof v === "string") {
            // 多行字符串 → 块标量 `|`
            const lines = v.split("\n");
            push(indent, `${key}: |`, path, true);
            lines.forEach((l, i) => push(indent + 1, l === "" ? "" : `  ${l}`, `${path}/${i}`, false));
            return;
        }
        if (Array.isArray(v)) {
            push(indent, `${key}:`, path, true);
            emitArrayItems(indent + 1, v, path);
            return;
        }
        // 对象
        push(indent, `${key}:`, path, true);
        for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
            emitKey(indent + 1, k, vv, `${path}/${k}`);
        }
    };

    /** 渲染数组项：`- ` 起头，对象首键与 `-` 同行 */
    const emitArrayItems = (indent: number, arr: unknown[], path: string) => {
        arr.forEach((item, i) => {
            const ip = `${path}/${i}`;
            const sk = inlineScalar(item);
            if (sk !== null) {
                push(indent, `- ${sk}`, ip, false);
                return;
            }
            if (isEmpty(item)) {
                push(indent, `- ${Array.isArray(item) ? "[]" : "{}"}`, ip, false);
                return;
            }
            if (typeof item === "string") {
                const lines = item.split("\n");
                push(indent, "- |", ip, true);
                lines.forEach((l, j) => push(indent + 1, l === "" ? "" : `  ${l}`, `${ip}/${j}`, false));
                return;
            }
            if (Array.isArray(item)) {
                push(indent, "-", ip, true);
                emitArrayItems(indent + 1, item, ip);
                return;
            }
            // 对象项：首键与 `-` 同行
            const entries = Object.entries(item as Record<string, unknown>);
            const [k0, v0] = entries[0]!;
            const sk0 = inlineScalar(v0);
            if (sk0 !== null) push(indent, `- ${k0}: ${sk0}`, `${ip}/${k0}`, false);
            else if (isEmpty(v0)) push(indent, `- ${k0}: ${Array.isArray(v0) ? "[]" : "{}"}`, `${ip}/${k0}`, false);
            else {
                push(indent, `- ${k0}:`, `${ip}/${k0}`, true);
                if (typeof v0 === "string") {
                    v0.split("\n").forEach((l, j) => push(indent + 1, l === "" ? "" : `  ${l}`, `${ip}/${k0}/${j}`, false));
                } else if (Array.isArray(v0)) emitArrayItems(indent + 1, v0, `${ip}/${k0}`);
                else for (const [k, vv] of Object.entries(v0 as Record<string, unknown>)) emitKey(indent + 1, k, vv, `${ip}/${k0}/${k}`);
            }
            for (const [k, vv] of entries.slice(1)) emitKey(indent + 1, k, vv, `${ip}/${k}`);
        });
    };

    const sk = inlineScalar(value);
    if (sk !== null) push(0, sk, pathPrefix || "/", false);
    else if (isEmpty(value)) push(0, Array.isArray(value) ? "[]" : "{}", pathPrefix || "/", false);
    else if (Array.isArray(value)) emitArrayItems(0, value, pathPrefix);
    else for (const [k, vv] of Object.entries(value as Record<string, unknown>)) emitKey(0, k, vv, `${pathPrefix}/${k}`);
    return out;
}

/** 整行文本（含缩进）—— 供复制/导出用 */
export function yamlText(lines: readonly YamlLine[]): string {
    return lines.map((l) => INDENT.repeat(l.indent) + l.text).join("\n");
}

/**
 * 折叠：给定「已折叠的行索引集合」，返回应显示的行。
 * 折叠某行 = 隐藏其后所有缩进更深的行。
 * 用行索引作键（同一份行列表内稳定），不依赖 path（path 在增删后会错位）。
 */
export function visibleLineIndexes(lines: readonly YamlLine[], collapsed: ReadonlySet<number>): number[] {
    const out: number[] = [];
    let skipIndent = -1; // > -1 表示正在跳过（隐藏缩进 > skipIndent 的行）
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!;
        if (skipIndent >= 0) {
            if (l.indent > skipIndent) continue;
            skipIndent = -1; // 回到同级/更浅 → 结束跳过
        }
        out.push(i);
        if (l.foldable && collapsed.has(i)) skipIndent = l.indent;
    }
    return out;
}

/** 某行是否有「变化后代」（add/del）—— 用于决定折叠态默认展开哪里 */
export function foldHeaders(lines: readonly YamlLine[]): number[] {
    return lines.map((l, i) => (l.foldable ? i : -1)).filter((i) => i >= 0);
}

// ─── 对齐（两侧 diff 行）─────────────────────────────────

/** 对齐后的 diff 行（并排/统一两种视图共用同一份数据） */
export interface YamlDiffRow {
    /** change = 同一位置左右都有但文本不同（并排一行；统一视图拆成 -/+ 两行） */
    t: "same" | "add" | "del" | "change";
    /** 左侧（base）行；add 行没有 */
    left?: YamlLine;
    /** 右侧（mod）行；del 行没有 */
    right?: YamlLine;
    /** 该行缩进（取存在的一侧） */
    indent: number;
    /** 该行是否可折叠（取存在的一侧） */
    foldable: boolean;
}

/**
 * 两份行列表 → 对齐行。
 * 用行级 LCS 得到 ' '/'-'/'+'，再把连续的删/增配对（同一位置并排显示）。
 * 说明：这里是**展示级**对齐（行文本相等即"未变"），不做结构化 diff —— 对 YAML 缩进文本足够，
 * 且与用户"看 diff"的直觉一致（增删行各自成行）。
 */
export function diffYamlRows(base: readonly YamlLine[], mod: readonly YamlLine[]): YamlDiffRow[] {
    const A = base.map((l) => l.text);
    const B = mod.map((l) => l.text);
    // 朴素 LCS（YAML 行数可控；与 shared/line-diff 同策略）
    const n = A.length;
    const m = B.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            dp[i]![j] = A[i] === B[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    const raw: { t: "+" | "-" | " "; ai?: number; bi?: number }[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (A[i] === B[j]) {
            raw.push({ t: " ", ai: i, bi: j });
            i++;
            j++;
        } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
            raw.push({ t: "-", ai: i });
            i++;
        } else {
            raw.push({ t: "+", bi: j });
            j++;
        }
    }
    while (i < n) raw.push({ t: "-", ai: i++ });
    while (j < m) raw.push({ t: "+", bi: j++ });

    // 把相邻的 - 段与 + 段配对成同一行（并排视图可左右对照）
    const rows: YamlDiffRow[] = [];
    for (let k = 0; k < raw.length; ) {
        const r = raw[k]!;
        if (r.t === " ") {
            const l = base[r.ai!]!;
            rows.push({ t: "same", left: l, right: mod[r.bi!]!, indent: l.indent, foldable: l.foldable });
            k++;
            continue;
        }
        if (r.t === "-") {
            const dels: number[] = [];
            while (k < raw.length && raw[k]!.t === "-") dels.push(raw[k++]!.ai!);
            const adds: number[] = [];
            while (k < raw.length && raw[k]!.t === "+") adds.push(raw[k++]!.bi!);
            const max = Math.max(dels.length, adds.length);
            for (let x = 0; x < max; x++) {
                const left = x < dels.length ? base[dels[x]!] : undefined;
                const right = x < adds.length ? mod[adds[x]!] : undefined;
                rows.push({
                    t: left && right ? "change" : left ? "del" : "add",
                    ...(left ? { left } : {}),
                    ...(right ? { right } : {}),
                    indent: (left ?? right)!.indent,
                    foldable: (left ?? right)!.foldable,
                });
            }
            continue;
        }
        // 纯 + 段
        const adds: number[] = [];
        while (k < raw.length && raw[k]!.t === "+") adds.push(raw[k++]!.bi!);
        for (const bi of adds) {
            const r2 = mod[bi]!;
            rows.push({ t: "add", right: r2, indent: r2.indent, foldable: r2.foldable });
        }
    }
    return rows;
}

/** 折叠过滤（对 diff 行同样适用）：折叠某行 = 隐藏其后缩进更深的行 */
export function visibleDiffRows(rows: readonly YamlDiffRow[], collapsed: ReadonlySet<number>): number[] {
    const out: number[] = [];
    let skipIndent = -1;
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        if (skipIndent >= 0) {
            if (r.indent > skipIndent) continue;
            skipIndent = -1;
        }
        out.push(i);
        if (r.foldable && collapsed.has(i)) skipIndent = r.indent;
    }
    return out;
}

/** 折叠态默认：折叠「不含任何增删后代」的节（只留变化路径展开）—— 长会话打开即聚焦差异 */
export function defaultCollapsed(rows: readonly YamlDiffRow[]): Set<number> {
    const changed = new Set<number>();
    // 标记每个变化行的所有祖先（按缩进栈）
    const stack: number[] = [];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        while (stack.length && rows[stack[stack.length - 1]!]!.indent >= r.indent) stack.pop();
        if (r.t !== "same") {
            for (const s of stack) changed.add(s);
            if (r.foldable) changed.add(i);
        }
        if (r.foldable) stack.push(i);
    }
    const out = new Set<number>();
    for (let i = 0; i < rows.length; i++) if (rows[i]!.foldable && !changed.has(i)) out.add(i);
    return out;
}

// ─── 层级展开（「展开 i/N」逐步展开）+ 折叠态变更提示 ──────────

/**
 * 实际存在的**可折叠深度序列**（升序去重）。
 *
 * 为什么不用「缩进整数值」当层级：可折叠行的缩进会跳级（如 messages 下第一层
 * 折叠行在 indent 2 而非 1）→ 按整数递增会出现「两级折叠集完全一样」的空档，
 * 表现为「点展开没反应」（实测踩过）。按**真实存在的深度**递进，每次点击必有变化。
 */
export function foldDepths(rows: readonly YamlDiffRow[]): number[] {
    const set = new Set<number>();
    for (const r of rows) if (r.foldable) set.add(r.indent);
    return [...set].sort((a, b) => a - b);
}

/** 可折叠深度序列的长度 = 「展开 i/N」的 N（i 从 0 到 N；i = N 时全展开） */
export function foldLevelCount(rows: readonly YamlDiffRow[]): number {
    return foldDepths(rows).length;
}

/**
 * 按「展开档位」求折叠集合。
 *   levelIndex = 0 → 折叠所有可折叠行（只露根行）
 *   levelIndex = N（= 深度数）→ 全展开
 *   中间：折叠深度 >= 第 levelIndex 个深度的可折叠行（即「展开到第 levelIndex 层」）
 * 语义保证：levelIndex 从 0 递增到 N，每一步都**必然**展开一批实际存在的折叠行。
 */
export function collapsedAtLevel(rows: readonly YamlDiffRow[], levelIndex: number): Set<number> {
    const depths = foldDepths(rows);
    const out = new Set<number>();
    if (levelIndex >= depths.length) return out; // 全展开
    const threshold = depths[Math.max(0, levelIndex)]!;
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        if (r.foldable && r.indent >= threshold) out.add(i);
    }
    return out;
}

export interface ChangeCount {
    add: number;
    del: number;
}

/**
 * 每个可折叠行**其子树内**的变更数（含自身）。
 * 用途：折叠状态下外层看不出内部有没有红/绿 —— 在折叠箭头上标一个「有变更」的点/计数，
 * 用户不必逐级展开才知道「这里藏着改动」。
 * 实现：可折叠行的子树 = 其后连续「缩进更深」的行（同一份行列表里天然成立）。
 */
export function subtreeChanges(rows: readonly YamlDiffRow[]): Map<number, ChangeCount> {
    const out = new Map<number, ChangeCount>();
    const bump = (m: Map<number, ChangeCount>, i: number, add: number, del: number) => {
        const c = m.get(i) ?? { add: 0, del: 0 };
        c.add += add;
        c.del += del;
        m.set(i, c);
    };
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        if (!r.foldable) continue;
        for (let j = i + 1; j < rows.length && rows[j]!.indent > r.indent; j++) {
            const c = rows[j]!;
            if (c.t === "add") bump(out, i, 1, 0);
            else if (c.t === "del") bump(out, i, 0, 1);
            else if (c.t === "change") bump(out, i, 1, 1);
        }
        if (!out.has(i)) out.set(i, { add: 0, del: 0 });
    }
    return out;
}
