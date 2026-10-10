// src/shared/schema-doc.ts
// 🎯 从 **zod 定义**派生「人/模型可读的字段说明」（纯模块，禁止 import node:*）
//
// ── 为什么要有它（用户 2026-10-06）──
// 「将来 UI 也需要（读懂这些结构），不然到处都是 UI 性质的解释性注释」。
// 手写的字段说明就是**第二真源**：改字段忘了改注释 → 注释撒谎，而且没人测得出来。
// 于是：**zod 定义 = 唯一真源**，字段表 / 投递注释 / 文档全部由它派生。
//
// ── 与 z.toJSONSchema 的分工 ──
// z.toJSONSchema 出来的是**校验用**的完整 schema（含 prefixItems / items:false / minItems…），
// 那是给机器看的；投给模型只会白烧 token。这里只取三件事：**字段名 / 一句话说明 / 是否必填**。
//   · 落盘校验：走 z.toJSONSchema（另有 strict 模式）
//   · 投递说明：走本文件的 fieldDocs（精简表）

import type { ZodObject, ZodType } from "zod";

/** 一个字段的**说明性**文档（不含任何校验细节） */
export interface FieldDoc {
    name: string;
    /** 来自 zod 的 `.describe()`；没写就是空串（提示作者补上） */
    desc: string;
    required: boolean;
}

/**
 * 取出对象 schema 的字段说明表（保序 = 定义序）。
 *
 * 「必填」判据 = **能不能接受 undefined**（`safeParse(undefined)`），而不是查内部 flag ——
 * 这样 `.optional()` / `.default()` / `.nullish()` 各种写法都自然归为可选，
 * 不会因为某天换个写法就把必填判反。
 */
export function fieldDocs(schema: ZodObject): FieldDoc[] {
    const shape = schema.shape as Record<string, ZodType>;
    return Object.entries(shape).map(([name, field]) => ({
        name,
        desc: field.description ?? "",
        required: !field.safeParse(undefined).success,
    }));
}

/**
 * 把字段说明渲染成**注释行**（YAML 的 `#` 行）—— 直接贴在被说明的结构上方即可。
 * 必填字段不加标记，可选字段尾部标 `（可选）`：默认情形不该被标记噪音淹没。
 */
export function renderFieldDocs(schema: ZodObject, indent = "#   "): string[] {
    const docs = fieldDocs(schema);
    const width = Math.max(...docs.map((d) => d.name.length), 1);
    return docs.map((d) => {
        const name = d.name.padEnd(width);
        const tail = d.required ? "" : "（可选）";
        return `${indent}${name} ${d.desc}${tail}`;
    });
}

/** 取对象 schema 的一级字段名（保序）—— 给「只列名字」的紧凑说明用 */
export function fieldNames(schema: ZodObject): string[] {
    return Object.keys(schema.shape as Record<string, ZodType>);
}
