// validate.ts — 形状护栏：形状封闭（未知字段即报错）+ 时刻词法 + 宿主边界的插件调用
//
// 三件事放一起，因为它们是同一条口径的两面：**任何一条诊断都不允许降级**。
//   · `rejectUnknown` —— 定义 / 选项 / 入参的**形状封闭**：多一个键就报错（带点路径指向那个键）。
//     依据：把 `maxBounces` 拼成 `maxBounce` 若被静默忽略，死循环护栏就**悄悄关掉**了 ——
//     与「未注册插件不降级」同型（见 registry.ts 头注）。
//   · `isIsoString` —— 时刻的词法护栏：领域态要落盘（##333），`at` 必须先是**事实**才能是**数据**；
//     口径与 `@diy-agent/talk` 的 `takeIsoString` 一致（只校形态、不校日历合法性，内核不引 `Date`）。
//   · `callPlugin` —— 插件是宿主代码，**抛出异常也是宿主边界**：统一包成 `FlowError`
//     （`code = plugin-threw`，`cause` 保留原异常），不让原生 Error 直穿内核（内核自己的诊断
//     全是 `FlowError`，调用方按 `code` 处置，不必猜「这个 Error 是谁的」）。

import { FlowError, type FlowErrorCode } from './errors.js';

/**
 * ISO-8601 时刻的**词法**校验（形状 `YYYY-MM-DDTHH:mm:ss[.sss][Z|±HH:mm]`）。
 *
 * 与 `@diy-agent/talk` 同口径（review3 意见 2）：只校形态、**不校日历合法性** —— `2026-99-99T99:99:99Z`
 * 会放行。内核保持轻、不引 `Date`；「这个时刻是否真实存在」属语义，归宿主按需校验。
 */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;

export function isIsoString(value: unknown): value is string {
    return typeof value === 'string' && ISO_8601.test(value);
}

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 拒绝未知字段：形状封闭，多一个键就报错（带点路径指向该键） */
export function rejectUnknown(obj: Record<string, unknown>, known: readonly string[], path: string, code: FlowErrorCode): void {
    for (const key of Object.keys(obj)) {
        if (!known.includes(key)) {
            throw new FlowError(code, `未知字段 ${JSON.stringify(key)}（形状封闭）`, `${path}.${key}`);
        }
    }
}

/**
 * 两份 JSON 值是否等价（**键序无关**，值只可能是标量 / 数组 / 普通对象）。
 *
 * 用途：核对「状态里带的 L2 参数值」与「`createRuntime` 拿到的那份」是不是同一份（##333 交付 G）。
 * 键序无关是有意的 —— 同一份参数值经一次落盘读回后键序可能不同，但那不是「换了一份参数」。
 */
export function sameJson(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((item, i) => sameJson(item, b[i]));
    }
    if (isObject(a) && isObject(b)) {
        const ka = Object.keys(a);
        const kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        return ka.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
    }
    return false;
}

/** 调用一个宿主插件：抛出的异常统一包成 `plugin-threw`（`FlowError` 原样放行，保住它的 `code`/`path`） */
export function callPlugin<T>(what: string, path: string, fn: () => T): T {
    try {
        return fn();
    } catch (e) {
        if (e instanceof FlowError) throw e;
        throw new FlowError('plugin-threw', `${what} 抛了异常：${e instanceof Error ? e.message : String(e)}`, path, e);
    }
}
