// src/main/core/file-edit.ts
// 🎯 `edit` 工具的**纯内核**：批量 `edits[]` 局部替换 + 归一匹配 + unified patch。
//
// 为什么独立成 core 而不是写在工具里（与 file-read.ts 同一理由）：
//   匹配 / 归一 / diff 这三件事最需要**确定性**，也是最该被单测直接钉住的东西。
//   工具的 execute 只负责 I/O（读盘 / 队列 / 原子写 / 审计），策略全在这里。
//
// 语义（任务 ##415 契约）：
//   · **逐条顺序应用**：后面的 edits 基于前面的结果匹配（不是并行、不是对原文）。
//   · 精确匹配优先；失败才做字符归一（全角/半角、弯直引号、行尾空白、特殊空格/连字符）
//     再试，且**结果里如实说明「用了归一」**——不许偷偷改。
//   · 默认 oldText 必须唯一；多条命中 ⇒ `fs/ambiguous-match`（带出现次数）；
//     `replaceAll: true` 才允许全部替换。
//   · 归一命中时**只重写被命中的那几行**，其余行逐字保留（原文的行尾 / 缩进不被顺手改掉）。
//   · 路径解析复用 `file-write.ts::resolveWritePath`（write/edit 只有一份，##266 review2；护栏已移除），
//     这里只补 edit 独有的两条：目标必须**已存在**且**是普通文件**；
//     unified patch 来自 `unified-diff.ts`（write 的摘要与 edit 的 patch 同一个 LCS）。
//
// 错误码域：`fs/`（与 write 工具同一口径）。错误走 `throw`（不 return），
//   让 SDK 走 tool-error 分支（UI 画 ✗ 且自动展开），与 read / bash 的失败口径一致。
//   `EditError` **继承** write 的 `FileWriteError`（##266 review2）：路径护栏是共用的，
//   同一种「越界」不许在上层表现为两个不相干的类 —— 上层 catch `FileWriteError` 两个都接得住。

import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { FileWriteError, resolveWritePath, type FileWriteErrorCode } from "./file-write";
import { generateUnifiedPatch } from "./unified-diff";

export type EditErrorCode =
    | "fs/empty-edits"
    | "fs/empty-old-text"
    | "fs/no-match"
    | "fs/ambiguous-match"
    | "fs/not-a-file"
    | "fs/read-failed"
    | "fs/write-failed"
    /** 路径护栏（与 write 共用实现，故这几个码来自 `FileWriteError`） */
    | FileWriteErrorCode;

/**
 * edit 的失败：code 是事实（进 triage 统计），message 是给模型看的话。
 *
 * **同族**：继承 `FileWriteError<EditErrorCode>` —— 路径护栏是共用的，同一种「越界」
 * 不许在上层表现为两个不相干的类（catch `FileWriteError` 即可接住两者）。
 */
export class EditError extends FileWriteError<EditErrorCode> {
    constructor(code: EditErrorCode, message: string) {
        super({ code, message });
        this.name = "EditError";
    }
}

/**
 * 本文件**唯一**的 `throw new`（护栏 `scripts/check-error-code.mjs` 只认字面量 code，
 * 这里 code 由参数传入 —— 但它是 `EditErrorCode` 联合类型，编译期就锁死了取值）。
 */
function fail(code: EditErrorCode, message: string): never {
    // error-code-ok: code 由参数传入，受 EditErrorCode 联合类型约束
    throw new EditError(code, message);
}

// ═══════════════════════════════════════════════
//  归一匹配
// ═══════════════════════════════════════════════

/**
 * 归一化文本，专供**匹配**用（改出来的结果只会落回被命中的那几行）：
 *   - NFKC：全角标点 / 全角英数 → 半角
 *   - 每行去尾部空白（模型抄代码时最常丢的就是行尾空格）
 *   - 弯引号 → 直引号
 *   - 各种破折号 / 连字符 → `-`
 *   - 各种特殊空格（NBSP / 全角空格…）→ 普通空格
 *
 * 只按行处理，**不改行数** —— 归一结果与原文可以一行对一行地映射回去。
 */
export function normalizeForFuzzyMatch(text: string): string {
    return text
        .normalize("NFKC")
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/, ""))
        .join("\n")
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
        .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

/** 行尾 / BOM 归一：匹配一律在 LF + 无 BOM 的视图里做，写回时再恢复。 */
export function detectLineEnding(text: string): "\r\n" | "\n" {
    const crlf = text.indexOf("\r\n");
    const lf = text.indexOf("\n");
    return crlf !== -1 && (lf === -1 || crlf < lf) ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
    return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBom(text: string): { bom: string; text: string } {
    return text.startsWith("\uFEFF") ? { bom: "\uFEFF", text: text.slice(1) } : { bom: "", text };
}

// ═══════════════════════════════════════════════
//  批量替换
// ═══════════════════════════════════════════════

export interface EditOp {
    /** 要替换的原文（必须唯一命中，除非 replaceAll） */
    oldText: string;
    /** 替换成什么 */
    newText: string;
    /** 允许多处替换（缺省 = oldText 必须唯一） */
    replaceAll?: boolean;
}

/** 单条 edit 的应用说明（归一命中要如实回给模型）。 */
export interface EditNote {
    /** edits 里的序号（0-based） */
    index: number;
    /** 是否用了归一匹配 */
    usedNormalized: boolean;
    /** 实际替换了几处 */
    replaced: number;
}

export interface ApplyResult {
    /** 替换后的全文 */
    content: string;
    /** 通过校验并应用的 edit 条数 */
    applied: number;
    /** 逐条说明（顺序与 edits 一致） */
    notes: EditNote[];
}

interface Match {
    index: number;
    length: number;
}

/** 找出 target 在 content 里的全部（非重叠）命中，最多 limit 个。 */
function findMatches(content: string, target: string, limit = Number.POSITIVE_INFINITY): Match[] {
    const out: Match[] = [];
    if (target === "") return out;
    let from = 0;
    while (out.length < limit) {
        const i = content.indexOf(target, from);
        if (i === -1) break;
        out.push({ index: i, length: target.length });
        from = i + target.length;
    }
    return out;
}

/** 从后往前替换（前面的偏移不会被打乱）。 */
function applyReplacements(content: string, matches: Match[], newText: string): string {
    let out = content;
    for (let i = matches.length - 1; i >= 0; i--) {
        const m = matches[i];
        out = out.slice(0, m.index) + newText + out.slice(m.index + m.length);
    }
    return out;
}

interface LineSpan {
    start: number;
    end: number;
}

/** 每行的 [start, end)（含行尾换行符；最后一行可能不含）。行数与 `text.split("\n")` 一致。 */
function lineSpans(text: string): LineSpan[] {
    const spans: LineSpan[] = [];
    let offset = 0;
    while (offset < text.length) {
        const nl = text.indexOf("\n", offset);
        const end = nl === -1 ? text.length : nl + 1;
        spans.push({ start: offset, end });
        offset = end;
    }
    // 以 "\n" 结尾的文本：末尾空行也是"一行"（与 split 语义对齐，行数才守恒）
    if (text.length === 0 || text.endsWith("\n")) spans.push({ start: text.length, end: text.length });
    return spans;
}

/**
 * 把「在归一视图上的替换」落回原文：**只重写被命中的行**，其余行逐字取原文。
 *
 * 为什么不能直接把归一后的全文写回：归一去掉了行尾空白、把全角转半角 —— 那等于
 * 顺手改了使用者没要求改的十几行（diff 噪音 + 可能破坏对齐）。这里按替换命中的行范围
 * 分组，组内用归一文本的替换结果，组外一律保留原文。
 */
function preserveUnchangedLines(original: string, base: string, matches: Match[], newText: string): string {
    const originalLines = original.match(/[^\n]*\n|[^\n]+/g) ?? [];
    const baseSpans = lineSpans(base);
    const originalCount = originalLines.length + (original.endsWith("\n") || original === "" ? 1 : 0);
    if (baseSpans.length !== originalCount) {
        // 归一不该改变行数；真变了说明实现坏了 —— 退回整份归一结果（宁可少保留，也不写坏）
        return applyReplacements(base, matches, newText);
    }

    // 每处替换覆盖到归一文本的哪些行
    const ranges = matches
        .map((m) => {
            const startLine = spanIndexAt(baseSpans, m.index);
            const endLine = m.length > 0 ? spanIndexAt(baseSpans, Math.max(m.index, m.index + m.length - 1)) : startLine;
            return { startLine, endLine, match: m };
        })
        .sort((a, b) => a.startLine - b.startLine);

    const groups: Array<{ startLine: number; endLine: number; matches: Match[] }> = [];
    for (const r of ranges) {
        const cur = groups[groups.length - 1];
        if (cur && r.startLine < cur.endLine + 1) {
            cur.endLine = Math.max(cur.endLine, r.endLine);
            cur.matches.push(r.match);
            continue;
        }
        groups.push({ startLine: r.startLine, endLine: r.endLine, matches: [r.match] });
    }

    // 归一文本里每个组的实际字节区间（行 span 的并）
    const groupText = groups.map((g) => {
        const from = baseSpans[g.startLine].start;
        const to = baseSpans[g.endLine].end;
        const local = g.matches.map((m) => ({ index: m.index - from, length: m.length }));
        return { from, to, startLine: g.startLine, endLine: g.endLine, local };
    });

    let out = "";
    let line = 0;
    for (const g of groupText) {
        out += originalLines.slice(line, g.startLine).join("");
        out += applyReplacements(base.slice(g.from, g.to), g.local, newText);
        line = g.endLine + 1;
    }
    out += originalLines.slice(line).join("");
    return out;
}

/** 字节偏移落在第几行（spans 按 start 升序；行边界取"所属行"= start <= offset < end）。 */
function spanIndexAt(spans: LineSpan[], offset: number): number {
    let lo = 0;
    let hi = spans.length - 1;
    let ans = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (spans[mid].start <= offset) {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans;
}

/** 应用一条 edit（精确优先，失败再归一）。返回新内容 + 是否用了归一 + 替换处数。 */
function applyOne(content: string, edit: EditOp, index: number): { content: string; note: EditNote } {
    const oldText = edit.oldText;
    if (oldText === "") fail("fs/empty-old-text", `edits[${index}].oldText 为空：不知道要替换什么`);
    const newText = edit.newText;

    const exact = findMatches(content, oldText, edit.replaceAll ? Number.POSITIVE_INFINITY : 2);
    if (exact.length > 0) {
        if (exact.length > 1 && !edit.replaceAll) {
            fail(
                "fs/ambiguous-match",
                `edits[${index}].oldText 在文件中出现 ${countMatches(content, oldText)} 次，无法确定替换哪一处；` +
                    `请给出更长的上下文，或显式传 replaceAll: true`,
            );
        }
        const matches = edit.replaceAll ? findMatches(content, oldText) : exact.slice(0, 1);
        return {
            content: applyReplacements(content, matches, newText),
            note: { index, usedNormalized: false, replaced: matches.length },
        };
    }

    // 精确匹配失败 → 字符归一后再找
    const base = normalizeForFuzzyMatch(content);
    const target = normalizeForFuzzyMatch(oldText);
    const fuzzy = findMatches(base, target, edit.replaceAll ? Number.POSITIVE_INFINITY : 2);
    if (fuzzy.length === 0) {
        fail(
            "fs/no-match",
            `edits[${index}].oldText 在文件中找不到（精确匹配与字符归一匹配都失败）；` +
                `oldText 必须逐字来自文件（含缩进与换行，但行尾空白 / 全角半角可以不同）`,
        );
    }
    if (fuzzy.length > 1 && !edit.replaceAll) {
        fail(
            "fs/ambiguous-match",
            `edits[${index}].oldText 归一后出现 ${findMatches(base, target).length} 次，无法确定替换哪一处；` +
                `请给出更长的上下文，或显式传 replaceAll: true`,
        );
    }
    const matches = edit.replaceAll ? findMatches(base, target) : fuzzy.slice(0, 1);
    return {
        content: preserveUnchangedLines(content, base, matches, newText),
        note: { index, usedNormalized: true, replaced: matches.length },
    };
}

function countMatches(content: string, target: string): number {
    return findMatches(content, target).length;
}

/**
 * 顺序应用一批 edits。
 *
 * **顺序语义**：后一条在前一条的结果上匹配（`edits` 是有序的编辑指令，不是"原文上的并行补丁"）。
 * 想基于原文的多处独立修改也没问题 —— 顺序执行的第一条不影响后续不重叠的区域。
 */
export function applyEdits(content: string, edits: EditOp[]): ApplyResult {
    if (edits.length === 0) fail("fs/empty-edits", "edits 为空：至少给一条替换");
    let working = content;
    const notes: EditNote[] = [];
    for (let i = 0; i < edits.length; i++) {
        const r = applyOne(working, edits[i], i);
        working = r.content;
        notes.push(r.note);
    }
    return { content: working, applied: edits.length, notes };
}

// ═══════════════════════════════════════════════
//  路径护栏 + 同文件串行队列
// ═══════════════════════════════════════════════

/**
 * 解析 edit 的目标路径：**实现只有一份** —— 直接复用 write 的 {@link resolveWritePath}
 * （相对 cwd 解析 + 最近存在祖先 realpath；**不拦 cwd 越界**，工作护栏已移除）。
 *
 * edit 与 write 的**唯一差异**补在这里：目标必须**已存在**且**是普通文件**
 * （edit 只能改已有内容，新建没有 oldText 可匹配 → 那是 write 的事）。
 *
 * 抛错统一成 `EditError`（它是 `FileWriteError` 的子类，`code` 原样保留）——
 * 上层不会见到「同一种越界抛两种类」。
 */
export function resolveEditablePath(cwd: string, input: string): string {
    let abs: string;
    try {
        abs = resolveWritePath(cwd, input);
    } catch (e) {
        if (e instanceof FileWriteError) {
            // 措辞归 edit：write 的「只写文件」文案不该原样漏到 edit 的错误里
            if (e.code === "fs/is-directory") fail("fs/not-a-file", `${input} 是目录（edit 只改文件）`);
            // error-code-ok: 转手 write 侧已带 code 的错误（code 原样透传，不新造）
            throw new EditError(e.code, e.message);
        }
        throw e;
    }
    let isFile = false;
    try {
        isFile = statSync(abs).isFile();
    } catch {
        fail("fs/not-a-file", `文件不存在：${input}（edit 只能改已存在的文件；新建/整份覆盖请用 write）`);
    }
    if (!isFile) fail("fs/not-a-file", `${input} 不是普通文件（edit 只改文件；看目录用 bash ls）`);
    return abs;
}

/**
 * 展示用相对路径：先试词法 cwd，再试 cwd 的真实路径（macOS 的 `/var` → `/private/var`
 * 这类软链会让**真实路径**跑出词法根，直接 relative 出来是 `../../..`）。
 */
export function displayPath(cwd: string, abs: string): string {
    const roots = [path.resolve(cwd)];
    try {
        const real = realpathSync(cwd);
        if (!roots.includes(real)) roots.push(real);
    } catch {
        /* cwd 不在盘上：只用语法的 */
    }
    for (const root of roots) {
        const rel = path.relative(root, abs);
        if (rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return rel;
    }
    return path.basename(abs);
}

/**
 * 同文件变更队列：同一路径上的 edit **串行**执行（读-改-写不能交错，否则丢更新）。
 *
 * 进程内 Map<path, 队尾 Promise>：后来的调用排在当前队尾之后；前一条失败不影响后一条
 * （用 `then(fn, fn)` 而不是 `then(fn)`）；队列空了就把 key 删掉，不留无界增长。
 */
const fileQueues = new Map<string, Promise<unknown>>();

export function withFileEditQueue<T>(filePath: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = fileQueues.get(filePath) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    fileQueues.set(filePath, tail);
    void tail.then(() => {
        if (fileQueues.get(filePath) === tail) fileQueues.delete(filePath);
    });
    return run;
}

// ═══════════════════════════════════════════════
//  文件级入口（读 → 改 → 写；工具 execute 的唯一调用点）
// ═══════════════════════════════════════════════

export interface EditFileResult {
    /** 变更前全文（LF + 去 BOM，供审计 / diff） */
    before: string;
    /** 变更后全文（LF + 去 BOM） */
    after: string;
    /** 真正写给磁盘的全文（恢复了 BOM 与原行尾） */
    written: string;
    /** 应用说明 */
    result: ApplyResult;
    /** 原文件行尾 */
    ending: "\r\n" | "\n";
    /** unified patch（相对标签由调用方给） */
    patch: string;
}

/**
 * 对一个文件做批量局部编辑。**不做审计**（审计是 services 层的事）。
 *
 * @param abs 已通过 {@link resolveEditablePath} 的绝对路径
 * @param label patch 里展示的路径
 * @param edits 有序编辑列表
 * @param write 写盘函数（缺省 atomic-write；测试可注入）
 */
export function editFile(
    abs: string,
    label: string,
    edits: EditOp[],
    write: (abs: string, content: string) => void,
): EditFileResult {
    let raw: string;
    try {
        if (!statSync(abs).isFile()) fail("fs/not-a-file", `${label} 不是一个普通文件`);
        raw = readFileSync(abs, "utf-8");
    } catch (e) {
        if (e instanceof EditError) throw e;
        fail("fs/read-failed", `读取失败 ${label}：${e instanceof Error ? e.message : String(e)}`);
    }
    const { bom, text } = stripBom(raw);
    const ending = detectLineEnding(text);
    const before = normalizeToLF(text);
    // edits 里的换行也归一（模型可能给 \r\n）
    const normalizedEdits = edits.map((e) => ({
        ...e,
        oldText: normalizeToLF(e.oldText),
        newText: normalizeToLF(e.newText),
    }));
    const result = applyEdits(before, normalizedEdits);
    const written = bom + restoreLineEndings(result.content, ending);
    if (written !== raw) {
        try {
            write(abs, written);
        } catch (e) {
            fail("fs/write-failed", `写入失败 ${label}：${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return { before, after: result.content, written, result, ending, patch: generateUnifiedPatch(label, before, result.content) };
}

/** 人读的一行摘要（工具返回、审计结果都用它）。 */
export function describeEditResult(fileLabel: string, r: EditFileResult): string {
    const notes = r.result.notes;
    const normalized = notes.filter((n) => n.usedNormalized);
    const replaced = notes.reduce((s, n) => s + n.replaced, 0);
    const head =
        r.patch === ""
            ? `已在 ${fileLabel} 上应用 ${r.result.applied} 条替换，但内容没有变化`
            : `已替换 ${fileLabel} 的 ${replaced} 处（${r.result.applied} 条 edits）`;
    if (normalized.length === 0) return head;
    const which = normalized.map((n) => `edits[${n.index}]`).join(" / ");
    return `${head}；其中 ${which} 使用的是**字符归一匹配**（全角/半角、弯直引号、行尾空白已按归一理解），未命中的行逐字保留原文`;
}
