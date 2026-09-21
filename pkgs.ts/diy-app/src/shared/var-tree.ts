// src/shared/var-tree.ts
// 🎯 变量契约（zod schema）→ 两种派生视图：
//   1. buildVarTree：试验场「变量定义」view 的**树**（每个路径都是节点：diy → cli；chain → [ChainEntry] → path…）
//   2. flattenVars：引擎静态校验用的**扁平清单**（路径 + 粗细类型）
//   3. buildValueTree：试验场「变量值」view 的**值树**（同样结构，叶子挂本次注入的实际值）
//
// 为什么从 zod 反推而不是手写两份：手写清单与注入必然漂移（曾经就是靠测试才发现）；
// 用 schema 当单一真源后，类型、嵌套、元素名、说明都在同一处。
// zod v4 内部结构：def.type / def.shape(object) / def.element(array) / .description / .meta().id
//
// 约定：本文件只放纯函数，禁止 import node:*（renderer 会打进包）。

import type { ZodType } from "zod";
import { previewValue } from "@diy/template";
import type { VarSpec } from "./prompt-schema";

/** 变量树节点（一个节点 = 路径上的一段） */
export interface VarNode {
  /** 显示名：容器/字段名，数组元素显示为 `[ChainEntry]` / `[string]` */
  name: string;
  /** 粗粒度类型：object / array / string / number / boolean / …unknown 原样透传 */
  type: string;
  desc?: string;
  optional?: boolean;
  nullable?: boolean;
  children?: VarNode[];
}

/** 解开 optional / nullable 包装（保留标记），拿到真实类型节点 */
function unwrap(schema: ZodType): { schema: ZodType; optional: boolean; nullable: boolean } {
  let cur = schema as unknown as { def?: { type?: string; innerType?: ZodType } };
  let optional = false;
  let nullable = false;
  for (;;) {
    const t = cur?.def?.type;
    if (t === "optional" && cur.def?.innerType) {
      optional = true;
      cur = cur.def.innerType as unknown as typeof cur;
      continue;
    }
    if (t === "nullable" && cur.def?.innerType) {
      nullable = true;
      cur = cur.def.innerType as unknown as typeof cur;
      continue;
    }
    break;
  }
  return { schema: cur as unknown as ZodType, optional, nullable };
}

const defOf = (s: ZodType): { type?: string; shape?: Record<string, ZodType>; element?: ZodType } =>
  (s as unknown as { def?: { type?: string; shape?: Record<string, ZodType>; element?: ZodType } }).def ?? {};
const descOf = (s: ZodType): string | undefined =>
  (s as unknown as { description?: string }).description;
const metaIdOf = (s: ZodType): string | undefined => {
  const meta = (s as unknown as { meta?: () => { id?: string } | undefined }).meta;
  return typeof meta === "function" ? meta.call(s)?.id : undefined;
};

/** 单个字段 → 节点（object 递归；array 展开元素类型） */
function nodeOf(name: string, schema: ZodType): VarNode {
  const { schema: inner, optional, nullable } = unwrap(schema);
  const d = defOf(inner);
  const type = d.type ?? "unknown";
  const desc = descOf(inner);
  if (type === "object" && d.shape) {
    return {
      name,
      type: "object",
      desc,
      optional,
      nullable,
      children: Object.entries(d.shape).map(([k, v]) => nodeOf(k, v)),
    };
  }
  if (type === "array" && d.element) {
    const { schema: el } = unwrap(d.element);
    const elType = defOf(el).type ?? "unknown";
    const elName = metaIdOf(el) ? `[${metaIdOf(el)}]` : `[${elType}]`;
    const elNode =
      elType === "object" && defOf(el).shape
        ? { name: elName, type: "object", desc: descOf(el), children: nodeOf("", el).children }
        : { name: elName, type: elType, desc: descOf(el) };
    return { name, type: "array", desc, optional, nullable, children: [elNode] };
  }
  return { name, type, desc, optional, nullable };
}

/**
 * 变量树：根为 schema 的字段（`diy`、`task`…），数组展开成 `[元素类型]` 节点。
 * 例子：diy → cli（两个节点）；chain → [ChainEntry] → path/scope/content。
 */
export function buildVarTree(schema: ZodType, name = ""): VarNode[] {
  const { schema: inner } = unwrap(schema);
  const d = defOf(inner);
  if (d.type === "object" && d.shape) return Object.entries(d.shape).map(([k, v]) => nodeOf(k, v));
  return name ? [nodeOf(name, inner)] : [];
}

const COARSE: Record<string, VarSpec["type"]> = {
  string: "string",
  number: "number",
  boolean: "boolean",
  array: "array",
  object: "object",
};

/**
 * 扁平清单（引擎静态校验用）：对象自己也算一条（`{{diy}}` 应报"是对象，不能插值"），
 * 数组**不**下钻元素（引擎的粗类型不建模元素类型）。
 */
export function flattenVars(schema: ZodType, prefix = ""): VarSpec[] {
  const { schema: inner } = unwrap(schema);
  const d = defOf(inner);
  const type = d.type ?? "unknown";
  const self = COARSE[type];
  if (type === "object" && d.shape) {
    // 对象自己也进契约（`{{diy}}` 应报"是对象，不能插值"），但**根对象不算路径**
    const mine: VarSpec[] = self && prefix ? [{ path: prefix, type: self, desc: descOf(inner) }] : [];
    return [
      ...mine,
      ...Object.entries(d.shape).flatMap(([k, v]) =>
        flattenVars(v, prefix ? `${prefix}.${k}` : k),
      ),
    ];
  }
  if (!self) return []; // unknown 之类不参与校验
  return [{ path: prefix, type: self, desc: descOf(inner) }];
}

// ── 值树（「变量值」view）───────────────────────────────────────────────
// 契约（schema）给"有哪些变量、什么类型、什么含义"，值树给"这次到底注入了什么"。
// 数组按**实际元素**展开（chain → [0]/[1] → path/scope/content），空数组不展开。

/** 值树节点（结构来自契约，值来自本次注入） */
export interface ValueNode {
  /** 显示名：字段名；数组元素为 `[0]` */
  name: string;
  type: string;
  desc?: string;
  optional?: boolean;
  /** 实际值的单行紧凑文本（截断由 previewValue 负责） */
  value: string;
  /** 值不存在（未定义 / 空数组）：灰显示，便于一眼看出"这次没数据" */
  missing?: boolean;
  children?: ValueNode[];
}

/** 值树：按契约的路径逐段展开，段落上的值来自 value */
export function buildValueTree(schema: ZodType, value: unknown, name = ""): ValueNode[] {
  const { schema: inner } = unwrap(schema);
  const d = defOf(inner);
  if (d.type === "object" && d.shape) {
    return Object.entries(d.shape).map(([k, v]) => valueNodeOf(k, v, (value as Record<string, unknown>)?.[k]));
  }
  return name ? [valueNodeOf(name, inner, value)] : [];
}

function valueNodeOf(name: string, schema: ZodType, value: unknown): ValueNode {
  const { schema: inner, optional } = unwrap(schema);
  const d = defOf(inner);
  const type = d.type ?? "unknown";
  const desc = descOf(inner);
  if (type === "object" && d.shape) {
    const obj =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    return {
      name,
      type: "object",
      desc,
      optional,
      value: previewValue(value),
      missing: obj === undefined,
      children: Object.entries(d.shape).map(([k, v]) => valueNodeOf(k, v, obj?.[k])),
    };
  }
  if (type === "array" && d.element) {
    const arr = Array.isArray(value) ? value : [];
    const el = unwrap(d.element).schema;
    const elType = defOf(el).type ?? "unknown";
    const elLabel = metaIdOf(el) ?? elType;
    return {
      name,
      type: "array",
      desc,
      optional,
      value: arr.length === 0 ? "空数组" : `${arr.length} 项`,
      missing: arr.length === 0,
      children: arr.map((item, i) => {
        // 元素本身若还是对象 → 继续按契约展开它的字段（命名成 [0]/[1]，与"第几个"对上）
        const node = valueNodeOf(`[${i}]`, d.element!, item);
        return { ...node, name: `[${i}]`, type: node.type === "object" ? elLabel : node.type };
      }),
    };
  }
  return {
    name,
    type,
    desc,
    optional,
    value: previewValue(value),
    missing: value === undefined || value === null,
  };
}
