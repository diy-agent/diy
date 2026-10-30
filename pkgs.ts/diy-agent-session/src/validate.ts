// validate.ts — 输入校验原语：非法一律抛 SessionError（带点路径），不做「容错一下」
//
// 理由同 @diy-agent/talk：静默丢弃一条消息 / 一个增量，事后无法从历史里分辨
// 「本来就没有」与「被悄悄扔了」。测试断言的是 code，不是报错文案。

import { SessionError, type SessionErrorCode } from './errors.js';

/** ISO-8601 时间戳的形状判据（`Date.parse` 兜底真伪） */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function takeObject(value: unknown, path: string, code: SessionErrorCode): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new SessionError(code, `期望对象，拿到 ${describe(value)}`, path);
    }
    return value as Record<string, unknown>;
}

export function takeString(value: unknown, path: string, code: SessionErrorCode): string {
    if (typeof value !== 'string') {
        throw new SessionError(code, `期望字符串，拿到 ${describe(value)}`, path);
    }
    return value;
}

export function takeNonEmptyString(value: unknown, path: string, code: SessionErrorCode): string {
    const s = takeString(value, path, code);
    if (s.trim() === '') throw new SessionError(code, '期望非空字符串', path);
    return s;
}

export function takeNonNegativeNumber(value: unknown, path: string, code: SessionErrorCode): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new SessionError(code, `期望非负有限数字，拿到 ${describe(value)}`, path);
    }
    return value;
}

export function takeNonNegativeInteger(value: unknown, path: string, code: SessionErrorCode): number {
    const n = takeNonNegativeNumber(value, path, code);
    if (!Number.isInteger(n)) throw new SessionError(code, `期望非负整数，拿到 ${n}`, path);
    return n;
}

export function takeIsoString(value: unknown, path: string, code: SessionErrorCode): string {
    const s = takeString(value, path, code);
    if (!ISO_RE.test(s) || Number.isNaN(Date.parse(s))) {
        throw new SessionError(code, `期望 ISO-8601 时间戳，拿到 ${describe(value)}`, path);
    }
    return s;
}

/** 未知字段一律报错：拼错键名（如 `rolee`）必须是显式失败，而不是"字段没生效" */
export function rejectUnknown(
    obj: Record<string, unknown>,
    allowed: readonly string[],
    path: string,
    code: SessionErrorCode,
): void {
    for (const key of Object.keys(obj)) {
        if (!allowed.includes(key)) {
            throw new SessionError(code, `未知字段 ${key}（允许：${allowed.join(' / ')}）`, `${path}.${key}`);
        }
    }
}

function describe(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}
