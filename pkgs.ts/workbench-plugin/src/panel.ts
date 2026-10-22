/**
 * panel.ts — 档 2 控制面板的**声明式**描述符契约
 *
 * 面板 = 插件给宿主的「控制面」：宿主负责渲染与派发动作，插件只给数据。
 * 刻意不用闭包/代码：描述符是纯 JSON，将来进程外插件也能产出同样的东西。
 *
 * 宿主实现参考：diy-video/workbench/src/lib/panel.ts
 */

import { z } from 'zod';

export const PanelActionSchema = z.object({
    /**
     * 动作作用域：
     *   - `plugin`（默认）：调**本插件**的 rpc 方法
     *   - `core`：调**宿主**的核心能力（宿主侧白名单）
     * 插件不需要 import 宿主模块就能用核心能力。
     */
    scope: z.enum(['plugin', 'core']).optional(),
    /** 插件方法名（相对插件的 rpc 表）；scope=core 时是核心能力名 */
    method: z.string().min(1),
    /** 入参（宿主原样传给插件；插件自己的契约再校验一次） */
    input: z.unknown().optional(),
    /** 该方法是流式的：宿主订阅 serverStream，把进度/日志灌进面板 */
    stream: z.boolean().optional(),
});

export type PanelAction = z.output<typeof PanelActionSchema>;

export const PanelBlockSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('info'), label: z.string(), value: z.string() }),
    z.object({ kind: z.literal('text'), value: z.string(), mono: z.boolean().optional() }),
    z.object({
        kind: z.literal('button'),
        label: z.string(),
        action: PanelActionSchema,
        variant: z.enum(['brand', 'neutral', 'danger']).optional(),
        hint: z.string().optional(),
    }),
    z.object({
        kind: z.literal('select'),
        label: z.string(),
        value: z.string(),
        options: z.array(z.object({ value: z.string(), label: z.string() })),
        action: PanelActionSchema,
    }),
    z.object({ kind: z.literal('progress'), value: z.number(), label: z.string().optional() }),
    z.object({ kind: z.literal('log'), lines: z.array(z.string()) }),
]);

export type PanelBlock = z.output<typeof PanelBlockSchema>;

export const PanelDescriptorSchema = z.object({
    id: z.string().min(1),
    title: z.string().optional(),
    blocks: z.array(PanelBlockSchema),
});

export type PanelDescriptor = z.output<typeof PanelDescriptorSchema>;

/** 流式动作的标准块（插件的流方法要产出这个形状，宿主才认得） */
export const PanelStreamChunkSchema = z.object({
    event: z.enum(['log', 'progress', 'done', 'error']),
    message: z.string().optional(),
    progress: z.number().optional(),
    result: z.unknown().optional(),
});

export type PanelStreamChunk = z.output<typeof PanelStreamChunkSchema>;
