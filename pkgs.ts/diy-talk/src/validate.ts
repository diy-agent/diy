// validate.ts — 结构校验的公共小工具（只给本包内部用）
//
// 本包**零依赖**，故不引 zod / 不手写 JSON Schema：形状是封闭的（四个锚点类型 + 两个记录），
// 手写校验反而更能给出「哪个字段错」的定位。校验函数一律返回**规范化后的新对象**
// （只含已知字段、键序固定）—— 序列化因此天然稳定，不受调用方对象字面量写法影响。

import { TalkError, type TalkErrorCode } from './errors';

/** 取字符串；`allowEmpty=false`（缺省）时拒绝空串 —— id / 路径这类标识一律非空 */
export function takeString(value: unknown, path: string, code: TalkErrorCode, allowEmpty = false): string {
    if (typeof value !== 'string') throw new TalkError(code, '应为字符串', path);
    if (!allowEmpty && value === '') throw new TalkError(code, '不能是空串', path);
    return value;
}

/** 取非负整数（偏移量这类；NaN / Infinity / 小数 / 负数一律拒绝） */
export function takeOffset(value: unknown, path: string, code: TalkErrorCode): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new TalkError(code, '应为非负整数', path);
    }
    return value;
}

/** 取对象（数组不算对象） */
export function takeObject(value: unknown, path: string, code: TalkErrorCode): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TalkError(code, '应为对象', path);
    }
    return value as Record<string, unknown>;
}

/** 取字符串数组（元素一律非空） */
export function takeStringArray(value: unknown, path: string, code: TalkErrorCode): string[] {
    if (!Array.isArray(value)) throw new TalkError(code, '应为字符串数组', path);
    return value.map((item, i) => takeString(item, `${path}[${i}]`, code));
}

/** 取 `string | null`（replyTo 专用：null = 这条发言起头，不指向任何先前发言） */
export function takeNullableString(value: unknown, path: string, code: TalkErrorCode): string | null {
    if (value === null || value === undefined) return null;
    return takeString(value, path, code);
}
