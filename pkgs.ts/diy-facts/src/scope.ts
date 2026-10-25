// scope.ts — 作用域三轴：归一 / 匹配 / 特定度
//
// 「变体」真正的表达力落在这里，不落 YAML 缩进（##404）：
// 同一 claim 的多个 fact 按 scope 并存，读取时按**当前上下文**挑出唯一值。
//
// 匹配是**相交**而非包含（实测纠偏：首版写成子集，`env: ['development','test']` 在
// ctx `{env:'test'}` 下被判不匹配 —— 数组在这里是**析取**（「这些环境都适用」），不是合取）：
//   - fact 声明的轴必须在 ctx 里有同类声明，且两边**有交集**
//   - ctx 未声明某轴 ⇒ 该轴 scoped 的 fact 查不到（宁可「查不到」也别「误用别的模块的结论」）

import type { Scope, Env } from './types';

export function envsOf(scope?: Scope): readonly Env[] {
    if (scope?.env === undefined) return [];
    return Array.isArray(scope.env) ? (scope.env as readonly Env[]) : [scope.env as Env];
}

/** 归一键：轴序固定、数组排序 ⇒ 同一 scope 恒得同一串（用于判重 / 判冲突） */
export function scopeKey(scope?: Scope): string {
    if (scope === undefined) return '';
    const parts: string[] = [];
    const vs = [...envsOf(scope)].sort();
    if (vs.length > 0) parts.push(`env=${vs.join(',')}`);
    if (scope.task !== undefined && scope.task !== '') parts.push(`task=${scope.task}`);
    const ps = [...(scope.paths ?? [])].sort();
    if (ps.length > 0) parts.push(`paths=${ps.join(',')}`);
    return parts.join('|');
}

export function scopeEqual(a?: Scope, b?: Scope): boolean {
    return scopeKey(a) === scopeKey(b);
}

/** 前缀匹配按**路径段边界**：`src/aa` 不覆盖 `src/aaa` */
export function pathCovers(prefix: string, file: string): boolean {
    const p = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    const f = file.endsWith('/') ? file.slice(0, -1) : file;
    return f === p || f.startsWith(`${p}/`);
}

/** fact 的 scope 是否被当前上下文覆盖（严格子集） */
export function scopeMatches(scope: Scope | undefined, ctx: Scope): boolean {
    if (scope === undefined) return true;

    const fv = envsOf(scope);
    if (fv.length > 0) {
        const cv = envsOf(ctx);
        if (cv.length === 0) return false;
        if (!fv.some((v) => cv.includes(v))) return false;
    }

    if (scope.task !== undefined && scope.task !== '') {
        if (ctx.task !== scope.task) return false;
    }

    const fp = scope.paths ?? [];
    if (fp.length > 0) {
        const cp = ctx.paths ?? [];
        if (cp.length === 0) return false;
        if (!fp.some((p) => cp.some((f) => pathCovers(p, f)))) return false;
    }

    return true;
}

/**
 * 特定度 = 声明的轴数。多条命中时取最大者；
 * 并列且值不同 = `facts/scope-conflict`（不是「随机挑一条」）。
 */
export function scopeSpecificity(scope?: Scope): number {
    if (scope === undefined) return 0;
    let n = 0;
    if (envsOf(scope).length > 0) n += 1;
    if (scope.task !== undefined && scope.task !== '') n += 1;
    if ((scope.paths ?? []).length > 0) n += 1;
    return n;
}
