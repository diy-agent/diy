// sanitize.ts — 把任意值压成「可安全写盘」的形状（不写大对象 / 不因循环引用崩 / 不丢栈）
//
// 判据（##482）：`data` 超限截断（不写整个大对象）、`err` 字段带栈。
// OTel 的 attributes 是扁平的 AnyValue，但调用方可能把任意对象塞进来 —— 这里统一有界化。

import { Buffer } from 'node:buffer';
import type { FileLogError } from './types.js';

/** 字符串字段的显示上限（人读的一行，不是数据仓库） */
const MAX_STRING = 2000;
const MAX_ARRAY = 50;
const MAX_KEYS = 100;
const MAX_DEPTH = 6;
const MAX_STACK = 4000;
const MAX_CAUSE = 500;

/** 截断文本并标出丢了多长（读日志的人要知道「不是全文」） */
export function truncateText(value: string, max = MAX_STRING): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max)}…(+${value.length - max} chars)`;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** 任意值 → JSON 安全的形状（深度 / 数组长度 / 键数 / 字符串长度都有界；循环引用标 `[circular]`） */
export function sanitizeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (value === null || value === undefined) return value;
    switch (typeof value) {
        case 'string':
            return truncateText(value);
        case 'number':
            return Number.isFinite(value) ? value : String(value);
        case 'boolean':
            return value;
        case 'bigint':
            return `${value}n`;
        case 'symbol':
            return value.toString();
        case 'function':
            return `[function ${value.name || 'anonymous'}]`;
        default:
            break;
    }
    if (value instanceof Uint8Array) return `[bytes:${value.byteLength}]`;
    if (depth >= MAX_DEPTH) return '[depth-limit]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
    if (value instanceof Error) return toLogError(value);
    if (Array.isArray(value)) {
        const out = value.slice(0, MAX_ARRAY).map((item) => sanitizeValue(item, depth + 1, seen));
        if (value.length > MAX_ARRAY) out.push(`…(+${value.length - MAX_ARRAY} items)`);
        return out;
    }
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).slice(0, MAX_KEYS)) {
        out[key] = sanitizeValue(record[key], depth + 1, seen);
    }
    const total = Object.keys(record).length;
    if (total > MAX_KEYS) out['…'] = `(+${total - MAX_KEYS} keys)`;
    return out;
}

/**
 * attributes（去掉 exception.* 之后的部分）→ 落盘的 data。
 * 整块超过 `maxBytes` 就整体换成截断标记 —— 不做「按 key 砍」，半个对象比没有更容易误导排查。
 */
export function sanitizeData(
    attributes: Readonly<Record<string, unknown>> | undefined,
    maxBytes: number,
): Readonly<Record<string, unknown>> | undefined {
    if (attributes === undefined) return undefined;
    const safe = sanitizeValue(attributes);
    if (!isObject(safe)) return undefined;
    if (Object.keys(safe).length === 0) return undefined;
    const bytes = Buffer.byteLength(JSON.stringify(safe), 'utf8');
    if (bytes > maxBytes) return { truncated: true, bytes };
    return safe;
}

/** 错误对象 → `{ name, message, stack?, cause? }`；非 Error 也收（排查时不许因为类型不对就丢） */
export function toLogError(value: unknown): FileLogError {
    const error = value instanceof Error ? value : undefined;
    const name = error?.name ?? 'NonError';
    const message = truncateText(error?.message ?? String(value), MAX_STRING);
    const info: FileLogError = {
        name,
        message,
        ...(error?.stack === undefined ? {} : { stack: truncateText(error.stack, MAX_STACK) }),
    };
    const cause = error?.cause;
    if (cause !== undefined && cause !== null) {
        const text = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
        return { ...info, cause: truncateText(text, MAX_CAUSE) };
    }
    return info;
}

/** OTel 语义约定里的异常属性（SDK 从 `exception: Error` 自动生成这三个） */
const EXCEPTION_TYPE = 'exception.type';
const EXCEPTION_MESSAGE = 'exception.message';
const EXCEPTION_STACK = 'exception.stacktrace';
const EXCEPTION_CAUSE = 'exception.cause';

/**
 * 从 attributes 里把 `exception.*` 还原成 `err`，其余键留给 `data`。
 * （OTel 把 `LogRecord.exception` 摊成这三个属性，落盘时还原成人读的 `err` 对象。）
 */
export function splitException(attributes: Readonly<Record<string, unknown>>): {
    rest: Record<string, unknown>;
    err?: FileLogError;
} {
    const rest: Record<string, unknown> = { ...attributes };
    const type = rest[EXCEPTION_TYPE];
    const message = rest[EXCEPTION_MESSAGE];
    const stack = rest[EXCEPTION_STACK];
    const cause = rest[EXCEPTION_CAUSE];
    delete rest[EXCEPTION_TYPE];
    delete rest[EXCEPTION_MESSAGE];
    delete rest[EXCEPTION_STACK];
    delete rest[EXCEPTION_CAUSE];
    if (type === undefined && message === undefined) return { rest };
    return {
        rest,
        err: {
            name: truncateText(String(type ?? 'Error'), 200),
            message: truncateText(String(message ?? ''), MAX_STRING),
            ...(stack === undefined ? {} : { stack: truncateText(String(stack), MAX_STACK) }),
            ...(cause === undefined ? {} : { cause: truncateText(String(cause), MAX_CAUSE) }),
        },
    };
}

/** OTel `body` → 一行 msg（字符串直接用；对象有界化后 JSON，避免 `[object Object]`） */
export function bodyToMessage(body: unknown): string {
    if (typeof body === 'string') return truncateText(body);
    if (body === undefined || body === null) return '';
    if (typeof body === 'number' || typeof body === 'boolean' || typeof body === 'bigint') return String(body);
    try {
        return truncateText(JSON.stringify(sanitizeValue(body)));
    } catch {
        return '[unserializable body]';
    }
}
