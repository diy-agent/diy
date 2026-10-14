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
// 每条记录在文件里的位置（文件 + 起始字节 + 长度）会被记下来（见 TrafficRecord.log），
// 之后「打开某条记录」时按这个位置**随机读**那一小段，不必把整个文件读进来。

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "./state";

/** 当前写入格式版本。改结构时：加字段不动它，改语义/删字段才进位大版本。 */
export const LOG_FORMAT = "1.0";

/** 日志目录（相对 DIY_HOME 的路径） */
export const LOG_DIR_REL = "log/network";

/** 一条记录落盘后的位置（文件路径相对 DIY_HOME；offset/len 为字节） */
export interface LogLoc {
    file: string;
    offset: number;
    len: number;
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

/** 写入器：保持当天文件的 fd 与写入位置，跨天自动切换 */
class Writer {
    private fd: number | null = null;
    private day = "";
    private pos = 0;

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
        } catch {
            this.pos = 0;
        }
    }

    /** 追加一行，返回它在文件中的位置 */
    append(payload: unknown): LogLoc {
        this.ensureFd();
        const line = `${JSON.stringify({ _fmt: LOG_FORMAT, ...(payload as object) })}\n`;
        const buf = Buffer.from(line, "utf8");
        const offset = this.pos;
        const wrote = writeSync(this.fd!, buf, 0, buf.length, this.pos);
        this.pos += wrote;
        return { file: `${LOG_DIR_REL}/${this.day}`, offset, len: wrote };
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
export function readRecord(loc: LogLoc): Record<string, unknown> {
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

/** 目录里现有日志文件（按名字升序），供清理界面将来使用 */
export function listFiles(): string[] {
    const d = join(diyHome(), LOG_DIR_REL);
    if (!existsSync(d)) return [];
    try {
        return readdirSync(d)
            .filter((f) => f.endsWith(".jsonl"))
            .sort()
            .map((f) => `${LOG_DIR_REL}/${f}`);
    } catch {
        return [];
    }
}
