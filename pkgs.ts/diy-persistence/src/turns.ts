// src/turns.ts
// 🎯 每轮结论账 + **压缩边界**（`turns.jsonl`，##424 / ##432）：会话持久化包对 core 的窄接口。
//
// 为什么它在包里（##432 刀 1）：这一行的 `ref` 是 **ops 行号的锚点**（`{offset,len,seq}`），
// 而「turns 的一行指向 ops 的哪一行」是**存储知识**，不该泄漏给 core。于是：
//   · **写 ops** 与写 turns 在同一处（`createOpsAppender` / `appendTurn`），core 只说「追加一条 op」；
//   · 压缩边界（`commitBoundary` / `boundary`）也落在这里 —— 「历史从哪开始」是一次**事件**，
//     不是每步的重新决策（##432 刀 2）。
//
// 边界（别扩）：
//   · **旁路**：写失败只 warn，绝不影响轮末收口；
//   · `turns.jsonl` 只写不读（正常路径）：降级链与压缩边界才读它；
//   · 不做 prune / gzip / 折叠 / 开关（恒写）；不碰 `llm.jsonl`。
//
// ── 行形状（v2；v1 = ##424 的轮次记录，v2 加 `kind` 与 compaction entry）──
//   轮次记录：{ v:1, turnId, at, state, user, texts:[{seq,text}], ref:{ ops:{offset,len,seq} } }
//   压缩边界：{ v:2, kind:"compaction", at, limitTokens, dropped, headLine, cut:{ llmLine, turnId }, ref?:{ ops:{offset,seq} } }
// 约定：
//   1. `offset` / `len` 一律**字节**，`len` 是**整行含换行**；
//   2. `offset` 在**写侧**取（append 之前的 fileSize）；
//   3. `seq` = 该行在 `ops.jsonl` 里的 **1-based 物理行号**（与 opsFeed / UI 水位同口径），
//      只做**校验**不做定位：读回来时行号对不上 ⇒ 判定悬空；
//   4. 单条 `user` / 单条 text 超 `TURN_TEXT_MAX_BYTES` 只截断**该条**并标 `truncated` + 原字节数。

import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { TextDecoder } from "node:util";
import { opsFile, resolveSessionFile, turnsFile } from "./paths";

/** 单条正文（user / text）的落盘上限：超了截断该条，不丢整轮 */
export const TURN_TEXT_MAX_BYTES = 64 * 1024;

/** 当前 `turns.jsonl` 的行格式版本（变了就是一次断代：v1 轮次记录 + v2 压缩边界） */
export const TURN_SCHEMA_CURRENT = 2;

/** ops 里的字节锚点（一条 op 行的物理位置） */
export interface OpsRef {
    /** 行首字节偏移 */
    offset: number;
    /** 整行字节数（含换行） */
    len: number;
    /** 1-based 物理行号 */
    seq: number;
}

export type TurnRecordState = "ok" | "interrupted" | "error";

export interface TurnTextV1 {
    /** 该段正文所属 text 块 start 行的物理行号（1-based；信息位） */
    seq: number;
    text: string;
    /** 该条被截断（超 `TURN_TEXT_MAX_BYTES`） */
    truncated?: true;
    /** 截断前的原字节数（`truncated` 时才有） */
    bytes?: number;
}

export interface TurnRecord {
    v: 1;
    turnId: string;
    /** 收口时刻（ISO） */
    at: string;
    state: TurnRecordState;
    user: string;
    /** user 被截断时的原字节数 */
    userTruncated?: true;
    userBytes?: number;
    texts: TurnTextV1[];
    ref: { ops: OpsRef };
}

/**
 * **压缩边界**（##432 刀 2）：压缩事件发生时算一次切点，之后每步只读它。
 *
 * `cut.llmLine` = 切点在全量投影（llm.jsonl）里的 1-based 行号 —— 它之前的消息被丢弃；
 * `cut.turnId` = 切点所在那轮的 id（下一轮 ops replay 的起点优化用；null = 拿不到）。
 */
export interface CompactionEntry {
    v: 2;
    kind: "compaction";
    /** 压缩发生时刻（ISO） */
    at: string;
    /** 单条上限（token；字符数 / 4 的粗估口径） */
    limitTokens: number;
    /** 这次丢弃的消息条数（不含保头） */
    dropped: number;
    /** 保头的最后一条消息行号（1-based，含） —— 它及其之前永远保留（##432：保头 600 token） */
    headLine: number;
    cut: { llmLine: number; turnId: string | null };
    /** 切点那一轮的 ops 锚点（可选；用于下次 replay 少读前缀） */
    ref?: { ops: { offset: number; seq: number } };
}

export type TurnEntry = TurnRecord | CompactionEntry;

/** 一条轮的正文段（写侧输入；`ref` 由 `appendOp` 的返回值给出） */
export interface TurnDraft {
    turnId: string;
    at: string;
    state: TurnRecordState;
    user: string;
    /** user 被截断时的原字节数（与 `texts[].truncated` 同口径） */
    userTruncated?: true;
    userBytes?: number;
    texts: TurnTextV1[];
    /** 该轮第一条 op 的锚点（写侧由 `createOpsAppender().append` 取得） */
    refFirstOp: OpsRef;
}

/**
 * 按字节上限截断一段正文（**不切在多字节字符中间**）。
 *
 * 为什么不是 `slice(0, N)`：user 与 text 里中文/emoji 很常见，按 UTF-16 索引切既不是
 * 「64KB 字节」的口径，也可能切出半个代理对。这里按 Buffer 字节切，再回退最多 3 个字节
 * 到合法字符边界。
 */
export function clipTurnText(raw: string): { text: string; truncated?: true; bytes?: number } {
    const bytes = Buffer.byteLength(raw, "utf-8");
    if (bytes <= TURN_TEXT_MAX_BYTES) return { text: raw };
    const buf = Buffer.from(raw, "utf-8").subarray(0, TURN_TEXT_MAX_BYTES);
    for (let back = 0; back < 4 && back < buf.length; back++) {
        try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, buf.length - back));
            return { text, truncated: true, bytes };
        } catch {
            /* 落在字符中间：再退一个字节 */
        }
    }
    return { text: new TextDecoder().decode(buf), truncated: true, bytes };
}

function appendLine(fp: string, row: unknown, label: string): boolean {
    try {
        // 轮末写在本轮的**同步收尾段**里（与 compact 账 / ops sink 同一约束）；单行 append 不可分割。
        // sync-io-ok: 轮末同步窗口内的单行 append
        appendFileSync(fp, `${JSON.stringify(row)}\n`, "utf-8");
        return true;
    } catch (e) {
        console.warn(`[persistence] ${label} 写入失败（不影响会话）${fp}:`, e);
        return false;
    }
}

/** 追加一条轮次记录（**恒写、旁路**）；写失败只 warn。 */
export function appendTurnRecord(home: string, taskUri: string, draft: TurnDraft | TurnRecord): boolean {
    // 兼容两种输入：完整记录（测试 / 迁移）与草稿（生产：ref 由写入器给）
    const rec: TurnRecord =
        "v" in draft
            ? draft
            : (() => {
                  const user = clipTurnText(draft.user);
                  return {
        v: 1,
        turnId: draft.turnId,
        at: draft.at,
        state: draft.state,
        user: user.text,
        ...(user.truncated || draft.userTruncated ? { userTruncated: true as const } : {}),
        ...((user.bytes ?? draft.userBytes) !== undefined ? { userBytes: user.bytes ?? draft.userBytes } : {}),
        texts: draft.texts,
        ref: { ops: draft.refFirstOp },
    };
              })();
    let fp: string;
    try {
        fp = turnsFile(home, taskUri);
    } catch (e) {
        console.warn(`[persistence] turns 路径解析失败（本轮照常收口）${taskUri}:`, e);
        return false;
    }
    return appendLine(fp, rec, "turns");
}

/** 追加一条**压缩边界**（##432；写失败只 warn —— 边界丢了顶多下次再压一次）。 */
export function appendCompactionEntry(
    home: string,
    taskUri: string,
    entry: Omit<CompactionEntry, "v" | "kind">,
): boolean {
    const rec: CompactionEntry = { v: 2, kind: "compaction", ...entry };
    let fp: string;
    try {
        fp = turnsFile(home, taskUri);
    } catch (e) {
        console.warn(`[persistence] turns 路径解析失败（压缩边界未落盘）${taskUri}:`, e);
        return false;
    }
    return appendLine(fp, rec, "turns(compaction)");
}

/** 读全量 turns 行（坏行跳过并出声；只认已知版本） */
export function readTurnEntries(home: string, taskUri: string): TurnEntry[] {
    const fp = resolveSessionFile(home, taskUri, "turns");
    if (!existsSync(fp)) return []; // sync-io-ok: 降级 / 边界路径专用（冷路径）
    let text: string;
    try {
        text = readFileSync(fp, "utf-8"); // sync-io-ok: 同上（正常路径不读 turns）
    } catch (e) {
        console.warn(`[persistence] turns 读取失败 ${fp}:`, e);
        return [];
    }
    const out: TurnEntry[] = [];
    for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
            const rec = JSON.parse(t) as TurnEntry;
            if (isCompaction(rec)) {
                if (rec.v === 2) out.push(rec);
            } else if (rec && rec.v === 1 && typeof rec.turnId === "string" && rec.ref?.ops) {
                out.push(rec);
            }
        } catch (e) {
            console.warn(`[persistence] 跳过无法解析的 turns 行 ${fp}:`, String(e).slice(0, 120));
        }
    }
    return out;
}

function isCompaction(rec: unknown): rec is CompactionEntry {
    return typeof rec === "object" && rec !== null && (rec as { kind?: unknown }).kind === "compaction";
}

/** 只取轮次记录（降级重建用） */
export function readTurnRecords(home: string, taskUri: string): TurnRecord[] {
    return readTurnEntries(home, taskUri).filter((e): e is TurnRecord => !isCompaction(e));
}

/**
 * **当前生效的压缩边界**：turns 里最后一条 compaction entry（append-only ⇒ 后者覆盖前者）。
 * 没有 ⇒ `null`（= 从未压缩，全量投递）。
 */
export function readBoundary(home: string, taskUri: string): CompactionEntry | null {
    const entries = readTurnEntries(home, taskUri);
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]!;
        if (isCompaction(e)) return e;
    }
    return null;
}

// ─── ops 写入（turns 的 ref 由它产出，故与 turns 同一包）──────────────────

/** 一条 op 的落盘记账（写侧产出，供轮末的 turns.ref 使用） */
export interface OpsAppender {
    /** 追加一行 op；返回它的字节锚点。写失败返回 `null`（不阻断流）。 */
    append(op: unknown): OpsRef | null;
    /** 最近一次成功 append 的锚点（`turns` 的 `refFirstOp` 就取它；还没写过 = null） */
    lastRef(): OpsRef | null;
    /** 当前文件大小（调试 / 边界记账用） */
    size(): number;
}

/**
 * 创建 ops 追加器（每个会话一个）：内部缓存「文件大小 + 行号」，避免每条 op 一次 stat。
 *
 * ⚠️ 缓存只在本进程内有效：其他进程写同一文件时它会落后。这是**既有语义**（ops 是单写者），
 * 且 `size()` 回退到实时 stat 可自证 —— 若将来多写者，这里要改成「写前 stat 校验」。
 */
export function createOpsAppender(home: string, taskUri: string): OpsAppender {
    let fp: string | null = null;
    let offset = 0;
    let seq = 0;
    let lineStart = -1;
    let last: OpsRef | null = null;

    const ensure = (): string => {
        if (fp) return fp;
        fp = opsFile(home, taskUri);
        try {
            offset = statSync(fp).size; // sync-io-ok: 追加器初始化一次（每会话一次）
        } catch {
            offset = 0;
        }
        seq = 0;
        if (offset > 0) {
            // 行号 = 已有换行数 + 1（一次顺序读；每会话一次）
            seq = countNewlines(fp);
            try {
                lineStart = lastByte(fp); // sync-io-ok: 一次单字节读
            } catch {
                lineStart = -1;
            }
            if (lineStart !== 0x0a) {
                // 文件尾不是换行（半行）：当下一行从当前位置开始，行号仍 +1（不合并）
                lineStart = offset - 1;
            }
        }
        return fp;
    };

    return {
        append(op: unknown): OpsRef | null {
            const file = ensure();
            const line = `${JSON.stringify(op)}\n`;
            const len = Buffer.byteLength(line, "utf-8");
            const at = offset;
            try {
                // sync-io-ok: op 即传即落的单行 append（与改动前同一个写点）
                appendFileSync(file, line, "utf-8");
            } catch (e) {
                console.error(`[persistence] ops 落盘失败 ${file}:`, e);
                return null;
            }
            offset += len;
            seq += 1;
            last = { offset: at, len, seq };
            return last;
        },
        lastRef(): OpsRef | null {
            return last;
        },
        size(): number {
            try {
                return statSync(opsFile(home, taskUri)).size; // sync-io-ok: 边界记账一次（低频）
            } catch {
                return offset;
            }
        },
    };
}

function countNewlines(fp: string): number {
    const CHUNK = 256 * 1024;
    let n = 0;
    try {
        const fd = openSync(fp, "r"); // sync-io-ok: 追加器初始化（每会话一次）
        try {
            const buf = Buffer.allocUnsafe(CHUNK);
            let got: number;
            while ((got = readSync(fd, buf, 0, CHUNK, null)) > 0) {
                for (let i = 0; i < got; i++) if (buf[i] === 0x0a) n++;
            }
        } finally {
            closeSync(fd); // sync-io-ok: 同一 open/close 对
        }
    } catch {
        return 0;
    }
    return n;
}

function lastByte(fp: string): number {
    const size = statSync(fp).size; // sync-io-ok: 追加器初始化（一次）
    if (size <= 0) return -1;
    const fd = openSync(fp, "r"); // sync-io-ok: 同上
    try {
        const b = Buffer.allocUnsafe(1);
        // sync-io-ok: 单字节读，仅初始化时一次
        return readSync(fd, b, 0, 1, size - 1) === 1 ? b[0]! : -1;
    } finally {
        closeSync(fd); // sync-io-ok: 同一 open/close 对
    }
}

// ─── 降级链（ops 读不出明细时的重建材料，##424）──────────────────────────

/** ref 悬空的三种原因：文件缺失 / 越界 / 行号对不上（含内容不符） */
export type OpsRefReason = "missing" | "range" | "seq";

export type OpsRefCheck = { ok: true } | { ok: false; reason: OpsRefReason };

/** 读到的字节区间是否以换行结尾（= 恰好一整行） */
function endsWithNewline(buf: Buffer): boolean {
    return buf.length > 0 && buf[buf.length - 1] === 0x0a;
}

/** `[0, offset)` 里有几个换行 ⇒ 该字节所在行的 1-based 行号 */
function lineNumberAt(fp: string, offset: number): number {
    if (offset <= 0) return 1;
    const CHUNK = 256 * 1024;
    // sync-io-ok: 只在降级路径的 ref 校验里调（冷、低频，且调用方是同步 API）
    const fd = openSync(fp, "r");
    try {
        const buf = Buffer.allocUnsafe(CHUNK);
        let pos = 0;
        let n = 0;
        while (pos < offset) {
            const want = Math.min(CHUNK, offset - pos);
            // sync-io-ok: 降级路径 ref 校验的块读
            const got = readSync(fd, buf, 0, want, pos);
            if (got <= 0) break;
            for (let i = 0; i < got; i++) if (buf[i] === 0x0a) n++;
            pos += got;
        }
        return n + 1;
    } finally {
        closeSync(fd); // sync-io-ok: 同一 open/close 对
    }
}

function byteAt(fp: string, at: number): number {
    // sync-io-ok: 单字节边界校验，只在降级路径 ref 校验里调（冷、低频）
    const fd = openSync(fp, "r");
    try {
        const b = Buffer.allocUnsafe(1);
        if (readSync(fd, b, 0, 1, at) !== 1) return -1; // sync-io-ok: 单字节
        return b[0]!;
    } finally {
        closeSync(fd); // sync-io-ok: 同一 open/close 对
    }
}

function readRange(fp: string, offset: number, len: number): Buffer {
    // sync-io-ok: 读一条 op 行的字节区间，只在降级路径 ref 校验里调（冷、低频）
    const fd = openSync(fp, "r");
    try {
        const buf = Buffer.allocUnsafe(len);
        let got = 0;
        while (got < len) {
            // sync-io-ok: 一段不超过一行的字节
            const n = readSync(fd, buf, got, len - got, offset + got);
            if (n <= 0) break;
            got += n;
        }
        return buf.subarray(0, got);
    } finally {
        closeSync(fd); // sync-io-ok: 同一 open/close 对
    }
}

/**
 * 校验一条记录的 ops 锚点（三种悬空）：
 *   ① ops 文件不存在 / 读不到 ⇒ `missing`；
 *   ② `offset + len` 越界 ⇒ `range`；
 *   ③ 区间不是完整一行、解不出 op、或解出的行号 ≠ 记录值 ⇒ `seq`。
 */
export function checkOpsRef(home: string, taskUri: string, arg: OpsRef | TurnRecord): OpsRefCheck {
    // 兼容两种输入：锚点本身 / 一整条轮次记录（测试常用后者）
    const ref = "ref" in arg ? arg.ref.ops : arg;
    const { offset, len, seq } = ref;
    if (![offset, len, seq].every((n) => Number.isInteger(n) && n >= 0) || len <= 0) {
        return { ok: false, reason: "range" };
    }
    const fp = resolveSessionFile(home, taskUri, "ops");
    let size: number;
    try {
        size = statSync(fp).size; // sync-io-ok: 一次 stat，降级路径专用
    } catch {
        return { ok: false, reason: "missing" };
    }
    if (offset + len > size) return { ok: false, reason: "range" };
    if (offset > 0 && byteAt(fp, offset - 1) !== 0x0a) return { ok: false, reason: "seq" };
    const buf = readRange(fp, offset, len);
    if (!endsWithNewline(buf)) return { ok: false, reason: "seq" };
    type OpLine = { op?: unknown; id?: unknown; kind?: unknown };
    let op: OpLine | null = null;
    try {
        op = JSON.parse(buf.subarray(0, buf.length - 1).toString("utf-8")) as OpLine;
    } catch {
        return { ok: false, reason: "seq" };
    }
    // 该轮第一条 op 必是 turn 的 start：内容对不上 = 文件被换过，与「行号对不上」同价
    if (!op || op.op !== "start" || op.id === undefined || op.kind !== "turn") return { ok: false, reason: "seq" };
    let line: number;
    try {
        line = lineNumberAt(fp, offset);
    } catch {
        return { ok: false, reason: "missing" };
    }
    if (line !== seq) return { ok: false, reason: "seq" };
    return { ok: true };
}

/** 折成只读文本历史时用的最小 op 形状（避免包依赖 core 的 Op 类型） */
export interface TurnOp {
    op: string;
    id: string;
    kind?: string;
    parent?: string;
    fields?: Record<string, unknown>;
    meta?: Record<string, unknown>;
}

/**
 * 把一条轮次记录折成**只读文本历史**（ops 形态，渲染端零改动即可显示）。
 *
 * 形态：`turn` 块 → user text 块 → assistant text 块（`texts` 拼接）→ 一条 `degraded` patch → stop。
 */
export function synthesizeTurnOps(rec: TurnRecord, dangling: boolean): TurnOp[] {
    const turnId = rec.turnId;
    const ops: TurnOp[] = [{ op: "start", id: turnId, kind: "turn", meta: { degradedSource: "turns" } }];
    const pushText = (id: string, role: "user" | "assistant", content: string): void => {
        if (!content) return;
        ops.push(
            { op: "start", id, kind: "text", parent: turnId, meta: { role } },
            { op: "delta", id, fields: { content } },
            { op: "stop", id },
        );
    };
    pushText(`${turnId}_u`, "user", rec.user);
    // 正文之间用空行分隔：它们是不同步/不同块的结论，粘成一段会读成一句话
    pushText(`${turnId}_a`, "assistant", rec.texts.map((t) => t.text).join("\n\n"));
    ops.push({
        op: "patch",
        id: turnId,
        fields: { degraded: { refDangling: dangling, state: rec.state, at: rec.at } },
    });
    ops.push({ op: "stop", id: turnId });
    return ops;
}
