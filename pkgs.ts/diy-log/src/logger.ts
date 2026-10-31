// logger.ts — createLogger / child 的实现：一个 core（目录 + 队列 + 轮转状态）+ 多个句柄。
//
// 为什么**不给全局单例**（##482）：测试要能各自建到临时目录；同一进程里两个 app / 两个测试
// 同时跑时，全局可变状态会互相污染（rule：禁全局可变状态）。装配层建一次，把 child 句柄传下去。
//
// 写入模型：
//   · 每次调用同步**有界化**记录（sanitize），再压成一行入队；
//   · 队列串行 appendFile —— 顺序与调用顺序一致，不交错半行；
//   · 写盘失败不抛（日志是旁路），交给 onError；队列继续往下走。

import { Buffer } from 'node:buffer';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { localISOString } from '@diy-agent/time';
import { LogError } from './errors.js';
import { dayKey, pruneDays, rotateFiles } from './rotate.js';
import { sanitizeData, toLogError, truncateText } from './sanitize.js';
import {
    isLogLevel,
    LOG_LEVELS,
    type LogData,
    type Logger,
    type LoggerOptions,
    type LogLevel,
    type LogRecord,
} from './types.js';

/** 缺省轮转：10 MB 一份、留 5 份历史、留最近 14 天（与 ##482 body 的例子一致） */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_MAX_DAYS = 14;
const DEFAULT_MAX_DATA_BYTES = 4096;
/** 单条记录的兜底上限（sanitize 之后仍超 ⇒ 再砍 data / 栈 / msg） */
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_MSG = 2000;

interface ResolvedOptions {
    readonly dir: string;
    readonly levelIndex: number;
    readonly maxBytes: number;
    readonly maxFiles: number;
    readonly maxDays: number;
    readonly maxDataBytes: number;
    readonly now: () => Date;
    readonly onError: (error: unknown) => void;
}

interface Core extends ResolvedOptions {
    /** 当前文件名对应的本地日期（跨天时重置 prepared / size） */
    day?: string;
    /** 当前文件已写字节数（缓存：避免每条都 stat） */
    size: number;
    /** 目录 + 当天文件是否已探测过（mkdir / 按天清理 / 读初始 size） */
    prepared: boolean;
    closed: boolean;
    /** 串行写链（catch 过：一次失败不堵后面的日志） */
    chain: Promise<void>;
}

function defaultOnError(error: unknown): void {
    try {
        const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        process.stderr.write(`[diy-log] 写日志失败：${text}\n`);
    } catch {
        // 连 stderr 都写不了就放弃：日志自身不许把 app 带崩
    }
}

function positiveLimit(value: unknown, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new LogError('log/invalid-options', `${name} 必须是 ≥0 的有限数字`, String(value));
    }
    return value;
}

function resolveOptions(options: LoggerOptions): ResolvedOptions {
    if (typeof options.dir !== 'string' || options.dir.trim() === '') {
        throw new LogError('log/invalid-options', 'dir 必填（日志目录）');
    }
    const level = options.level ?? 'info';
    if (!isLogLevel(level)) {
        throw new LogError('log/invalid-options', `level 必须是 ${LOG_LEVELS.join(' / ')}`, String(level));
    }
    const rotate = options.rotate ?? {};
    const maxDataBytes = positiveLimit(options.maxDataBytes, DEFAULT_MAX_DATA_BYTES, 'maxDataBytes');
    if (maxDataBytes === 0) throw new LogError('log/invalid-options', 'maxDataBytes 必须 > 0');
    const now = options.now ?? ((): Date => new Date());
    if (typeof now !== 'function') {
        throw new LogError('log/invalid-options', 'now 必须是函数（测试注入时钟用）');
    }
    return {
        dir: options.dir,
        levelIndex: LOG_LEVELS.indexOf(level),
        maxBytes: positiveLimit(rotate.maxBytes, DEFAULT_MAX_BYTES, 'rotate.maxBytes'),
        maxFiles: Math.floor(positiveLimit(rotate.maxFiles, DEFAULT_MAX_FILES, 'rotate.maxFiles')),
        maxDays: Math.floor(positiveLimit(rotate.maxDays, DEFAULT_MAX_DAYS, 'rotate.maxDays')),
        maxDataBytes,
        now,
        onError: options.onError ?? defaultOnError,
    };
}

/** 一条记录压成一行（保证 ≤ MAX_RECORD_BYTES；超了先砍 data / 栈 / msg） */
function buildLine(record: LogRecord): string {
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line, 'utf8') <= MAX_RECORD_BYTES) return line;

    const bytes = record.data === undefined ? 0 : Buffer.byteLength(JSON.stringify(record.data), 'utf8');
    const squeezed: LogRecord = {
        at: record.at,
        level: record.level,
        source: record.source,
        msg: truncateText(record.msg, 200),
        ...(record.data === undefined ? {} : { data: { truncated: true, bytes } }),
        ...(record.err === undefined
            ? {}
            : {
                  err: {
                      name: truncateText(record.err.name, 100),
                      message: truncateText(record.err.message, 200),
                      ...(record.err.cause === undefined ? {} : { cause: truncateText(record.err.cause, 100) }),
                  },
              }),
        ...(record.traceId === undefined ? {} : { traceId: record.traceId }),
    };
    const second = `${JSON.stringify(squeezed)}\n`;
    if (Buffer.byteLength(second, 'utf8') <= MAX_RECORD_BYTES) return second;

    // 极端兜底：字段本身异常长（如超长 traceId）—— 保结构、丢内容
    return `${JSON.stringify({ at: squeezed.at, level: squeezed.level, source: squeezed.source, msg: '<record truncated>' })}\n`;
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

async function writeLine(core: Core, line: string, at: Date): Promise<void> {
    const day = dayKey(at);
    if (core.day !== day) {
        core.day = day;
        core.prepared = false;
    }
    const file = join(core.dir, `${day}.log`);
    if (!core.prepared) {
        await mkdir(core.dir, { recursive: true });
        core.prepared = true;
        if (core.maxDays > 0) {
            // 清理失败不该挡住这一条日志：报一声，继续写
            await pruneDays(core.dir, core.maxDays, day).catch((error: unknown) => core.onError(error));
        }
        core.size = await fileSize(file);
    }
    const bytes = Buffer.byteLength(line, 'utf8');
    if (core.maxBytes > 0 && core.size > 0 && core.size + bytes > core.maxBytes) {
        await rotateFiles(file, core.maxFiles);
        core.size = 0;
    }
    await appendFile(file, line, 'utf8');
    core.size += bytes;
}

function enqueue(core: Core, line: string, at: Date): void {
    const next = core.chain.then(() => writeLine(core, line, at));
    // 记录失败自吞：日志是旁路，不能把调用方（更别说 app）带崩
    core.chain = next.catch((error: unknown) => core.onError(error));
}

class LoggerImpl implements Logger {
    readonly source: string;
    readonly traceId?: string;
    private readonly core: Core;

    constructor(core: Core, source: string, traceId?: string) {
        this.core = core;
        this.source = source;
        this.traceId = traceId;
    }

    child(source: string, traceId?: string): Logger {
        if (typeof source !== 'string' || source.trim() === '') {
            throw new LogError('log/invalid-source', 'child(source) 的来源标识不能为空');
        }
        return new LoggerImpl(this.core, source, traceId ?? this.traceId);
    }

    withTrace(traceId: string): Logger {
        if (typeof traceId !== 'string' || traceId.trim() === '') {
            throw new LogError('log/invalid-options', 'withTrace(traceId) 的 traceId 不能为空');
        }
        return new LoggerImpl(this.core, this.source, traceId);
    }

    debug(msg: string, data?: LogData, err?: unknown): void {
        this.emit('debug', msg, data, err);
    }

    info(msg: string, data?: LogData, err?: unknown): void {
        this.emit('info', msg, data, err);
    }

    warn(msg: string, data?: LogData, err?: unknown): void {
        this.emit('warn', msg, data, err);
    }

    error(msg: string, data?: LogData, err?: unknown): void {
        this.emit('error', msg, data, err);
    }

    flush(): Promise<void> {
        return this.core.chain;
    }

    async close(): Promise<void> {
        this.core.closed = true;
        await this.core.chain;
    }

    private emit(level: LogLevel, msg: string, data: LogData | undefined, err: unknown): void {
        const core = this.core;
        if (core.closed) return;
        if (LOG_LEVELS.indexOf(level) < core.levelIndex) return;
        const at = core.now();
        const safeData = sanitizeData(data, core.maxDataBytes);
        const safeError = toLogError(err);
        const record: LogRecord = {
            at: localISOString(at),
            level,
            source: this.source,
            msg: truncateText(String(msg), MAX_MSG),
            ...(safeData === undefined ? {} : { data: safeData }),
            ...(safeError === undefined ? {} : { err: safeError }),
            ...(this.traceId === undefined ? {} : { traceId: this.traceId }),
        };
        enqueue(core, buildLine(record), at);
    }
}

/**
 * 建一个日志句柄（**不要做成模块级单例**）：装配层调一次，把 `child(source)` 传下去。
 *
 * @example
 *   const logger = createLogger({ dir: join(home, 'log', 'app') });
 *   const log = logger.child('main:chat');
 *   log.info('窗口已创建', { variant });
 *   log.error('LLM 失败', { provider, status: 400 }, cause);
 */
export function createLogger(options: LoggerOptions): Logger {
    const resolved = resolveOptions(options);
    const source = options.source ?? 'app';
    if (typeof source !== 'string' || source.trim() === '') {
        throw new LogError('log/invalid-source', 'source 不能为空', 'options.source');
    }
    const core: Core = {
        ...resolved,
        size: 0,
        prepared: false,
        closed: false,
        chain: Promise.resolve(),
    };
    return new LoggerImpl(core, source);
}
