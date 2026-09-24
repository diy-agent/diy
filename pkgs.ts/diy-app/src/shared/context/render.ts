// src/shared/context/render.ts
// 🎯 把 Context Tree 渲染成**投递文本**（纯函数）。
//
// 渲染单元 = 「place 子树里的叶子 path」∪「显式声明 template 的 path」：
//   · 叶子（标量/数组/空对象）→ YAML dump
//   · template 声明 → @diy/template 渲染，作用域 = **整棵值树**（144：依赖图是未来优化，
//     不是第一版正确性的依据 —— 所以一律按全局作用域渲染，值变就重算，再由 renderedHash
//     判定「这次到底有没有变」）
//
// YAML 自己实现而不引 js-yaml：输出必须**逐字节可预测**（golden 测试要拿它当基准），
// 且 shared/ 要能进 renderer 包（零 node 依赖）。

import { render as renderTemplate } from "@diy/template";
import { hasValue, isPlainObject } from "./tree";
import type { ContextPath, ContextTreeState } from "./types";

const YAML_RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "~", ""]);

/** 标量 → YAML 字面量（该加引号就加，保证可回读） */
function scalar(v: unknown): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v !== "string") return JSON.stringify(v);
    const plain = /^[A-Za-z0-9_/][A-Za-z0-9_\-./@ :]*$/.test(v) && !YAML_RESERVED.has(v);
    return plain ? v : JSON.stringify(v);
}

/** 值 → YAML 文本（缩进 2 空格；空对象/空数组渲染成 `{}` / `[]`，与「无值」区分） */
export function toYaml(v: unknown, indent = 0): string {
    const pad = "  ".repeat(indent);
    if (Array.isArray(v)) {
        if (v.length === 0) return `${pad}[]`;
        return v
            .map((item) => {
                const lines = toYaml(item, indent + 1).split("\n");
                lines[0] = `${pad}- ${lines[0].slice((indent + 1) * 2)}`;
                return lines.join("\n");
            })
            .join("\n");
    }
    if (isPlainObject(v)) {
        const keys = Object.keys(v);
        if (keys.length === 0) return `${pad}{}`;
        return keys
            .map((k) => {
                const val = v[k];
                if (isPlainObject(val) && Object.keys(val).length > 0) {
                    return `${pad}${k}:\n${toYaml(val, indent + 1)}`;
                }
                if (Array.isArray(val) && val.length > 0) {
                    return `${pad}${k}:\n${toYaml(val, indent + 1)}`;
                }
                return `${pad}${k}: ${scalar(val)}`;
            })
            .join("\n");
    }
    return `${pad}${scalar(v)}`;
}

/**
 * 值树里某个子树的所有叶子 path（相对根的完整 path）。
 * `present` = 该 path 在值树里**确实有值**（undefined 视为无）——「没有值」与「值是 null /
 * 空对象」是两回事：前者不产出渲染单元（模板节点就是这种），后者要渲染成 `null` / `{}`。
 */
export function leafPaths(values: unknown, base = "", present = true): ContextPath[] {
    if (!isPlainObject(values) || Object.keys(values).length === 0) {
        return present && base ? [base] : [];
    }
    const out: ContextPath[] = [];
    for (const [k, v] of Object.entries(values)) {
        const path = base ? `${base}.${k}` : k;
        if (isPlainObject(v) && Object.keys(v).length > 0) out.push(...leafPaths(v, path, true));
        else out.push(path);
    }
    return out;
}

/** 取子树（path 处的值） */
function subtreeAt(values: Record<string, unknown>, path: ContextPath): unknown {
    let cur: unknown = values;
    for (const seg of path.split(".")) {
        if (!isPlainObject(cur)) return undefined;
        cur = cur[seg];
    }
    return cur;
}

/** 一个 place 里的渲染单元：叶子 path ∪ template 声明 path，字典序（golden 稳定） */
export function renderUnitsOf(state: ContextTreeState, place: ContextPath): ContextPath[] {
    const sub = subtreeAt(state.values, place);
    const leaves = leafPaths(sub, place, hasValue(state, place));
    const templates = Object.keys(state.renderers).filter(
        (p) => state.renderers[p].renderer === "template" && (p === place || p.startsWith(`${place}.`)),
    );
    return [...new Set([...leaves, ...templates])].sort();
}

/** 渲染单个单元（template 用 source，其余 YAML dump 值） */
export function renderUnit(state: ContextTreeState, path: ContextPath): string {
    const spec = state.renderers[path];
    if (spec?.renderer === "template") {
        return renderTemplate(spec.source, { globals: state.values });
    }
    const value = subtreeAt(state.values, path);
    if (spec?.renderer === "text") return typeof value === "string" ? value : String(value ?? "");
    return toYaml(value);
}

/** 渲染一个 place → 文本块（每个单元用 <context path="..."> 包裹，路径即身份） */
export function renderPlace(state: ContextTreeState, place: ContextPath): string {
    const units = renderUnitsOf(state, place);
    if (units.length === 0) return "";
    return units
        .map((p) => `<context path="${p}">\n${renderUnit(state, p)}\n</context>`)
        .join("\n");
}

/** 渲染一组 place → 投递文本（place 之间空行分隔；空 place 不产出） */
export function renderPlaces(state: ContextTreeState, places: readonly ContextPath[]): string {
    return places
        .map((p) => renderPlace(state, p))
        .filter((t) => t.length > 0)
        .join("\n\n");
}

/** 单个 place 的 renderedHash 来源文本（空 place 用空串，与「内容为空」区分靠 path 表） */
export function placeText(state: ContextTreeState, place: ContextPath): string {
    return renderPlace(state, place);
}
