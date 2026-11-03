/**
 * spec.ts — 插件**服务端**的契约（方法表 + 定义助手）
 *
 * 插件可以带一个服务端模块（`server.ts`）声明自己的方法与入参/出参 schema；
 * 宿主在调用前后都按这里的 schema 校验。
 *
 * 信任模型（由宿主强制，契约只描述形状）：
 *   - 只有宿主**信任来源**的插件才会被 import（仓库内插件；用户目录插件默认只吃清单）。
 *   - 进程外插件将来产出同样的形状即可（宿主负责传输）。
 *
 * 宿主实现参考：diy-video/workbench/server/plugin-host.ts
 */

import type { z } from 'zod';

export interface PluginContext {
    /** UI 断开/取消 → abort */
    signal: AbortSignal;
}

export interface PluginMethodSpec {
    /** 入参 schema（默认 z.unknown()） */
    input?: z.ZodType<any>;
    /** 出参 schema（默认 z.unknown()） */
    output?: z.ZodType<any>;
    /** 同步/单次调用 */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler?: (input: any, ctx: PluginContext) => unknown | Promise<unknown>;
    /** 流式调用：逐块 yield（进度/日志） */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stream?: (input: any, ctx: PluginContext) => AsyncGenerator<any>;
    /** 说明（给 UI 用） */
    desc?: string;
}

export interface PluginSpec {
    id: string;
    name?: string;
    version?: string;
    /** 方法名 → 契约；命名建议 `<能力>.<动作>`，如 `export`、`units.list` */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc?: Record<string, PluginMethodSpec>;
}

/** 插件作者用的定义助手（只做类型收窄，不引入运行时依赖） */
export function definePlugin(spec: PluginSpec): PluginSpec {
    return spec;
}
