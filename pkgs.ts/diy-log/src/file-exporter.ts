// file-exporter.ts — `FileLogRecordExporter`：把 OTel LogRecord 写成 **一行一条** 的 jsonl 文件。
//
// 自研部分只在这里（##482 2026-10-30 裁决）：日志 API 用 OTel，本包只负责「落盘 + 轮转」。
//
//   <dir>/2026-10-31.log       当天（jsonl）
//   <dir>/2026-10-31.log.1     超 maxBytes 滚出来的历史（数字越大越旧）
//   <dir>/2026-10-31.log.2
//
// 写入模型：
//   · 每次 export 同步把记录**有界化**成一行，再入队；
//   · 队列串行 appendFile —— 顺序与 export 顺序一致，不交错半行；
//   · 写盘失败不抛（日志是旁路）：onError + resultCallback({code: FAILED})，队列继续。
//
// 为什么本文件不 import OTel 的 SDK 包：判据 2 要求 `pkgs.ts/*/src` 里 grep SDK 包名 = 0。
// 本类按 `LogRecordExporter` 的**结构**实现（export / shutdown / forceFlush），
// 装配层把它传给 `new BatchLogRecordProcessor({ exporter })` 时由 TS 做兼容性校验。

import { Buffer } from 'node:buffer';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { localISOString } from '@diy-agent/time';
import { LogError } from './errors.js';
import { dayKey, pruneDays, rotateFiles } from './rotate.js';
import { bodyToMessage, sanitizeData, splitException, truncateText } from './sanitize.js';
import type {
    ExportedLogRecord,
    ExportResultCallback,
    FileExporterOptions,
    FileLogEntry,
    RotateOptions,
} from './types.js';

/** 缺省轮转：10 MB 一份、留 5 份历史、留最近 14 天（与 ##482 body 的例子一致） */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_MAX_DAYS = 14;
const DEFAULT_MAX_DATA_BYTES = 4096;
/** 单条记录的兜底上限（有界化之后仍超 ⇒ 再砍 data / 栈 / msg） */
const MAX_RECORD_BYTES = 16 * 1024;

/** OTel `ExportResultCode`（0 = SUCCESS / 1 = FAILED）；不 import sdk 类型，用等价字面量 */
const EXPORT_SUCCESS = 0;
const EXPORT_FAILED = 1;

interface ResolvedOptions {
    readonly dir: string;
    readonly maxBytes: number;
    readonly maxFiles: number;
    readonly maxDays: number;
    readonly maxDataBytes: number;
    readonly onError: (error: unknown) => void;
}

function defaultOnError(error: unknown): void {
    try {
        const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        process.stderr.write(`[diy-log] 写日志失败：${text}\n`);
    } catch {
        // 连 stderr 都写不了就放弃：日志自身不许把 app 带崩
    }
}

function limitOf(value: unknown, fallback: number, name: string, { allowZero = true } = {}): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new LogError('log/invalid-options', `${name} 必须是 ≥0 的有限数字`, String(value));
    }
    if (!allowZero && value === 0) {
        throw new LogError('log/invalid-options', `${name} 必须 > 0`, String(value));
    }
    return value;
}

function resolveOptions(options: FileExporterOptions): ResolvedOptions {
    if (typeof options.dir !== 'string' || options.dir.trim() === '') {
        throw new LogError('log/invalid-options', 'dir 必填（日志目录）');
    }
    const rotate: RotateOptions = options.rotate ?? {};
    return {
        dir: options.dir,
        maxBytes: limitOf(rotate.maxBytes, DEFAULT_MAX_BYTES, 'rotate.maxBytes'),
        maxFiles: Math.floor(limitOf(rotate.maxFiles, DEFAULT_MAX_FILES, 'rotate.maxFiles')),
        maxDays: Math.floor(limitOf(rotate.maxDays, DEFAULT_MAX_DAYS, 'rotate.maxDays')),
        maxDataBytes: limitOf(options.maxDataBytes, DEFAULT_MAX_DATA_BYTES, 'maxDataBytes', { allowZero: false }),
        onError: options.onError ?? defaultOnError,
    };
}

/** hrTime（[秒, 纳秒]）→ Date（OTel 的记录时间，不是 export 时刻） */
function hrTimeToDate(hrTime: readonly [number, number]): Date {
    const [seconds, nanos] = hrTime;
    return new Date(seconds * 1000 + Math.floor(nanos / 1_000_000));
}

/** 级别名：优先 severityText（child 句柄写的就是 debug/info/warn/error），否则按 SeverityNumber 归并 */
function levelOf(record: ExportedLogRecord): string {
    const text = record.severityText?.trim().toLowerCase();
    if (text !== undefined && text !== '') return text;
    const number = record.severityNumber ?? 0;
    if (number <= 4) return 'debug';
    if (number <= 8) return 'debug';
    if (number <= 12) return 'info';
    if (number <= 16) return 'warn';
    if (number <= 20) return 'error';
    return 'fatal';
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/i;
const SPAN_ID_RE = /^[0-9a-f]{16}$/i;

function validSpanContext(
    spanContext: ExportedLogRecord['spanContext'],
): { trace_id: string; span_id: string } | undefined {
    if (spanContext === undefined) return undefined;
    const { traceId, spanId } = spanContext;
    if (!TRACE_ID_RE.test(traceId) || /^0+$/.test(traceId)) return undefined;
    if (!SPAN_ID_RE.test(spanId) || /^0+$/.test(spanId)) return undefined;
    return { trace_id: traceId, span_id: spanId };
}

/** 一条 OTel 记录 → 落盘 entry（err / data / trace 都在这里定形） */
function toEntry(record: ExportedLogRecord, at: Date, maxDataBytes: number): FileLogEntry {
    const { rest, err } = splitException(record.attributes ?? {});
    const data = sanitizeData(rest, maxDataBytes);
    const span = validSpanContext(record.spanContext);
    return {
        at: localISOString(at),
        level: levelOf(record),
        source: record.instrumentationScope?.name ?? 'unknown',
        msg: bodyToMessage(record.body),
        ...(data === undefined ? {} : { data }),
        ...(err === undefined ? {} : { err }),
        ...(span === undefined ? {} : span),
    };
}

/** entry → 一行（保证 ≤ MAX_RECORD_BYTES；超了先砍 data / 栈 / msg） */
function buildLine(entry: FileLogEntry): string {
    const line = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(line, 'utf8') <= MAX_RECORD_BYTES) return line;

    const bytes = entry.data === undefined ? 0 : Buffer.byteLength(JSON.stringify(entry.data), 'utf8');
    const squeezed: FileLogEntry = {
        ...entry,
        msg: truncateText(entry.msg, 200),
        ...(entry.data === undefined ? {} : { data: { truncated: true, bytes } }),
        ...(entry.err === undefined
            ? {}
            : {
                  err: {
                      name: truncateText(entry.err.name, 100),
                      message: truncateText(entry.err.message, 200),
                      ...(entry.err.cause === undefined ? {} : { cause: truncateText(entry.err.cause, 100) }),
                  },
              }),
    };
    const second = `${JSON.stringify(squeezed)}\n`;
    if (Buffer.byteLength(second, 'utf8') <= MAX_RECORD_BYTES) return second;

    // 极端兜底：保结构、丢内容（正常路径到不了这里）
    return `${JSON.stringify({ at: entry.at, level: entry.level, source: entry.source, msg: '<record truncated>' })}\n`;
}

async function fileSize(file: string): Promise<number> {
    try {
        return (await stat(file)).size;
    } catch (error) {
        if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            return 0;
        }
        throw error;
    }
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

/**
 * OTel 日志导出器：jsonl + 按天切 + 按大小轮转。
 *
 * @example
 *   // 装配层（apps 的 main.ts）：
 *   const exporter = new FileLogRecordExporter({ dir: join(home, 'log', 'app') });
 *   const provider = new LoggerProvider({
 *       processors: [new BatchLogRecordProcessor({ exporter })],
 *   });
 *   logs.setGlobalLoggerProvider(provider);
 */
export class FileLogRecordExporter {
    private readonly options: ResolvedOptions;
    /** 当前文件名对应的本地日期（跨天时重置 prepared / size） */
    private day?: string;
    /** 当前文件已写字节数（缓存：避免每条都 stat） */
    private size = 0;
    /** 目录 + 当天文件是否已探测过（mkdir / 按天清理 / 读初始 size） */
    private prepared = false;
    private closed = false;
    /** 串行写链（两侧都 catch：一次失败不堵后面的日志） */
    private chain: Promise<void> = Promise.resolve();

    constructor(options: FileExporterOptions) {
        this.options = resolveOptions(options);
    }

    /** LogRecordExporter.export —— 排队写，完成后回调（失败也回调，不抛） */
    export(records: readonly ExportedLogRecord[], resultCallback: ExportResultCallback): void {
        if (this.closed) {
            resultCallback({
                code: EXPORT_FAILED,
                error: new LogError('log/export-after-shutdown', 'shutdown 之后不能再 export'),
            });
            return;
        }
        const task = this.chain.then(async () => {
            try {
                for (const record of records) await this.write(record);
                resultCallback({ code: EXPORT_SUCCESS });
            } catch (error) {
                this.options.onError(error);
                resultCallback({ code: EXPORT_FAILED, error: asError(error) });
            }
        });
        this.chain = task.then(
            () => undefined,
            () => undefined,
        );
    }

    /** LogRecordExporter.forceFlush —— 等已入队的记录都落盘 */
    forceFlush(): Promise<void> {
        return this.chain;
    }

    /** LogRecordExporter.shutdown —— flush + 之后不再写 */
    async shutdown(): Promise<void> {
        this.closed = true;
        await this.chain;
    }

    private async write(record: ExportedLogRecord): Promise<void> {
        const at = hrTimeToDate(record.hrTime);
        const day = dayKey(at);
        const file = join(this.options.dir, `${day}.log`);
        if (this.day !== day) {
            this.day = day;
            this.prepared = false;
        }
        if (!this.prepared) {
            await mkdir(this.options.dir, { recursive: true });
            this.prepared = true;
            if (this.options.maxDays > 0) {
                // 清理失败不该挡住这一条日志：报一声，继续写
                await pruneDays(this.options.dir, this.options.maxDays, day).catch((error: unknown) =>
                    this.options.onError(error),
                );
            }
            this.size = await fileSize(file);
        }
        const line = buildLine(toEntry(record, at, this.options.maxDataBytes));
        const bytes = Buffer.byteLength(line, 'utf8');
        if (this.options.maxBytes > 0 && this.size > 0 && this.size + bytes > this.options.maxBytes) {
            await rotateFiles(file, this.options.maxFiles);
            this.size = 0;
        }
        await appendFile(file, line, 'utf8');
        this.size += bytes;
    }
}
