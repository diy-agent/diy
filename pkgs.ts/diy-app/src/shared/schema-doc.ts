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

import { z } from "zod";
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

// ────────────────────────────────────────────────────────────────────────────
// 递归派生：`describeSchema` —— 「这个结构长什么样」的**机器可读**文档
//
// 与上面 `fieldDocs` 的分工：`fieldDocs` 只到**一级**（紧凑表），本函数**递归**
// （对象 → 子字段、数组 → 元素结构），供信封的 `help:` 块使用（##310 六轮拍板：
// 「help 只能由 zod 派生」—— 手写的结构说明必然腐坏，实测 `CONTEXT_GUIDE` 宣称
// identity/rules/guard 进 system，而真源 `context.yaml` 里 identity 其实在 runtime）。
//
// 产出形状（刻意**扁平可读**，子字段与 `desc`/`type` 同级，不套 `fields:`）：
//
//   { desc: "字段说明（zod .describe()）", type?: "string", <子字段>: {…} }
//
//   · 对象   → 只列子字段（`type` 省略：有子字段即对象）
//   · 数组   → `type: array` + `items:`（元素结构）
//   · record → `type: object` + `values:`（**值**的结构；key 是动态的，如 claim / gid）
//   · 叶子   → `type`（string / number / boolean / null）
//
// record 为什么必须下钻（##404）：`z.record(z.string(), FactsCellSchema)` 从前只出
// `type: object` —— 读 help 的人只知"是个 map"，**值里有什么完全看不到**（value /
// resolvedBy / variants 三个字段全丢）。而"map 的值长什么样"恰恰是模型读这份投影时
// 最需要的信息。判据见 `hasStructure()`：`additionalProperties` 有形状才下钻，
// 裸 `z.unknown()` / 空对象照样只标类型（否则 help 会多出无意义的空节点）。
//
// 一切从 `z.toJSONSchema` 派生 —— 它已经处理好了 `.optional()` / `.default()` /
// `.nullable()` 的解包与嵌套，自己写一遍 unwrap 必然漏（也必然随 zod 升级而坏）。
// ────────────────────────────────────────────────────────────────────────────

/** 结构说明文档的一节（递归；子字段与 `desc`/`type` 同级） */
export type SchemaDoc = Record<string, unknown>;

/** JSON Schema 片段里我们关心的那点信息（`$ref` 未展开时先就地解析，见 deref） */
interface JsonSchemaBit {
    $ref?: unknown;
    description?: unknown;
    type?: unknown;
    properties?: Record<string, JsonSchemaBit>;
    items?: JsonSchemaBit | JsonSchemaBit[];
    prefixItems?: JsonSchemaBit[];
    additionalProperties?: unknown;
}

/**
 * 展开 `$ref`（zod 对 `.meta({ id })` 的具名 schema —— 如 `ChainEntry` / `Skill` ——
 * 会产出 `$defs` + `$ref`，**即使 `reused:"inline"` 也不总展开**）。
 *
 * 实测踩到：不展开的后果是 `chain.items` 只剩 `type: object` —— 数组元素的字段表**整段丢失**，
 * 而"元素里有什么"正是最该告诉模型的那部分（help 存在的理由）。
 * `$defs` / `$schema` 这类机器字段一并丢掉（它们对模型没有意义）。
 */
function deref(node: unknown, root: JsonSchemaBit, depth = 0): unknown {
    if (depth > 16 || node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((n) => deref(n, root, depth + 1));
    const obj = node as Record<string, unknown>;
    const ref = obj["$ref"];
    if (typeof ref === "string" && ref.startsWith("#/")) {
        const target = ref
            .slice(2)
            .split("/")
            .reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], root);
        if (target !== undefined) return deref(target, root, depth + 1);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
        if (k === "$defs" || k === "$schema" || k === "$id") continue;
        out[k] = deref(v, root, depth + 1);
    }
    return out;
}

/**
 * 这个 JSON Schema 片段**有没有可展示的结构**（对象有 properties / 数组有 items / 有明确 type）。
 *
 * 用来区分「record 的值是结构化对象」（要下钻成 `values:`）与「值是 any / 空对象」（只标类型）。
 * 判据不用 `additionalProperties` 本身：`z.unknown()` 也会产出它，但那是"什么都没有"。
 */
function hasStructure(bit: JsonSchemaBit): boolean {
    if (bit.properties && Object.keys(bit.properties).length > 0) return true;
    if (typeof bit.type === "string") return true;
    if (bit.items !== undefined || bit.prefixItems !== undefined) return true;
    return false;
}

/** JSON Schema → 结构说明文档（`depth` 兜住自引用，超限就把子树折成 `…`） */
function simplifyBit(bit: JsonSchemaBit, depth: number, maxDepth: number, descMaxDepth: number): SchemaDoc {
    const out: SchemaDoc = {};
    // `descMaxDepth`：**只在前几层说「这组是什么」**，深层/叶子的字段说明不进每轮 system
    // （实测 help 11.2 KB 里 85% 是 desc 文本，结构骨架只 1.6 KB —— 见 ##5 量化）。
    // 叶子字段名（path / value / variants）本就自解释，解释它们的代价是每轮重复付。
    if (depth <= descMaxDepth && typeof bit.description === "string" && bit.description) {
        out["desc"] = bit.description;
    }
    const type = typeof bit.type === "string" ? bit.type : undefined;
    const props = bit.properties;
    if (type === "object" && props && Object.keys(props).length > 0 && depth < maxDepth) {
        for (const [k, v] of Object.entries(props)) out[k] = simplifyBit(v, depth + 1, maxDepth, descMaxDepth);
        return out;
    }
    if (type === "array") {
        out["type"] = "array";
        const item = Array.isArray(bit.items) ? bit.items[0] : (bit.items ?? bit.prefixItems?.[0]);
        if (item && depth < maxDepth) out["items"] = simplifyBit(item, depth + 1, maxDepth, descMaxDepth);
        return out;
    }
    // record（`z.record(k, v)` → `additionalProperties`）：**值的结构**要带上。
    // 键是动态的（claim / gid），但"每个值里有什么字段"正是读 help 的人最缺的那块信息。
    // 只下钻有形状的值；`z.unknown()` 这类照旧只标类型。
    const ap = bit.additionalProperties;
    if (type === "object" && ap && typeof ap === "object" && !Array.isArray(ap) && depth < maxDepth) {
        // `$ref` 在 describeSchema 入口已由 deref 全量展开，这里拿到的就是实物。
        const valueBit = ap as JsonSchemaBit;
        if (hasStructure(valueBit)) {
            out["type"] = "object";
            out["values"] = simplifyBit(valueBit, depth + 1, maxDepth, descMaxDepth);
            return out;
        }
    }
    // 空对象 / 无形状 record / any → 只标类型，不再下钻。
    out["type"] = type ?? "object";
    return out;
}

/**
 * 从 zod 递归派生「结构说明」文档（纯函数）。
 *
 * `maxDepth` 兜住自引用 schema（z.lazy 造的环）；到限即停在该层，不假装下面没有了
 * （子字段仍在上一层列着，读侧不会以为"这个对象没字段"）。
 */
export function describeSchema(
    schema: ZodType,
    opts: { maxDepth?: number; descMaxDepth?: number } = {},
): SchemaDoc {
    const maxDepth = opts.maxDepth ?? 8;
    // 缺省不限（老消费者行为不变）；信封的 `help:` 传 2 —— 只有前两层 desc 值得每轮发。
    const descMaxDepth = opts.descMaxDepth ?? Number.POSITIVE_INFINITY;
    // 校验细节（prefixItems / items:false / minItems…）全部丢掉：投给模型的只有
    // 「字段名 + 一句话 + 结构」，那是人/模型读得懂的部分。
    const json = z.toJSONSchema(schema, {
        io: "input",
        unrepresentable: "any",
        reused: "inline",
    }) as unknown as JsonSchemaBit;
    return simplifyBit(deref(json, json) as JsonSchemaBit, 0, maxDepth, descMaxDepth);
}

/**
 * 把一个结构说明文档**裁剪**到给定 path 集合（保序、保留 desc）。
 *
 * 为什么要它：`help.system` 只能描述"**这个容器里实际会出现什么**"。整份 globals 的
 * 结构对 runtime 侧字段（task.body / skills）就是噪音，而且会说谎（"system 里有 skills"）。
 */
export function pruneSchemaDoc(doc: SchemaDoc, paths: readonly string[]): SchemaDoc {
    const out: SchemaDoc = {};
    if (typeof doc["desc"] === "string") out["desc"] = doc["desc"];
    for (const path of [...paths].sort()) {
        const segs = path.split(".");
        let src: SchemaDoc | undefined = doc;
        let dst = out;
        for (let i = 0; i < segs.length; i++) {
            const k = segs[i]!;
            const next = src?.[k];
            if (next === undefined || typeof next !== "object" || Array.isArray(next)) break;
            const child = (next as SchemaDoc);
            if (i === segs.length - 1) {
                // 叶子：整棵子树照抄（数组元素结构就是在这里带上的）
                if (!(k in dst)) dst[k] = child;
            } else {
                if (!(k in dst)) {
                    const fresh: SchemaDoc = {};
                    if (typeof child["desc"] === "string") fresh["desc"] = child["desc"];
                    dst[k] = fresh;
                }
                dst = dst[k] as SchemaDoc;
                src = child;
            }
        }
    }
    return out;
}
