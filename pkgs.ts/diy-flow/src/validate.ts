// validate.ts — 形状护栏：形状封闭（未知字段即报错）+ 宿主边界的插件调用
//
// 两件事放一起，因为它们是同一条口径的两面：**任何一条诊断都不允许降级**。
//   · `rejectUnknown` —— 定义 / 选项 / 入参的**形状封闭**：多一个键就报错（带点路径指向那个键）。
//     依据：把 `maxBounces` 拼成 `maxBounce` 若被静默忽略，死循环护栏就**悄悄关掉**了 ——
//     与「未注册插件不降级」同型（见 registry.ts 头注）。
//   · `callPlugin` —— 插件是宿主代码，**抛出异常也是宿主边界**：统一包成 `FlowError`
//     （`code = plugin-threw`，`cause` 保留原异常），不让原生 Error 直穿内核（内核自己的诊断
//     全是 `FlowError`，调用方按 `code` 处置，不必猜「这个 Error 是谁的」）。

import { FlowError, type FlowErrorCode } from './errors';

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

/** 调用一个宿主插件：抛出的异常统一包成 `plugin-threw`（`FlowError` 原样放行，保住它的 `code`/`path`） */
export function callPlugin<T>(what: string, path: string, fn: () => T): T {
    try {
        return fn();
    } catch (e) {
        if (e instanceof FlowError) throw e;
        throw new FlowError('plugin-threw', `${what} 抛了异常：${e instanceof Error ? e.message : String(e)}`, path, e);
    }
}
