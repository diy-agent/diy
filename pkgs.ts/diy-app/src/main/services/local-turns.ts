// src/main/services/local-turns.ts
// 🎯 每轮结论账（`turns.jsonl`，##424 刀 1）：ops 的**降级重建材料**，不是会话真源。
//
// 为什么需要它（用户 2026-10-23~24 口径）：ops 降级为**审计日志**（可清可关是方向），
// 真正的「数据」= user message + 每步结论（assistant text）。于是每轮收口时落一条小记录：
//   · `user`  = 本轮用户原文；
//   · `texts` = 本轮**全部** assistant 正文（过程句也留 —— 「历史里看不到做过什么、
//     只剩说了什么」是用户明确要的口径；工具正文归 ops，这里不收）；
//   · `ref`   = 指回 ops 的字节锚点（该轮**第一条 op** 的行首），用于「这一轮在 ops 里是否还在」。
//
// 边界（别扩）：
//   · **旁路**：写失败只 warn，绝不影响轮末收口（见 `appendTurnRecord`）；
//   · **只写不读**（正常路径）：降级链才读它 —— 读侧见 `readTurnRecords` / `checkOpsRef` /
//     `synthesizeTurnOps`，装配在 `local-agent` 的 `degradedHistory`；
//   · 不做 prune / gzip / 折叠 / 开关（恒写）；不碰 `llm.jsonl`。
//
// 行的形状（`v` 递增用于日后演化，**v1 定死**）：
//   { v:1, turnId, at, state, user, texts:[{seq,text}], ref:{ ops:{offset,len,seq} } }
// 约定：
//   1. `offset` / `len` 一律**字节**，`len` 是**整行含换行**（一行一写天然不会切在多字节字符中间）；
//   2. `offset` 在**写侧**取（`appendFileSync` 之前的 fileSize），不改 `readOpsRange` 的解析循环；
//   3. `seq` = 该行在 `ops.jsonl` 里的 **1-based 物理行号**（与 opsFeed / UI 水位同口径），
//      只做**校验**不做定位：读回来时行号对不上 ⇒ 判定悬空；
//   4. 单条 `user` / 单条 text 超 `TURN_TEXT_MAX_BYTES` 只截断**该条**并标 `truncated` + 原字节数，
//      绝不丢整轮。
//
// `texts[].seq` 是那段正文所属 text 块 start 行的物理行号（信息位；v1 不参与定位/校验）。

import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { TextDecoder } from "node:util";
import { resolveSessionFile, turnsFile } from "../core/local-paths";
import type { Op } from "./local-blocks";

/** 单条正文（user / text）的落盘上限：超了截断该条，不丢整轮 */
export const TURN_TEXT_MAX_BYTES = 64 * 1024;

/** 当前 `turns.jsonl` 的行格式版本（变了就是一次断代，读侧只认 `v === 1`） */
export const TURN_SCHEMA_CURRENT = 1;

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

export interface TurnRecordV1 {
    v: 1;
    turnId: string;
    /** 收口时刻（ISO） */
    at: string;
    state: TurnRecordState;
    user: string;
    /** user 被截断时的原字节数（与 `texts[].truncated` 同口径；`user` 是字符串，只能挂同级） */
    userTruncated?: true;
    userBytes?: number;
    texts: TurnTextV1[];
    ref: { ops: { offset: number; len: number; seq: number } };
}

/**
 * 按字节上限截断一段正文（**不切在多字节字符中间**）。
 *
 * 为什么不是 `slice(0, N)`：`user` 与 text 里中文/emoji 很常见，按 UTF-16 索引切既不是
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

/**
 * 追加一条轮次记录（**恒写、旁路**）。
 *
 * 整段 try/catch：L3 写入失败不许影响轮末收口（body 铁律 5）。返回 false 只为测试/审计。
 */
export function appendTurnRecord(taskUri: string, rec: TurnRecordV1): boolean {
    let fp: string;
    try {
        fp = turnsFile(taskUri);
    } catch (e) {
        console.warn(`[local-turns] turns 路径解析失败（本轮照常收口）${taskUri}:`, e);
        return false;
    }
    try {
        // 轮末写在 runTurn 的**同步收尾段**里（与 compact 账 / ops sink 同一约束：生成器被
        // return 展开时只执行到第一个 yield，await 写会丢尾巴）；单行 append 不可分割。
        // sync-io-ok: 同上（轮末同步窗口内的单行 append）
        appendFileSync(fp, `${JSON.stringify(rec)}\n`, "utf-8");
        return true;
    } catch (e) {
        console.warn(`[local-turns] turns 写入失败（不影响轮末收口）${fp}:`, e);
        return false;
    }
}

/** 读全量轮次记录（坏行跳过并出声；**只认 v1**，其余当作断代不猜） */
export function readTurnRecords(taskUri: string): TurnRecordV1[] {
    const fp = resolveSessionFile(taskUri, "turns");
    if (!existsSync(fp)) return []; // sync-io-ok: 降级路径专用（ops 坏掉才会走到，冷路径）
    let text: string;
    try {
        text = readFileSync(fp, "utf-8"); // sync-io-ok: 同上，降级路径专用（正常路径不读 turns）
    } catch (e) {
        console.warn(`[local-turns] turns 读取失败 ${fp}:`, e);
        return [];
    }
    const out: TurnRecordV1[] = [];
    for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
            const rec = JSON.parse(t) as TurnRecordV1;
            if (rec && rec.v === TURN_SCHEMA_CURRENT && typeof rec.turnId === "string" && rec.ref?.ops) out.push(rec);
        } catch (e) {
            console.warn(`[local-turns] 跳过无法解析的 turns 行 ${fp}:`, String(e).slice(0, 120));
        }
    }
    return out;
}

/** ref 悬空的三种原因（body 刀 2 §3）：文件缺失 / 越界 / 行号对不上（含内容不符） */
export type OpsRefReason = "missing" | "range" | "seq";

export type OpsRefCheck = { ok: true } | { ok: false; reason: OpsRefReason };

/** 读到的字节区间是否以换行结尾（= 恰好一整行；起点行首另由 `checkOpsRef` 校） */
function endsWithNewline(buf: Buffer): boolean {
    return buf.length > 0 && buf[buf.length - 1] === 0x0a;
}

/** `[0, offset)` 里有几个换行 ⇒ 该字节所在行的 1-based 行号（降级路径才走，成本 = 一次顺序读） */
function lineNumberAt(fp: string, offset: number): number {
    if (offset <= 0) return 1;
    const CHUNK = 256 * 1024;
    // sync-io-ok: `lineNumberAt` 只在降级路径的 ref 校验里调（冷、低频，且调用方是同步 API）
    const fd = openSync(fp, "r");
    try {
        const buf = Buffer.allocUnsafe(CHUNK);
        let pos = 0;
        let n = 0;
        while (pos < offset) {
            const want = Math.min(CHUNK, offset - pos);
            // sync-io-ok: 同上一行（降级路径 ref 校验的块读）
            const got = readSync(fd, buf, 0, want, pos);
            if (got <= 0) break;
            for (let i = 0; i < got; i++) if (buf[i] === 0x0a) n++;
            pos += got;
        }
        return n + 1;
    } finally {
        closeSync(fd); // sync-io-ok: 与上面同一个 open/close 对
    }
}

function byteAt(fp: string, at: number): number {
    // sync-io-ok: 单字节边界校验，只在降级路径 ref 校验里调（冷、低频）
    const fd = openSync(fp, "r");
    try {
        const b = Buffer.allocUnsafe(1);
        if (readSync(fd, b, 0, 1, at) !== 1) return -1; // sync-io-ok: 同上一行（单字节）
        return b[0];
    } finally {
        closeSync(fd); // sync-io-ok: 与上面同一个 open/close 对
    }
}

function readRange(fp: string, offset: number, len: number): Buffer {
    // sync-io-ok: 读一条 op 行的字节区间，只在降级路径 ref 校验里调（冷、低频）
    const fd = openSync(fp, "r");
    try {
        const buf = Buffer.allocUnsafe(len);
        let got = 0;
        while (got < len) {
            // sync-io-ok: 同上一行（一段不超过一行的字节）
            const n = readSync(fd, buf, got, len - got, offset + got);
            if (n <= 0) break;
            got += n;
        }
        return buf.subarray(0, got);
    } finally {
        closeSync(fd); // sync-io-ok: 与上面同一个 open/close 对
    }
}

/**
 * 校验一条记录的 ops 锚点（body 刀 2 §3 的三种悬空）。
 *
 * 判据是**证据**而不是猜测：
 *   ① ops 文件不存在 / 读不到 ⇒ `missing`；
 *   ② `offset + len` 越界（文件被截断 / 换了一份更短的）⇒ `range`；
 *   ③ 区间不是完整一行、解不出 op、或解出的行号 ≠ 记录值 ⇒ `seq`。
 *      （内容不符也归这一类：能读但**不是那一行**，对调用方是同一个结论。）
 */
export function checkOpsRef(taskUri: string, rec: TurnRecordV1): OpsRefCheck {
    const { offset, len, seq } = rec.ref?.ops ?? ({} as TurnRecordV1["ref"]["ops"]);
    if (![offset, len, seq].every((n) => Number.isInteger(n) && n >= 0) || len <= 0) {
        return { ok: false, reason: "range" };
    }
    const fp = resolveSessionFile(taskUri, "ops");
    let size: number;
    try {
        size = statSync(fp).size; // sync-io-ok: 一次 stat，降级路径专用（正常路径根本进不来）
    } catch {
        return { ok: false, reason: "missing" };
    }
    if (offset + len > size) return { ok: false, reason: "range" };
    // 行首校验：offset 必须是行首（前一个字节是换行），否则区间跨行/落在字符中间
    if (offset > 0 && byteAt(fp, offset - 1) !== 0x0a) return { ok: false, reason: "seq" };
    const buf = readRange(fp, offset, len);
    if (!endsWithNewline(buf)) return { ok: false, reason: "seq" };
    let op: Op | null = null;
    try {
        op = JSON.parse(buf.subarray(0, buf.length - 1).toString("utf-8")) as Op;
    } catch {
        return { ok: false, reason: "seq" };
    }
    // 该轮第一条 op 必是 turn 的 start：内容对不上 = 文件被换过，与「行号对不上」同价
    if (!op || op.op !== "start" || op.id !== rec.turnId || op.kind !== "turn") return { ok: false, reason: "seq" };
    let line: number;
    try {
        line = lineNumberAt(fp, offset);
    } catch {
        return { ok: false, reason: "missing" };
    }
    if (line !== seq) return { ok: false, reason: "seq" };
    return { ok: true };
}

/**
 * 把一条轮次记录折成**只读文本历史**（ops 形态，渲染端零改动即可显示）。
 *
 * 形态：`turn` 块 → user text 块 → assistant text 块（`texts` 拼接）→ 一条 `degraded` patch → stop。
 * `degraded` 字段挂在 turn 上（见 `local-blocks` 的 turn schema），UI 据此在行内写「原始记录已清理」。
 */
export function synthesizeTurnOps(rec: TurnRecordV1, dangling: boolean): Op[] {
    const turnId = rec.turnId;
    const ops: Op[] = [{ op: "start", id: turnId, kind: "turn", meta: { degradedSource: "turns" } }];
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
        fields: {
            degraded: {
                refDangling: dangling,
                state: rec.state,
                at: rec.at,
            },
        },
    });
    ops.push({ op: "stop", id: turnId });
    return ops;
}
