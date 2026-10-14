// src/main/core/traffic-log.ts
// 🎯 流量日志落盘（把界面上看到的每一次请求/响应，追加到一个按天切的文件里）。
//
// 为什么要有它：内存里只留最近若干条，进程一重启就空了。有些问题（比如偶发 400）事后才想回看，
// 所以这里把每条记录顺手写一份到磁盘，重启也不丢。
//
// 放哪：`<DIY_HOME>/log/network/`，**全应用共用一个目录**（不按会话分），文件名按天切：
// `YYYY-MM-DD.jsonl`。一天一个文件，方便清理，也避免单文件无限涨大。
//
// 一行一条记录的 JSON。行首带一个格式版本 `_fmt`（形如 "1.0"）：
//   - 小版本（小数点后）只增字段 —— 老读侧遇到不认识的字段忽略即可，仍能读。
//   - 大版本（小数点前）不兼容 —— 读到不认识的大版本，直接跳过，不迁移、不报错。
//
// 每条记录在文件里的位置（文件 + 行号 + 起始字节 + 长度）会被记下来（见 LogLoc），
// 之后「打开某条记录」时按这个位置**随机读**那一小段，不必把整个文件读进来。
//
// 界面按日期/全文查历史时，走 queryRecords：一天一个文件地流式扫，不把全部内容堆进内存。

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "./state";

/** 当前写入格式版本。改结构时：加字段不动它，改语义/删字段才进位大版本。 */
export const LOG_FORMAT = "1.0";

/** 日志目录（相对 DIY_HOME 的路径） */
export const LOG_DIR_REL = "log/network";

/**
 * 一条记录落盘后的位置。
 * 界面就是靠它把「这条」定位到磁盘上的具体一处（见 `存储在` 显示与随机读）。
 * 位置格式（写进 AGENTS.md 的通用约定）：`<绝对路径>:<行>[:<列>]`。
 */
export interface LogLoc {
    /** 文件（相对 DIY_HOME，如 log/network/2026-10-13.jsonl） */
    file: string;
    /** 该条记录在文件中的起始字节 */
    offset: number;
    /** 该条记录的字节长度（含行尾换行） */
    len: number;
    /** 行号（1 起；一行 = 一条记录） */
    line: number;
    /** 绝对路径（界面直接展示 / 打开文件位置用） */
    abs: string;
}

export class TrafficLogError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TrafficLogError";
    }
}

/** 当天文件名：本地日期 YYYY-MM-DD（按天切文件，跨天自动新文件） */
export function dayFile(d = new Date()): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}.jsonl`;
}

function dirAbs(): string {
    const d = join(diyHome(), LOG_DIR_REL);
    mkdirSync(d, { recursive: true });
    return d;
}

/** 相对路径 → 绝对路径 */
export function absOf(rel: string): string {
    return join(diyHome(), rel);
}

/** 数一个文件里有多少个换行（用来续算行号，读一次即够） */
function countLines(abs: string): number {
    let n = 0;
    try {
        const buf = readFileSync(abs);
        for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
    } catch {
        return 0;
    }
    return n;
}

/** 写入器：保持当天文件的 fd 与写入位置，跨天自动切换 */
class Writer {
    private fd: number | null = null;
    private day = "";
    private pos = 0;
    private line = 0;

    private ensureFd(): void {
        const today = dayFile();
        if (this.fd !== null && this.day === today) return;
        if (this.fd !== null) closeSync(this.fd);
        const abs = join(dirAbs(), today);
        this.fd = openSync(abs, "a");
        this.day = today;
        // 续写：从现有文件末尾接着写（同一天多次写入 / 进程重启后）
        try {
            this.pos = fstatSync(this.fd).size;
            this.line = countLines(abs);
        } catch {
            this.pos = 0;
            this.line = 0;
        }
    }

    /** 追加一行，返回它在文件中的位置 */
    append(payload: unknown): LogLoc {
        this.ensureFd();
        const line = `${JSON.stringify({ _fmt: LOG_FORMAT, ...(payload as object) })}\n`;
        const buf = Buffer.from(line, "utf8");
        const offset = this.pos;
        // writeSync 允许少写（信号中断等）。写不完整就是**半行 JSON**：既读不出这条，
        // 也会把下一条粘在同一行一起废掉 —— 故循环写满，真写不满就抛（调用方置 log=null）。
        let wrote = 0;
        while (wrote < buf.length) {
            const n = writeSync(this.fd!, buf, wrote, buf.length - wrote, this.pos + wrote);
            if (n <= 0) throw new TrafficLogError(`日志写入不完整（${wrote}/${buf.length} 字节）`);
            wrote += n;
        }
        this.pos += wrote;
        this.line += 1;
        return { file: `${LOG_DIR_REL}/${this.day}`, offset, len: wrote, line: this.line, abs: join(dirAbs(), this.day) };
    }
}

const writer = new Writer();

/** 追加一条记录（调用方保证 payload 可 JSON 序列化；失败会抛，由调用方兜底） */
export function appendRecord(payload: unknown): LogLoc {
    return writer.append(payload);
}

/**
 * 按位置随机读一条记录。
 * 文件不存在 / 位置越界 / 版本不认识 → 抛 TrafficLogError（带人话原因，界面直接显示）。
 */
export function readRecord(loc: Pick<LogLoc, "file" | "offset" | "len">): Record<string, unknown> {
    if (!loc || typeof loc.file !== "string") throw new TrafficLogError("记录位置无效");
    const abs = absOf(loc.file);
    if (!existsSync(abs)) {
        throw new TrafficLogError(`日志文件已不存在：${loc.file}（可能被清理，或已被按天切走）`);
    }
    let size = 0;
    try {
        size = statSync(abs).size;
    } catch {
        throw new TrafficLogError(`日志文件读不到：${loc.file}`);
    }
    if (loc.offset < 0 || loc.len <= 0 || loc.offset + loc.len > size) {
        throw new TrafficLogError(`记录位置越界（文件 ${loc.file} 已变化）`);
    }
    const fd = openSync(abs, "r");
    try {
        const buf = Buffer.alloc(loc.len);
        const got = readSync(fd, buf, 0, loc.len, loc.offset);
        const text = buf.subarray(0, got).toString("utf8").trimEnd();
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
            throw new TrafficLogError("记录内容不是合法 JSON（文件可能损坏或被改写）");
        }
        const major = String(parsed._fmt ?? "").split(".")[0];
        if (major !== String(LOG_FORMAT).split(".")[0]) {
            throw new TrafficLogError(`记录格式版本不兼容（${String(parsed._fmt)}），已忽略`);
        }
        return parsed;
    } finally {
        closeSync(fd);
    }
}

/** 目录里现有日志文件（按名字降序 = 新日期在前） */
export function listFiles(): string[] {
    const d = join(diyHome(), LOG_DIR_REL);
    if (!existsSync(d)) return [];
    try {
        return readdirSync(d)
            .filter((f) => f.endsWith(".jsonl"))
            .sort()
            .reverse()
            .map((f) => `${LOG_DIR_REL}/${f}`);
    } catch {
        return [];
    }
}

/** 日志总体积：文件数 + 字节总数（头部「日志大小」指示用） */
export interface LogStats {
    files: number;
    bytes: number;
}

/** 数一下日志目录现有多少文件、共多少字节 */
export function logStats(): LogStats {
    const d = join(diyHome(), LOG_DIR_REL);
    if (!existsSync(d)) return { files: 0, bytes: 0 };
    try {
        const names = readdirSync(d).filter((f) => f.endsWith(".jsonl"));
        let bytes = 0;
        for (const n of names) {
            try {
                bytes += statSync(join(d, n)).size;
            } catch {
                /* 读不到就跳过这一个 */
            }
        }
        return { files: names.length, bytes };
    } catch {
        return { files: 0, bytes: 0 };
    }
}

/** 日志里出现过的日期（从文件名取，降序 = 新的在前） */
export function listDates(): string[] {
    return listFiles()
        .map((f) => (f.split("/").pop() ?? "").replace(/\.jsonl$/, ""))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
}

export type StatusFilter = "all" | "ok" | "4xx" | "5xx" | "err";

export interface QueryOpts {
    /** 全文检索关键词（匹配地址 / 方法 / 状态 / 模型 / 正文等，不区分大小写） */
    text?: string;
    /** 只查这一天（YYYY-MM-DD）；不传或 "all" = 全部日期 */
    date?: string | null;
    status?: StatusFilter;
    method?: string;
    /** 最多返回多少条（默认 1000） */
    limit?: number;
}

export interface QueryResult {
    records: Array<Record<string, unknown> & { log: LogLoc }>;
    /** 实际扫过的行数 */
    scanned: number;
    /** 实际扫过的文件（相对路径） */
    files: string[];
    /** 命中数（可能被 limit 截断，见 truncated） */
    hits: number;
    /** 是否因超过 limit 被截断 */
    truncated: boolean;
    /** 耗时 ms */
    ms: number;
}

function matchStatus(status: unknown, f: StatusFilter): boolean {
    if (f === "all") return true;
    if (f === "err") return status === null || status === undefined;
    const s = typeof status === "number" ? status : NaN;
    if (f === "ok") return s < 400;
    if (f === "4xx") return s >= 400 && s < 500;
    return s >= 500;
}

/** 把一条记录摊成一段可全文匹配的小写文本 */
function haystack(rec: Record<string, unknown>): string {
    const body = rec.reqBody as { head?: string; tail?: string } | null | undefined;
    const res = rec.resBody as { head?: string; tail?: string } | null | undefined;
    const parts: unknown[] = [
        rec.url, rec.method, rec.status, rec.host, rec.path, rec.kind,
        rec.model, rec.provider, rec.taskUri, rec.turnId, rec.traceId, rec.err, rec.resNote,
        rec.reqHeaders, rec.resHeaders, body?.head, body?.tail, res?.head, res?.tail,
    ];
    return parts
        .map((p) => (p == null ? "" : typeof p === "string" ? p : JSON.stringify(p)))
        .join("\u0000")
        .toLowerCase();
}

/**
 * 按条件在磁盘日志里查记录（界面「流量」页的数据源）。
 * 一天一个文件，流式逐行扫；命中按时间倒序（新的在前），最多返回 limit 条。
 */
export function queryRecords(opts: QueryOpts): QueryResult {
    const t0 = Date.now();
    const limit = Math.max(1, Math.min(10000, opts.limit ?? 1000));
    const want = opts.date && opts.date !== "all" ? [`${LOG_DIR_REL}/${opts.date}.jsonl`] : listFiles();
    const text = (opts.text ?? "").trim().toLowerCase();
    const wantsText = text.length > 0;
    const method = opts.method && opts.method !== "all" ? opts.method.toUpperCase() : "";
    const status = opts.status ?? "all";

    const out: Array<Record<string, unknown> & { log: LogLoc }> = [];
    let scanned = 0;
    const files: string[] = [];

    for (const rel of want) {
        const abs = absOf(rel);
        if (!existsSync(abs)) continue;
        files.push(rel);
        const buf = readFileSync(abs);
        let start = 0;
        let line = 0;
        for (let i = 0; i < buf.length; i++) {
            if (buf[i] !== 0x0a) continue;
            const end = i; // 不含换行
            const len = end - start + 1; // 含行尾换行，与写入时一致
            line += 1;
            if (len > 1) {
                scanned += 1;
                const raw = buf.subarray(start, end).toString("utf8");
                let rec: Record<string, unknown> | null = null;
                try {
                    rec = JSON.parse(raw) as Record<string, unknown>;
                } catch {
                    rec = null;
                }
                const major = rec ? String(rec._fmt ?? "").split(".")[0] : "0";
                if (rec && major === String(LOG_FORMAT).split(".")[0]) {
                    const ok =
                        (!method || String(rec.method ?? "").toUpperCase() === method) &&
                        matchStatus(rec.status, status) &&
                        (!wantsText || haystack(rec).includes(text));
                    if (ok) out.push({ ...rec, log: { file: rel, offset: start, len, line, abs } });
                }
            }
            start = i + 1;
        }
    }

    out.sort((a, b) => Number(b.ts ?? 0) - Number(a.ts ?? 0));
    const hits = out.length;
    const truncated = hits > limit;
    return { records: out.slice(0, limit), scanned, files, hits, truncated, ms: Date.now() - t0 };
}
