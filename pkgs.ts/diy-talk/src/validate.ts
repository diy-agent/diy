// validate.ts — 结构校验的公共小工具（只给本包内部用）
//
// 本包**零依赖**，故不引 zod / 不手写 JSON Schema：形状是封闭的（四个锚点类型 + 两个记录），
// 手写校验反而更能给出「哪个字段错」的定位。校验函数一律返回**规范化后的新对象**
// （只含已知字段、键序固定）—— 序列化因此天然稳定，不受调用方对象字面量写法影响。
//
// 未知字段策略（review1 意见 4 / review2 意见 4 收口）：**默认拒绝**（`rule.loud`）——
// 形状封闭，写侧/读侧遇到不认识的键一律抛 `TalkError`，绝不静默抹掉调用方的数据。
// 读侧若要前向兼容（新版本加的字段），显式传 `{ allowUnknown: true }` 逐层放行。

import { TalkError, type TalkErrorCode } from './errors.js';

/**
 * 解析选项。
 *
 * `allowUnknown`：放行未知字段（**仅供读侧前向兼容**，缺省严格）。
 *
 * ⚠️ 契约（review3 意见 1）：`allowUnknown` 是**只读检查闸** —— 它只让解析「不报错」，
 * **不保留**未知字段（返回的仍是「只含已知字段」的规范化对象）。故用 `allowUnknown` 读进来的对象
 * **不得**再经本包 `*ToJson` 写回落盘：写侧严格，且未知字段已不在返回值里 —— 读-改-写一次就把新字段抹了。
 * 「读懂新版本数据」归本包；「读写往返不丢字段」归宿主（##319）自行负责（例如按需保留原始 JSON）。
 */
export interface ParseOptions {
    readonly allowUnknown?: boolean;
}

/** 拒绝未知字段：形状封闭，多一个键就报错（带点路径指向该键） */
export function rejectUnknown(
    obj: Record<string, unknown>,
    known: readonly string[],
    path: string,
    code: TalkErrorCode,
): void {
    for (const key of Object.keys(obj)) {
        if (!known.includes(key)) {
            throw new TalkError(code, `未知字段 ${JSON.stringify(key)}（形状封闭；新增字段须升级本包）`, `${path}.${key}`);
        }
    }
}

/** 取字符串；`allowEmpty=false`（缺省）时拒绝空串 —— id / 路径这类标识一律非空 */
export function takeString(value: unknown, path: string, code: TalkErrorCode, allowEmpty = false): string {
    if (typeof value !== 'string') throw new TalkError(code, '应为字符串', path);
    if (!allowEmpty && value === '') throw new TalkError(code, '不能是空串', path);
    return value;
}

/**
 * 取 ISO-8601 时刻字符串（`at` 专用）。
 * 「时间是事实，不能凭空补」—— 格式也是事实：`'昨天下午'` 这种非 ISO 文本无法被下游排序 / 比较，
 * 必须在入口拦下（review1 意见 2）。接受形状：`YYYY-MM-DDTHH:mm:ss[.sss][Z|±HH:mm]`。
 *
 * 边界（review3 意见 2，选「只校形态」）：本函数只做**词法**校验（数字位数 + 分隔符），
 * **不校验日历合法性** —— `2026-99-99T99:99:99Z`、`2026-02-30T25:00:00Z` 之类会放行。
 * 理由是内核保持轻、不引 `Date`（零依赖 + 可脱离 Node 运行）；「这个时刻是否真实存在」属语义，
 * 归宿主（##319）在落盘 / 消费时按需校验。
 */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;

export function takeIsoString(value: unknown, path: string, code: TalkErrorCode): string {
    const text = takeString(value, path, code);
    if (!ISO_8601.test(text)) {
        throw new TalkError(code, `应为 ISO-8601 时刻（如 2026-10-13T00:00:00.000Z），实得 ${JSON.stringify(text)}`, path);
    }
    return text;
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

/** 取字符串数组（元素一律非空、不得重复） */
export function takeStringArray(value: unknown, path: string, code: TalkErrorCode): string[] {
    if (!Array.isArray(value)) throw new TalkError(code, '应为字符串数组', path);
    const out = value.map((item, i) => takeString(item, `${path}[${i}]`, code));
    const seen = new Set<string>();
    out.forEach((item, i) => {
        if (seen.has(item)) throw new TalkError(code, `重复引用 ${JSON.stringify(item)}（同一目标只应出现一次）`, `${path}[${i}]`);
        seen.add(item);
    });
    return out;
}

/** 取 `string | null`（replyTo 专用：null = 这条发言起头，不指向任何先前发言） */
export function takeNullableString(value: unknown, path: string, code: TalkErrorCode): string | null {
    if (value === null) return null;
    return takeString(value, path, code);
}
