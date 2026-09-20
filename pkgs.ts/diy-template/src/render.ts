// render.ts — 渲染（+ 结构 trace）
//
// 三条硬规则：
//   1. **不做任何 trim / 不删行 / 不转义**：模版怎么写就怎么进提示词（逐字节可预测）
//   2. 控制节点（<template>）不产出任何字符
//   3. include 创建**新的**动态作用域（只含参数），不继承调用者的动态链；globals 全程可见

import { analyzeNodes, collectDynamicRefs } from './analyze';
import type { IncludeNode, Node } from './ast';
import { TemplateError } from './errors';
import { parse } from './parser';
import {
    falsyReason,
    isTruthy,
    resolveForOutput,
    resolvePath,
    toEvalContext,
    type DynamicFrame,
    type EvalContext,
    type RenderContext,
} from './scope';

/** include 目标（由宿主注册表提供：项目覆盖 > 内置 + 白名单） */
export interface IncludeTarget {
    source: string;
    /** 锁定模版（不可被可覆盖模版 include） */
    locked?: boolean;
}

export interface IncludeResolver {
    /** 返回 null = 不存在 / 不在白名单 */
    resolve(relpath: string): IncludeTarget | null;
}

export interface RenderOptions {
    /** 入口模版 relpath（错误定位用） */
    file?: string;
    /** 入口模版自身是否锁定（锁定模版可以 include 锁定模版） */
    locked?: boolean;
    resolver?: IncludeResolver;
    /** include 嵌套上限（入口算 1 层），默认 8 */
    maxDepth?: number;
}

export type TraceKind = 'text' | 'interp' | 'element' | 'if' | 'for' | 'for-item' | 'include';

export interface TraceNode {
    kind: TraceKind;
    /** 元素名 / 路径 / relpath */
    name?: string;
    /** 本节点产出字节数 */
    bytes: number;
    /** :if / :if-not 的实际结果 */
    result?: boolean;
    /** 结果原因（假值原因 / 迭代次数 / 被省略等） */
    reason?: string;
    children?: TraceNode[];
}

export interface RenderResult {
    text: string;
    trace: TraceNode[];
}

const DEFAULT_MAX_DEPTH = 8;

/** UTF-8 字节数（Node 与浏览器通用） */
export function byteLength(text: string): number {
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(text, 'utf-8');
    return new TextEncoder().encode(text).length;
}

/** 渲染为字符串（不需要诊断信息时用这个） */
export function render(source: string, ctx: RenderContext = {}, opts: RenderOptions = {}): string {
    return new Renderer(opts).renderEntry(source, ctx).text;
}

/** 渲染 + 结构 trace（试验场「结构树」用） */
export function renderWithTrace(source: string, ctx: RenderContext = {}, opts: RenderOptions = {}): RenderResult {
    return new Renderer(opts).renderEntry(source, ctx);
}

class Renderer {
    /** 当前模版链（entry 在最前），用于循环检测与错误定位 */
    private readonly includeStack: string[] = [];
    private readonly lockedStack: boolean[] = [];
    private readonly cache = new Map<string, { source: string; nodes: Node[]; refs: Set<string> }>();
    private readonly maxDepth: number;

    constructor(private readonly opts: RenderOptions) {
        this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
        this.includeStack.push(opts.file ?? '<entry>');
        this.lockedStack.push(Boolean(opts.locked));
    }

    renderEntry(source: string, ctx: RenderContext): RenderResult {
        const nodes = parse(source, { file: this.opts.file });
        const trace: TraceNode[] = [];
        const text = this.renderNodes(nodes, toEvalContext(ctx), trace);
        return { text, trace };
    }

    // ── 渲染 ──────────────────────────────────────────────────────────

    private currentFile(): string | undefined {
        return this.includeStack[this.includeStack.length - 1];
    }

    private renderNodes(nodes: Node[], ctx: EvalContext, sink: TraceNode[] | null): string {
        let out = '';
        for (const n of nodes) {
            out += this.renderNode(n, ctx, sink);
        }
        return out;
    }

    private renderNode(n: Node, ctx: EvalContext, sink: TraceNode[] | null): string {
        switch (n.type) {
            case 'text':
                if (sink && n.value !== '') sink.push({ kind: 'text', bytes: byteLength(n.value) });
                return n.value;

            case 'interp': {
                const text = resolveForOutput(n.path, ctx, n.loc, this.currentFile());
                sink?.push({ kind: 'interp', name: n.path, bytes: byteLength(text) });
                return text;
            }

            case 'tag': {
                const node: TraceNode = { kind: 'element', name: n.head.match(/^<([^\s>]+)/)?.[1], bytes: 0, children: [] };
                const childSink: TraceNode[] = [];
                const text = `${n.head}${this.renderNodes(n.children, ctx, childSink)}${n.headClose}`;
                node.bytes = byteLength(text);
                node.children = childSink;
                sink?.push(node);
                return text;
            }

            case 'if': {
                const value = resolvePath(n.path, ctx, n.loc, this.currentFile());
                const result = n.negate ? !isTruthy(value) : isTruthy(value);
                const node: TraceNode = {
                    kind: 'if',
                    name: `${n.negate ? ':if-not' : ':if'}(${n.path})`,
                    bytes: 0,
                    result,
                    reason: result
                        ? n.negate
                            ? `取反后为真（${falsyReason(value)}）`
                            : '值为真'
                        : n.negate
                          ? '值为真，取反后为假'
                          : falsyReason(value),
                    children: [],
                };
                const childSink: TraceNode[] = [];
                const text = result ? this.renderNodes(n.children, ctx, childSink) : '';
                node.bytes = byteLength(text);
                node.children = childSink;
                sink?.push(node);
                return text;
            }

            case 'for': {
                const value = resolvePath(n.source, ctx, n.loc, this.currentFile());
                if (!Array.isArray(value)) {
                    throw new TemplateError('not-iterable', `:for 的数据源不是数组：${n.source}`, n.loc, {
                        file: this.currentFile(),
                        detail: `实际类型：${value === null ? 'null' : typeof value}`,
                    });
                }
                const node: TraceNode = { kind: 'for', name: `for ${n.item} in ${n.source}`, bytes: 0, children: [] };
                let out = '';
                for (let i = 0; i < value.length; i++) {
                    const frame: DynamicFrame = {
                        vars: { [n.item]: value[i] },
                        item: value[i],
                        index: i,
                        first: i === 0,
                        last: i === value.length - 1,
                    };
                    const iterCtx: EvalContext = { globals: ctx.globals, frames: [...ctx.frames, frame] };
                    const iterSink: TraceNode[] = [];
                    const text = this.renderNodes(n.children, iterCtx, iterSink);
                    node.children!.push({
                        kind: 'for-item',
                        name: `${n.item}[${i}]`,
                        bytes: byteLength(text),
                        children: iterSink,
                    });
                    out += text;
                }
                node.reason = `迭代 ${value.length} 次`;
                node.bytes = byteLength(out);
                sink?.push(node);
                return out;
            }

            case 'include':
                return this.renderInclude(n, ctx, sink);
        }
    }

    // ── include ───────────────────────────────────────────────────────

    private renderInclude(n: IncludeNode, ctx: EvalContext, sink: TraceNode[] | null): string {
        const relpath = n.relpath;
        // 双保险：解析期已校验，这里再校验一次（引擎不信任外部构造的 AST）
        if (!relpath.startsWith('./') || relpath.includes('..') || relpath.startsWith('/')) {
            throw new TemplateError('include', `include 路径非法：${relpath}`, n.loc, { file: this.currentFile() });
        }
        if (this.includeStack.includes(relpath)) {
            throw new TemplateError('include-cycle', `include 循环引用：${relpath}`, n.loc, {
                file: this.currentFile(),
                detail: `链：${[...this.includeStack, relpath].join(' → ')}`,
            });
        }
        if (this.includeStack.length >= this.maxDepth) {
            throw new TemplateError('depth', `include 嵌套超过 ${this.maxDepth} 层`, n.loc, {
                file: this.currentFile(),
                detail: `链：${this.includeStack.join(' → ')}`,
            });
        }
        const target = this.opts.resolver?.resolve(relpath) ?? null;
        if (!target) {
            throw new TemplateError('include', `模版不存在或不在白名单：${relpath}`, n.loc, {
                file: this.currentFile(),
                detail: 'include 必须由宿主注册表解析（项目覆盖 > 内置），且在白名单内',
            });
        }
        const callerLocked = this.lockedStack[this.lockedStack.length - 1] ?? false;
        if (target.locked && !callerLocked) {
            throw new TemplateError('locked', `不可 include 锁定模版：${relpath}`, n.loc, {
                file: this.currentFile(),
                detail: '锁定模版（如 _guard.md）只能由同样锁定的入口模版 include',
            });
        }

        // 参数在**调用方**作用域求值：整值单个插值 → 原类型；文本 → 渲染成字符串
        const args: Record<string, unknown> = {};
        for (const a of n.args) {
            args[a.name] =
                a.value.kind === 'expr'
                    ? resolvePath(a.value.path, ctx, a.loc, this.currentFile())
                    : this.renderNodes(a.value.nodes, ctx, null);
        }

        const { nodes, refs } = this.parseInclude(relpath, target.source);
        this.checkArgs(n, refs, relpath);

        this.includeStack.push(relpath);
        this.lockedStack.push(Boolean(target.locked));
        const trace: TraceNode[] = [];
        const text = this.renderNodes(nodes, { globals: ctx.globals, frames: [{ vars: args }] }, trace);
        this.includeStack.pop();
        this.lockedStack.pop();

        sink?.push({ kind: 'include', name: relpath, bytes: byteLength(text), children: trace });
        return text;
    }

    /** include 参数双向校验：传了没用的 / 用了没传的 —— 都在这里报错，不静默 */
    private checkArgs(n: IncludeNode, refs: Set<string>, relpath: string): void {
        const passed = new Set(n.args.map((a) => a.name));
        // 先报「少传」：它直接指向被调模版里那个没拿到的名字，最有指向性
        for (const ref of refs) {
            if (!passed.has(ref)) {
                throw new TemplateError('missing-arg', `include ${relpath} 缺少参数 ${ref}`, n.loc, {
                    file: this.currentFile(),
                    detail: `该模版引用了 .${ref}；请写成 ${ref}={{.${ref}}}（或传入合适的值）`,
                });
            }
        }
        for (const a of n.args) {
            if (!refs.has(a.name)) {
                throw new TemplateError('unknown-arg', `include ${relpath} 没有引用参数 ${a.name}`, a.loc, {
                    file: this.currentFile(),
                    detail: `该模版引用的动态名：${refs.size > 0 ? [...refs].join('、') : '（无）'}`,
                });
            }
        }
    }

    private parseInclude(relpath: string, source: string): { nodes: Node[]; refs: Set<string> } {
        const hit = this.cache.get(relpath);
        if (hit && hit.source === source) return hit;
        const nodes = parse(source, { file: relpath });
        const refs = collectDynamicRefs(nodes);
        // 顺带做一次静态分析，保证 include 里的路径问题在解析期就暴露（analyzeNodes 会抛语法错）
        analyzeNodes(nodes);
        const entry = { source, nodes, refs };
        this.cache.set(relpath, entry);
        return entry;
    }
}
