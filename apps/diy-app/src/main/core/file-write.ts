// src/main/core/file-write.ts
// 🎯 整文件写的**唯一实现**：路径护栏 + 大小上限 + BOM 保留 + unified diff 摘要。
//
// 为什么单独抽（与 core/file-read.ts 同一思路）：`write` 工具（本地 agent）与将来的
// `edit` 工具（##415）共用**同三件东西** —— 路径护栏、diff 生成、错误码。
// 各写一份必然分叉：分叉就是「有的越界拦得住、有的拦不住」，而路径逃逸是会写到仓库外去的。
//
// 契约（与 ##414 任务 body 一致；**cwd 越界拦截已按用户要求移除**）：
//   · 相对路径按 cwd 解析，**不限制落在 cwd 内** —— 写到 cwd 之外照样放行。
//     realpath 的对象仍是「目标存在就解析目标，不存在就解析最近存在的祖先 + 剩余段」——
//     留下来的只是「折成真实绝对路径」，不再有「拦不拦」这一步。
//   · content 上限 1 MB，超限 `fs/content-too-large`（文案给出实际字节与上限）。
//   · 目标是目录 → `fs/is-directory`；父目录不存在 → mkdir -p（走 writeFileAtomic 自带）。
//   · UTF-8 原样写：行尾不转换（不擅自 CRLF↔LF）；原文件有 BOM 而新内容没有 → 补回。
//   · 原子写走 core/atomic-write.ts（写失败时目标文件逐字不变）。
//   · 返回 diff 摘要：新文件给前 N 行；旧文件 unified diff，超 100 行头尾截断 + 省略标记。
//
// ⚠️ 错误是**抛**不是 return（##353 同口径）：catch-and-return 的字符串会被画成 ✓。

import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { diffLines, displayDiffLine, renderUnifiedHunks, splitDiffLines } from "./unified-diff";

/** 单次写入的内容上限（字节，UTF-8）。1 MB 足够一整份源码/文档，又不至于把主进程内存撑爆。 */
export const WRITE_MAX_BYTES = 1024 * 1024;

/** UTF-8 BOM（写入时按原文件保留，不新增） */
const BOM = "\uFEFF";

export type FileWriteErrorCode = "fs/path-escape" | "fs/content-too-large" | "fs/is-directory";

/**
 * 写入类错误：`code` 用 `fs/` 域（`error-triage.ts::CODE_RE` 已含 fs，不新开域）。
 *
 * 泛型参数只为**同族子类**（`EditError`）能收窄自己的 code 联合（##266 review2）：
 * 上层 `catch (e) { if (e instanceof FileWriteError) … }` 一次接住 write 与 edit 的路径错误。
 */
export class FileWriteError<C extends string = FileWriteErrorCode> extends Error {
    readonly code: C;
    /** 对象参数形态：`{ code, message }` —— 与 `throw new Error(msg, { code })` 同一种「码在实参里」的写法 */
    constructor(init: { code: C; message: string }) {
        super(init.message);
        this.name = "FileWriteError";
        this.code = init.code;
    }
}

/**
 * 把「最近存在的祖先」解析成真实路径，再把不存在的剩余段拼回去。
 *
 * 为什么不能只 `path.resolve` 后判前缀：目标可能是 symlink（`cwd/link -> /etc`），
 * 纯字符串判断看着在 cwd 内，实际写到 /etc 去了。
 */
function realpathOfNearest(abs: string): string {
    let probe = abs;
    const rest: string[] = [];
    for (;;) {
        try {
            const real = realpathSync(probe);
            return rest.length > 0 ? path.join(real, ...rest) : real;
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            // ENOENT / ENOTDIR：这段还不存在（或中间某段是文件）→ 上溯一层继续解析。
            // 其它错误（EACCES / ELOOP）**fail-closed**：解析不了就不放行 ——
            // ELOOP 的自引用 symlink 尤其不能靠"反正写不进去"来兜（解析不了就不写）。
            if (code !== "ENOENT" && code !== "ENOTDIR") {
                throw new FileWriteError({
                    code: "fs/path-escape",
                    message: `无法解析路径 ${probe}（${code}）：路径不可解析，拒绝写入`,
                });
            }
            const parent = path.dirname(probe);
            if (parent === probe) return path.join(probe, ...rest);
            rest.unshift(path.basename(probe));
            probe = parent;
        }
    }
}

/**
 * 路径解析：把（相对 cwd 解析的）路径折成真实绝对路径。
 *
 * **不做 cwd 越界拦截**：写 cwd 之外同样放行（工作护栏已移除）。只剩两条判断：
 * 空路径 / 路径不可解析（`fs/path-escape`）、目标就是 cwd 本身（`fs/is-directory`）。
 *
 * @throws FileWriteError `fs/path-escape`（空路径 / 不可解析）· `fs/is-directory`（cwd 自身）
 */
export function resolveWritePath(cwd: string, relPath: string): string {
    const raw = relPath.trim();
    if (!raw) throw new FileWriteError({ code: "fs/path-escape", message: "path 不能为空" });
    const root = realpathSync(path.resolve(cwd));
    const real = realpathOfNearest(path.resolve(root, raw));
    if (path.relative(root, real) === "") {
        throw new FileWriteError({ code: "fs/is-directory", message: `${relPath} 是工作目录本身（write 只写文件）` });
    }
    return real;
}

// ═══════════════════════════════════════════════
//  unified diff 摘要
// ═══════════════════════════════════════════════

export interface DiffOptions {
    /** 展示用路径（写进 `--- a/…` / `+++ b/…`；缺省不写文件名头） */
    path?: string;
    /** 上下文行数（缺省 3，同 git） */
    context?: number;
    /** 输出总行数上限（缺省 100；超出时头尾截断 + 省略标记） */
    maxLines?: number;
    /** 新文件最多列出前多少行（缺省 20） */
    maxNewFileLines?: number;
}

export interface DiffResult {
    /** 新增行数（`+` 行） */
    added: number;
    /** 删除行数（`-` 行） */
    removed: number;
    /** unified diff 文本（未变化时为空串） */
    text: string;
    /** 是否因 maxLines 截断 */
    truncated: boolean;
}

/**
 * 生成 unified diff 摘要。
 *
 * @param before 原内容（`null` = 新文件）
 * @param after 新内容
 */
export function unifiedDiff(before: string | null, after: string, opts: DiffOptions = {}): DiffResult {
    const ctx = opts.context ?? 3;
    const maxLines = opts.maxLines ?? 100;
    const maxNewFileLines = opts.maxNewFileLines ?? 20;
    const pathLabel = opts.path ?? null;
    const afterLines = splitDiffLines(after);

    // 新文件：全部 + 行，只列前 N 行（新增行数仍是真值）
    if (before === null) {
        const head = pathLabel === null ? [] : ["--- /dev/null", `+++ b/${pathLabel}`];
        const shown = afterLines.slice(0, maxNewFileLines);
        const body = shown.map((l) => `+${displayDiffLine(l)}`);
        const omitted = afterLines.length - shown.length;
        const tail =
            omitted > 0 ? [`[省略 ${omitted} 行（新文件共 ${afterLines.length} 行）]`] : [];
        const lines = [...head, `@@ -0,0 +1,${afterLines.length} @@`, ...body, ...tail];
        return { added: afterLines.length, removed: 0, text: lines.join("\n"), truncated: omitted > 0 };
    }

    // diff 本体（LCS + hunk 渲染）**只有一份**，在 core/unified-diff.ts（##266 review2）：
    // edit 的 patch 回执与这里的摘要同源，改一处两边都变。本函数只做展示层（截断 / 新文件）。
    const ops = diffLines(splitDiffLines(before), afterLines);
    const added = ops.filter((o) => o.kind === "add").length;
    const removed = ops.filter((o) => o.kind === "del").length;
    if (added === 0 && removed === 0) return { added: 0, removed: 0, text: "", truncated: false };

    let lines = renderUnifiedHunks(ops, ctx, pathLabel);
    let truncated = false;
    if (lines.length > maxLines) {
        const headCount = Math.max(1, maxLines - Math.floor(maxLines / 3));
        const tailCount = Math.max(0, maxLines - headCount - 1);
        const omitted = lines.length - headCount - tailCount;
        lines = [...lines.slice(0, headCount), `... 省略 ${omitted} 行 ...`, ...lines.slice(lines.length - tailCount)];
        truncated = true;
    }
    return { added, removed, text: lines.join("\n"), truncated };
}

// ═══════════════════════════════════════════════
//  整文件写
// ═══════════════════════════════════════════════

export interface WriteFileOptions {
    /** 内容上限（字节；缺省 WRITE_MAX_BYTES） */
    maxBytes?: number;
    /**
     * 原文件超过这个字节数就**不读、不算 diff**（缺省 2 MB）。
     * 存在的意义：1MB 上限只管新内容；目标是几百 MB 的日志/产物时，读全文 + 切行会白吃主进程内存。
     */
    diffMaxBeforeBytes?: number;
}

/** 原文件参与 diff 的大小上限（超过只写不算 diff） */
export const DIFF_MAX_BEFORE_BYTES = 2 * 1024 * 1024;

export interface FileWriteResult {
    /** 展示用路径（调用方传进来的相对路径，原样回显） */
    path: string;
    /** 实际写入字节数（含补回/剥掉的 BOM） */
    bytes: number;
    /** 新增行数；`null` = 原文件超上限未读，未统计 */
    added: number | null;
    /** 删除行数；`null` 同上 */
    removed: number | null;
    /** 是否新建（目标原本不存在） */
    isNew: boolean;
    /** 原文件有 BOM 且新内容没有 → 已补回 */
    bomKept: boolean;
    /** 原文件没有 BOM 而 content 自带 → 已剥掉（不新增 BOM） */
    bomStripped: boolean;
    /** 原文件超过 diffMaxBeforeBytes → 未读、未算 diff */
    diffSkipped: boolean;
    /** 原文件字节数（新建 = 0） */
    beforeBytes: number;
    /** unified diff 摘要文本（无变化 / 跳过时为空串） */
    diff: string;
}

/** 文件开头是否 UTF-8 BOM（只读 3 字节：大文件也不必全文读入） */
function hasBom(abs: string): boolean {
    const fd = openSync(abs, "r");
    try {
        const buf = Buffer.alloc(3);
        const n = readSync(fd, buf, 0, 3, 0);
        return n === 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    } finally {
        closeSync(fd);
    }
}

/**
 * 整文件写（原子）：新建或覆盖。
 *
 * @throws FileWriteError（空路径·不可解析 / 超限 / 目标是目录）；底层 IO 错误原样上抛
 */
export function writeFileWhole(cwd: string, relPath: string, content: string, opts: WriteFileOptions = {}): FileWriteResult {
    const target = resolveWritePath(cwd, relPath);

    let exists = false;
    let before: string | null = null;
    let beforeBytes = 0;
    let oldBom = false;
    let diffSkipped = false;
    try {
        const st = statSync(target);
        if (st.isDirectory()) {
            throw new FileWriteError({
                code: "fs/is-directory",
                message: `${relPath} 是目录（write 只写文件；要列目录用 bash ls）`,
            });
        }
        exists = true;
        beforeBytes = st.size;
        oldBom = hasBom(target);
        // 大文件只探测 BOM，不读全文（见 WriteFileOptions.diffMaxBeforeBytes）
        if (beforeBytes <= (opts.diffMaxBeforeBytes ?? DIFF_MAX_BEFORE_BYTES)) before = readFileSync(target, "utf-8");
        else diffSkipped = true;
    } catch (e) {
        if (e instanceof FileWriteError) throw e;
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    // BOM：已有文件的 BOM 状态**保持不变**（模型看不见它，不该被一次覆盖改掉）；
    // 新文件按 content 原样写（用户显式给的 BOM 不剥）。
    let finalContent = content;
    let bomKept = false;
    let bomStripped = false;
    if (exists && oldBom && !content.startsWith(BOM)) {
        finalContent = BOM + content;
        bomKept = true;
    } else if (exists && !oldBom && content.startsWith(BOM)) {
        finalContent = content.slice(1);
        bomStripped = true;
    }

    const maxBytes = opts.maxBytes ?? WRITE_MAX_BYTES;
    const bytes = Buffer.byteLength(finalContent, "utf-8");
    if (bytes > maxBytes) {
        throw new FileWriteError({
            code: "fs/content-too-large",
            message:
                `content 共 ${bytes} 字节，超过单次上限 ${maxBytes} 字节（${Math.round(maxBytes / 1024)}KB）；` +
                "请拆成多次写，或先用 write 写骨架再用 bash 追加",
        });
    }

    // 跳过 diff 时 before 是 null，但 isNew 另有判据（exists）—— 不能拿 before 反推「新建」
    const diff = diffSkipped ? null : unifiedDiff(exists ? before : null, finalContent, { path: relPath });
    writeFileAtomic(target, finalContent);
    return {
        path: relPath,
        bytes,
        added: diff?.added ?? null,
        removed: diff?.removed ?? null,
        isNew: !exists,
        bomKept,
        bomStripped,
        diffSkipped,
        beforeBytes,
        diff: diff?.text ?? "",
    };
}

/** `+N/-M`（无法统计时为 `+?/-?`）—— 回执与审计共用同一写法 */
export function countsLabel(r: Pick<FileWriteResult, "added" | "removed">): string {
    return r.added === null || r.removed === null ? "+?/-?" : `+${r.added}/-${r.removed}`;
}

/** 给模型看的回执：一行结论 + diff 摘要 */
export function formatWriteResult(r: FileWriteResult): string {
    const kb = r.bytes < 1024 ? `${r.bytes} B` : `${(r.bytes / 1024).toFixed(1)} KB`;
    const flags = `${r.isNew ? "，新建" : ""}${r.bomKept ? "，保留 BOM" : ""}${r.bomStripped ? "，剥掉 BOM" : ""}`;
    const skipped = r.diffSkipped
        ? `；原文件 ${(r.beforeBytes / 1024 / 1024).toFixed(1)} MB，diff 略`
        : "";
    const head = `写入 ${r.path}（${countsLabel(r)} 行，${kb}${flags}${skipped}）`;
    return r.diff ? `${head}\n\n${r.diff}` : head;
}
