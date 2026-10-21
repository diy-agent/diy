// src/node/project.ts — 事实的**投影**（真源 → 给 LLM 看的形态）—— ##404
//
// 真源是 `knowledge/facts/*.yaml`（一行一 fact、靠 `scope` 表达变体）；
// 投影是它面向读取侧的**视图**：把变体解析成当前值、按命名空间分组、可裁剪。
//
// 三条原则：
//   ① **投影可换算法**（`ProjectionAlgorithm`）—— 同真源多种渲染，A/B 实测哪种
//      对模型更省 token / 更好用。加算法 = 加一个 render 分支，不动真源与判据。
//   ② **投影给"已解析值"而不是变体列表** —— 让 agent 读 `18888` 却不知道自己在 lab
//      就会踩坑；故非唯一/非全局的条目带 `resolvedBy`（按什么解析出来的）与
//      `variants`（还有几个变体），由它自己决定要不要追问。
//   ③ **投影不具身份**：gid 才是身份（审计锚点 / 跨库引用 / 迁移）。投影只是能重算的视图。

import { dump } from 'js-yaml';
import { claimOf } from '../claim';
import { formatGid, formatNs, nsRank, type Ns } from '../ns';
import { resolveClaim, type ReadCtx } from '../resolve';
import { scopeKey } from '../scope';
import type { FactsErrorCode, Fact } from '../types';

export const PROJECTION_ALGORITHMS = ['yaml-nested', 'flat-gid', 'md-list'] as const;
export type ProjectionAlgorithm = (typeof PROJECTION_ALGORITHMS)[number];

export interface ProjectEntry {
    readonly ns: Ns;
    readonly fact: Fact;
}

export interface ProjectInput {
    readonly entries: readonly ProjectEntry[];
    /** 解析上下文：变体按它挑选（缺省 = 全局语义） */
    readonly ctx?: ReadCtx;
    readonly algorithm?: ProjectionAlgorithm;
    /** 预算上限（字节）；超了按 ns 优先级（task > project > global）从尾部裁 */
    readonly maxBytes?: number;
    /**
     * 渲染成 `{value, resolvedBy, variants}` 还是裸标量。
     * 缺省 `auto`：唯一且全局的条目渲染成裸标量（省字节），其余结构化。
     */
    readonly shape?: 'auto' | 'always-object';
}

export interface ProjectItem {
    readonly gid: string;
    readonly claim: string;
    readonly ns: Ns;
    readonly value: string;
    /** 变体解析依据（`scopeKey` 形态；空串 = 全局事实） */
    readonly resolvedBy: string;
    /** 同 claim 的可读变体总数（>1 表示还有别的值存在） */
    readonly variants: number;
}

export interface ProjectProblem {
    readonly gid: string;
    readonly code: FactsErrorCode;
    readonly detail?: string;
}

export interface ProjectOutput {
    readonly algorithm: ProjectionAlgorithm;
    readonly text: string;
    readonly bytes: number;
    readonly shown: readonly string[];
    /** 被预算裁掉的（条数太多时的取舍，不影响正确性） */
    readonly omitted: readonly string[];
    /** 当前 scope 下不适用而跳过的（**正常**：路径型事实在别的目录就该消失） */
    readonly skipped: readonly string[];
    /** 真问题：冲突 / 库内无此 claim —— 这类**必须**让调用方看见 */
    readonly problems: readonly ProjectProblem[];
}

function groupByNs(entries: readonly ProjectEntry[]): Map<string, { ns: Ns; facts: Fact[] }> {
    const out = new Map<string, { ns: Ns; facts: Fact[] }>();
    for (const e of entries) {
        const k = formatNs(e.ns);
        const g = out.get(k);
        if (g === undefined) out.set(k, { ns: e.ns, facts: [e.fact] });
        else g.facts.push(e.fact);
    }
    return out;
}

function isReadable(f: Fact, includeProposed: boolean): boolean {
    if (f.lifecycle !== 'active') return false;
    return f.review === 'accepted' || (includeProposed && f.review === 'proposed');
}

/** 解析出投影条目（同库同 claim 只出一条：取当前 scope 下最特定的活跃事实） */
export function projectItems(input: ProjectInput): {
    items: readonly ProjectItem[];
    skipped: readonly string[];
    problems: readonly ProjectProblem[];
} {
    const ctx = input.ctx ?? {};
    const includeProposed = ctx.includeProposed === true;
    const items: ProjectItem[] = [];
    const problems: ProjectProblem[] = [];
    const skipped: string[] = [];

    for (const { ns, facts } of groupByNs(input.entries).values()) {
        const claims = [...new Set(facts.filter((f) => isReadable(f, includeProposed)).map((f) => claimOf(f)))];
        for (const claim of claims) {
            const r = resolveClaim(facts, claim, ctx);
            const gid = formatGid(ns, claim);
            if (!r.ok) {
                // 三档处置（投影 ≠ 校验）：`scope-no-match` 是「当前上下文不适用」，
                // 路径型 / 环境型事实在别的上下文里本就该消失 —— 静默跳过，不当问题。
                // 只有「库里没这 claim」与「同 scope 两值」才是库坏了。
                if (r.code === 'facts/scope-no-match') skipped.push(gid);
                else problems.push({ gid, code: r.code, ...(r.detail === undefined ? {} : { detail: r.detail }) });
                continue;
            }
            const variants = facts.filter((f) => claimOf(f) === claim && isReadable(f, includeProposed)).length;
            items.push({ gid, claim, ns, value: r.value.value, resolvedBy: scopeKey(r.value.scope), variants });
        }
    }

    items.sort((a, b) => nsRank(a.ns) - nsRank(b.ns) || a.gid.localeCompare(b.gid));
    return { items, skipped, problems };
}

function cell(item: ProjectItem, shape: 'auto' | 'always-object'): unknown {
    const plain = item.variants === 1 && item.resolvedBy === '';
    if (shape === 'auto' && plain) return item.value;
    return {
        value: item.value,
        resolvedBy: item.resolvedBy === '' ? 'global' : item.resolvedBy,
        variants: item.variants,
    };
}

function render(algorithm: ProjectionAlgorithm, items: readonly ProjectItem[], shape: 'auto' | 'always-object'): string {
    if (algorithm === 'md-list') {
        const lines = items.map((i) => {
            const tag = i.variants === 1 && i.resolvedBy === '' ? '' : `  (${i.resolvedBy === '' ? 'global' : i.resolvedBy}${i.variants > 1 ? `, ${i.variants} 变体` : ''})`;
            return `- \`${i.gid}\` — ${i.value}${tag}`;
        });
        return lines.join('\n');
    }

    if (algorithm === 'flat-gid') {
        const flat: Record<string, unknown> = {};
        for (const i of items) flat[i.gid] = cell(i, shape);
        return dump({ facts: flat }, { noRefs: true, lineWidth: -1, quoteStyle: 'single' }).trimEnd();
    }

    // yaml-nested（缺省）：父节点 = 命名空间，子键 = claim（两者拼起来就是 gid）
    const tree: Record<string, Record<string, unknown>> = {};
    for (const i of items) {
        const nsKey = formatNs(i.ns);
        const bucket = tree[nsKey] ?? (tree[nsKey] = {});
        bucket[i.claim] = cell(i, shape);
    }
    return dump({ facts: tree }, { noRefs: true, lineWidth: -1, quoteStyle: 'single' }).trimEnd();
}

/**
 * 投影入口。预算裁剪**按条目**（不是截断文本）—— 截断会产生半条事实，
 * 比少一条更糟。裁掉的 gid 由 `omitted` 交代，调用方可据此提示"还有 N 条未展示"。
 */
export function project(input: ProjectInput): ProjectOutput {
    const algorithm = input.algorithm ?? 'yaml-nested';
    const shape = input.shape ?? 'auto';
    const { items, skipped, problems } = projectItems(input);
    const maxBytes = input.maxBytes ?? Number.POSITIVE_INFINITY;

    let shown = items;
    let text = render(algorithm, shown, shape);
    let bytes = Buffer.byteLength(text, 'utf8');
    while (bytes > maxBytes && shown.length > 0) {
        shown = shown.slice(0, -1);
        text = render(algorithm, shown, shape);
        bytes = Buffer.byteLength(text, 'utf8');
    }

    const shownGids = new Set(shown.map((i) => i.gid));
    return {
        algorithm,
        text,
        bytes,
        shown: shown.map((i) => i.gid),
        omitted: items.filter((i) => !shownGids.has(i.gid)).map((i) => i.gid),
        skipped,
        problems,
    };
}
