// analyze.ts — 静态分析（不渲染、不给任何数据）
//
// 用途（对应试验场的「变量 view」与 include 参数契约）：
//   1. 引用清单：这份模版引用了哪些 globals 路径、哪些动态路径、哪些 include、条件与循环
//   2. include 参数双向校验：传了没用的（unknown-arg）、用了没传的（missing-arg）
//   3. 打错字体检：条件名 / 参数名写错在这里就能发现，不必等渲染时静默为假

import type { ArgValue, Node } from './ast';
import type { Loc } from './errors';
import { CONTROL_ATTRS, parse, type ParseOptions } from './parser';

export interface PathRef {
    path: string;
    /** global = 无前缀（读 globals）；dynamic = . 前缀（读动态作用域） */
    scope: 'global' | 'dynamic';
    loc: Loc;
}

export interface IncludeRef {
    relpath: string;
    args: { name: string; value: ArgValue; loc: Loc }[];
    loc: Loc;
}

export interface ConditionRef {
    path: string;
    negate: boolean;
    loc: Loc;
}

export interface LoopRef {
    item: string;
    source: string;
    loc: Loc;
}

/** 体检提示（不阻断渲染，但要显式报给作者） */
export interface LintIssue {
    message: string;
    loc: Loc;
}

export interface Analysis {
    /** 全部路径引用（含属性内插值） */
    paths: PathRef[];
    /** globals 首段名字（去重、出现顺序） */
    globals: string[];
    /** 动态变量名（去重、出现顺序） */
    dynamics: string[];
    includes: IncludeRef[];
    conditions: ConditionRef[];
    loops: LoopRef[];
    lint: LintIssue[];
}

/** 文本节点内的偏移 → 绝对行列（lint 定位用） */
function locIn(text: string, start: Loc, index: number): Loc {
    const before = text.slice(0, index);
    const lines = before.split('\n');
    return lines.length === 1
        ? { line: start.line, col: start.col + index, offset: start.offset + index }
        : { line: start.line + lines.length - 1, col: lines[lines.length - 1]!.length + 1, offset: start.offset + index };
}

export function analyze(source: string, opts: ParseOptions = {}): Analysis {
    const hints: LintIssue[] = [];
    const out = analyzeNodes(
        parse(source, { ...opts, onStyleHint: (message, loc) => hints.push({ message, loc }) }),
    );
    out.lint.push(...hints);
    return out;
}

export function analyzeNodes(nodes: Node[]): Analysis {
    const out: Analysis = { paths: [], globals: [], dynamics: [], includes: [], conditions: [], loops: [], lint: [] };
    const seenGlobal = new Set<string>();
    const seenDynamic = new Set<string>();

    const addPath = (path: string, loc: Loc): void => {
        if (path === '.') {
            out.paths.push({ path, scope: 'dynamic', loc });
            return;
        }
        if (path.startsWith('.')) {
            const head = path.slice(1).split('.')[0]!;
            out.paths.push({ path, scope: 'dynamic', loc });
            if (!seenDynamic.has(head)) {
                seenDynamic.add(head);
                out.dynamics.push(head);
            }
            return;
        }
        const head = path.split('.')[0]!;
        out.paths.push({ path, scope: 'global', loc });
        if (!seenGlobal.has(head)) {
            seenGlobal.add(head);
            out.globals.push(head);
        }
    };

    const walk = (list: Node[]): void => {
        for (const n of list) {
            switch (n.type) {
                case 'text':
                    // 普通文本里的 :name= —— 输出标签不解析，控制属性写在这里会原样漏进提示词
                    for (const m of n.value.matchAll(/(?:^|\s):([a-z][\w-]*)\s*=/g)) {
                        const name = m[1]!;
                        const known = (CONTROL_ATTRS as readonly string[]).includes(name);
                        out.lint.push({
                            message: known
                                ? `控制属性 :${name} 写在了普通文本/标签里，不会被解析，会原样进提示词。` +
                                  `请改用控制标记包裹：<template :${name}="…">…</template>`
                                : `疑似控制属性拼错：:${name}（已知：${CONTROL_ATTRS.map((c) => ':' + c).join('/')}）。` +
                                  `它会被当普通文本原样进提示词`,
                            loc: locIn(n.value, n.loc, m.index ?? 0),
                        });
                    }
                    break;
                case 'interp':
                    addPath(n.path, n.loc);
                    break;
                case 'tag':
                    walk(n.children);
                    break;
                case 'if':
                    addPath(n.path, n.loc);
                    out.conditions.push({ path: n.path, negate: n.negate, loc: n.loc });
                    walk(n.children);
                    break;
                case 'for':
                    addPath(n.source, n.loc);
                    out.loops.push({ item: n.item, source: n.source, loc: n.loc });
                    walk(n.children);
                    break;
                case 'include':
                    for (const a of n.args) {
                        if (a.value.kind === 'expr') addPath(a.value.path, a.loc);
                        else {
                            walk(a.value.nodes);
                            // 迁移提示：值看起来是路径，但现在是字面量字符串（老写法 path=".f.path"）
                            const only = a.value.nodes.length === 1 && a.value.nodes[0]!.type === 'text' ? a.value.nodes[0]!.value : undefined;
                            if (only !== undefined && /^(\.$|\.\w|[A-Za-z_$][\w$]*\.)/.test(only)) {
                                out.lint.push({
                                    message:
                                        `参数 ${a.name}="${only}" 看起来是路径，但它是字面量字符串。` +
                                        `要取值请写 ${a.name}={{${only}}}`,
                                    loc: a.loc,
                                });
                            }
                        }
                    }
                    out.includes.push({ relpath: n.relpath, args: n.args.map((a) => ({ ...a })), loc: n.loc });
                    break;
            }
        }
    };

    walk(nodes);
    return out;
}

/**
 * 一份模版引用了哪些**动态名**（首段，去重）。
 * include 参数契约用它：参数名必须 ⊆ 这个集合，且这个集合里的每个名字都必须被传进来。
 */
export function collectDynamicRefs(nodes: Node[]): Set<string> {
    const set = new Set<string>();
    /** 本模版内被 :for 绑定的名字（含 index）——它们是循环变量，不是 include 参数 */
    let bound = new Set<string>();
    const add = (path: string): void => {
        if (!path.startsWith('.') || path === '.') return;
        const head = path.slice(1).split('.')[0]!;
        if (!bound.has(head)) set.add(head);
    };
    const walk = (list: Node[]): void => {
        for (const n of list) {
            switch (n.type) {
                case 'text':
                    break;
                case 'interp':
                    add(n.path);
                    break;
                case 'tag':
                    walk(n.children);
                    break;
                case 'if':
                    add(n.path);
                    walk(n.children);
                    break;
                case 'for': {
                    add(n.source);
                    const outer = bound;
                    bound = new Set([...outer, n.item, 'index', 'isFirst', 'isLast']);
                    walk(n.children);
                    bound = outer;
                    break;
                }
                case 'include':
                    // 参数来源在**调用方**作用域求值，但被调模版看到的是 .name；这里只算本模版自身的引用
                    for (const a of n.args) {
                        if (a.value.kind === 'expr') add(a.value.path);
                        else
                            for (const sub of a.value.nodes) {
                                if (sub.type === 'interp') add(sub.path);
                            }
                    }
                    break;
            }
        }
    };
    walk(nodes);
    return set;
}
