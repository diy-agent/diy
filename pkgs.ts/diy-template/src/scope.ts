// scope.ts — 作用域与路径解析
//
// 两个 scope 必须**真分开**（不是语法约定）：
//   globals  宿主提供的长期上下文（diy.* / task.* / 自定义 namespace）
//   dynamic  模版执行过程中产生的临时变量（:for 的循环变量、:include 的参数）
//
// 路径分流：以 `.` 开头 → 动态作用域；否则 → globals。
// 严格性：**首段必须存在**（否则 unresolved-path）；后续字段缺失返回 undefined（可选字段）。
// 这一条把「打错变量名」和「字段可选」区分开：前者报错，后者静默为假值。

import { TemplateError, type Loc } from './errors';

/** 一层动态作用域。`:for` 绑定**一个名字**（值是一个迭代信封）；`:include` 绑定参数集合 */
export interface DynamicFrame {
    vars: Record<string, unknown>;
}

export interface RenderContext {
    globals?: Record<string, unknown>;
    /** 由外到内的作用域链，最后一项是最内层 */
    dynamic?: DynamicFrame[];
}

/** 内部求值上下文（渲染期间只读，不改宿主传入的对象） */
export interface EvalContext {
    globals: Record<string, unknown>;
    frames: DynamicFrame[];
}

export function toEvalContext(ctx: RenderContext = {}): EvalContext {
    return { globals: ctx.globals ?? {}, frames: ctx.dynamic ? [...ctx.dynamic] : [] };
}

/** 真假值表（固定，见 SPEC §2.3）：false/null/undefined/""/[]/0 为假 */
export function isTruthy(value: unknown): boolean {
    if (value === false || value === null || value === undefined) return false;
    if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
    if (typeof value === 'string') return value !== '';
    if (Array.isArray(value)) return value.length > 0;
    return true;
}

/** 假值原因（进 trace，回答「这个 :if 为什么没进」） */
export function falsyReason(value: unknown): string {
    if (value === null || value === undefined) return '值为 null/undefined（字段缺失或未声明）';
    if (value === false) return '值为 false';
    if (typeof value === 'number') return '值为 0';
    if (typeof value === 'string') return '值为空字符串';
    if (Array.isArray(value)) return '值为空数组';
    return '值为假值';
}

/** 逐段取值；缺失返回 undefined（不报错，交由调用方决定严格性） */
function walk(base: unknown, segs: string[]): unknown {
    let cur = base;
    for (const seg of segs) {
        if (cur === null || cur === undefined) return undefined;
        if (typeof cur !== 'object') return undefined;
        if (!Object.hasOwn(cur as object, seg)) return undefined; // 用 hasOwn：防原型链命中（constructor 等）
        cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
}

function dynamicNames(frames: DynamicFrame[]): string {
    const names = new Set<string>();
    for (const f of frames) for (const k of Object.keys(f.vars)) names.add(k);
    return names.size > 0 ? [...names].join('、') : '（空）';
}

/** 解析路径取值；首段不存在 → 抛 unresolved-path */
export function resolvePath(path: string, ctx: EvalContext, loc: Loc, file?: string): unknown {
    if (path === '.') {
        throw new TemplateError('unresolved-path', '不再支持 {{.}}（歧义：哪一层循环？）', loc, {
            file,
            detail: '循环项写全：:for={{集合}} :as="f" 之后用 {{.f.value}}；序号 {{.f.index}}，首末 {{.f.isFirst}} / {{.f.isLast}}',
        });
    }

    if (path.startsWith('.')) {
        const segs = path.slice(1).split('.');
        const head = segs[0]!;
        for (let i = ctx.frames.length - 1; i >= 0; i--) {
            const f = ctx.frames[i]!;
            if (Object.hasOwn(f.vars, head)) return walk(f.vars[head], segs.slice(1));
        }
        throw new TemplateError('unresolved-path', `动态变量 .${head} 未声明`, loc, {
            file,
            detail: `当前动态作用域可用：${dynamicNames(ctx.frames)}；用 :for 或 :include 参数引入`,
        });
    }

    const segs = path.split('.');
    const head = segs[0]!;
    if (!Object.hasOwn(ctx.globals, head)) {
        const available = Object.keys(ctx.globals);
        throw new TemplateError('unresolved-path', `globals 里没有 ${head}`, loc, {
            file,
            detail: `可用 namespace：${available.length > 0 ? available.join('、') : '（空）'}`,
        });
    }
    return walk(ctx.globals[head], segs.slice(1));
}

/** 插值取值：undefined/null → 报错（可选值必须用 :if 守住，禁止静默空串） */
export function resolveForOutput(path: string, ctx: EvalContext, loc: Loc, file?: string): string {
    const value = resolvePath(path, ctx, loc, file);
    if (value === null || value === undefined) {
        throw new TemplateError('missing-value', `插值 {{${path}}} 的值是 null/undefined`, loc, {
            file,
            detail: '可选值请先用 :if / :if-not 守住；若确实可能缺失，检查路径是否写错',
        });
    }
    if (typeof value === 'object') {
        // 集合/对象直接插值 = 笔误（旧行为是静默 JSON.stringify，会静默产出 "[...]" 这种垃圾）
        const kind = Array.isArray(value) ? '数组' : '对象';
        throw new TemplateError('not-scalar', `插值 {{${path}}} 取到的是${kind}，不能直接插值`, loc, {
            file,
            detail: Array.isArray(value)
                ? `集合请用 <template :for={{${path}}} :as="x"> 迭代（项 {{.x.value}}，序号 {{.x.index}}）`
                : `请取具体字段（如 {{${path}.field}}）；确实要序列化时由调用方先物化成字符串`,
        });
    }
    return String(value);
}
