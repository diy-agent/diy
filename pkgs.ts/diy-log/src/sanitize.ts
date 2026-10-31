// sanitize.ts — 把任意值压成「可安全写盘」的形状（不写大对象 / 不因循环引用崩 / 不丢栈）
//
// 判据（##482）：`data` 超限截断（不写整个大对象）、`err` 字段带栈。
// 这里只做**有界化**，不做业务裁剪：调用方给什么键就留什么键（顺序按 Object.keys）。

import { Buffer } from 'node:buffer';
import type { LogData, LogErrorInfo } from './types.js';

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
export function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
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
    if (depth >= MAX_DEPTH) return '[depth-limit]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
    if (value instanceof Error) return toLogError(value, true);
    if (Array.isArray(value)) {
        const out = value.slice(0, MAX_ARRAY).map((item) => sanitize(item, depth + 1, seen));
        if (value.length > MAX_ARRAY) out.push(`…(+${value.length - MAX_ARRAY} items)`);
        return out;
    }
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).slice(0, MAX_KEYS)) {
        out[key] = sanitize(record[key], depth + 1, seen);
    }
    const total = Object.keys(record).length;
    if (total > MAX_KEYS) out['…'] = `(+${total - MAX_KEYS} keys)`;
    return out;
}

/**
 * data 的落盘形状：先有界化，整块超过 `maxBytes` 就整体换成截断标记。
 * 不做「按 key 砍」——半个对象比没有更容易误导排查。
 */
export function sanitizeData(data: LogData | undefined, maxBytes: number): LogData | undefined {
    if (data === undefined) return undefined;
    const safe = sanitize(data);
    if (!isObject(safe)) return { value: safe };
    const bytes = Buffer.byteLength(JSON.stringify(safe), 'utf8');
    if (bytes > maxBytes) return { truncated: true, bytes };
    return safe as LogData;
}

/** 错误对象 → `{ name, message, stack?, cause? }`；非 Error 也收（排查时不许因为类型不对就丢） */
export function toLogError(value: unknown, insideData = false): LogErrorInfo | undefined {
    if (value === undefined || value === null) return undefined;
    const error = value instanceof Error ? value : undefined;
    const name = error?.name ?? 'NonError';
    const message = truncateText(error?.message ?? String(value), MAX_STRING);
    const info: LogErrorInfo = {
        name,
        message,
        ...(insideData || error?.stack === undefined ? {} : { stack: truncateText(error.stack, MAX_STACK) }),
    };
    const cause = error?.cause;
    if (cause !== undefined && cause !== null) {
        const text = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
        return { ...info, cause: truncateText(text, MAX_CAUSE) };
    }
    return info;
}
