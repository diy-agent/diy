// expose.ts — 主题的**暴露档**：决定一个 subject 在上下文里露多少（##404）
//
// 为什么需要它：`yaml-nested` 投影有 4 KB 预算，而实测 `rule` 一个 subject 就 9.3 KB。
// 于是"subject 级 expose + 固定预算"自相矛盾 —— 只能装 0.4 个 rule，且溢出是**静默**的
// （`omitted: 131` 装不下但没人说）。本模块把它换成**声明式 + 硬校验**：
//   ① 每 subject 声明 `full | index | none`（缺省 index）
//   ② `full` 的字节和超过预算 ⇒ 当场报错，不许沉默超限
//
// 三档的语义（别混）：
//   full  —— 正文进 `runtime.facts`（**常驻**，每一轮都付这个字节）
//   index —— 只在 `runtime.kb` 一行（索引级：知道"库里有这个话题"，要值就查）
//   none  —— 两处都不给，只能 `facts get` / `brief`（临时性 / 体量太大）
//
// 判据（##5 实测账）：搬走一条 X 字节的规则每轮省 X，但查它一次 ≈ 一次完整请求的
// 前缀重发（41 KB）。故 `full` 给"每轮都要知道"的，`index` 给"知道有、偶尔查"的。
import type { Fact } from './types';

export const EXPOSE_LEVELS = ['full', 'index', 'none'] as const;
export type ExposeLevel = (typeof EXPOSE_LEVELS)[number];

/** 没写 expose 的 subject 落哪档：**index**（自动进索引，不抢正文预算） */
export const DEFAULT_EXPOSE: ExposeLevel = 'index';

/** `full` 档的字节预算（与 `buildFactsContext` 的 `DEFAULT_FACTS_MAX_BYTES` 同一个数） */
export const DEFAULT_FULL_BUDGET = 4000;

/** subject → 档位（缺省档不出现在表里，读侧用 `exposeOf`） */
export type ExposeMap = Readonly<Record<string, ExposeLevel>>;

export function exposeOf(map: ExposeMap, subject: string): ExposeLevel {
    return map[subject] ?? DEFAULT_EXPOSE;
}

/** 一条事实**会不会**进投影正文：只有可用（active + accepted）的才占预算 */
export function isUsable(fact: Fact): boolean {
    return fact.lifecycle === 'active' && fact.review === 'accepted';
}

/**
 * 值的字节数（UTF-8；预算是按字节算的，`String.length` 对中文少算一半）。
 * 手算而不 `Buffer.byteLength`：内核零 Node 依赖（renderer 也 import 它）。
 */
export function bytesOf(value: string): number {
    let n = 0;
    for (const ch of value) {
        const c = ch.codePointAt(0) ?? 0;
        n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    }
    return n;
}

export interface SubjectWeight {
    readonly subject: string;
    readonly claims: number;
    readonly facts: number;
    /** 可用事实的 value 字节之和 —— 就是它进 `full` 档时占的量 */
    readonly bytes: number;
}

/**
 * 按 subject 汇总权重（**只算可用事实**）。
 *
 * 为什么按 subject 而不是 claim：expose 的最小单元是 subject（claim 级配置是下一个
 * 数量级的负担，人也说不出"这 30 条里哪条必须每轮看"—— 说不出就说明该按"读谁"重组主题）。
 */
export function weightsOf(facts: readonly Fact[]): SubjectWeight[] {
    const acc = new Map<string, { claims: Set<string>; facts: number; bytes: number }>();
    for (const f of facts) {
        if (!isUsable(f)) continue;
        const cell = acc.get(f.subject) ?? { claims: new Set<string>(), facts: 0, bytes: 0 };
        cell.claims.add(f.aspect);
        cell.facts += 1;
        cell.bytes += bytesOf(f.value);
        acc.set(f.subject, cell);
    }
    return [...acc.entries()]
        .map(([subject, c]) => ({ subject, claims: c.claims.size, facts: c.facts, bytes: c.bytes }))
        .sort((a, b) => b.bytes - a.bytes || a.subject.localeCompare(b.subject));
}

export interface ExposeProblem {
    readonly code: string;
    readonly detail: string;
    readonly facts?: readonly string[];
}

/**
 * 校验 expose 配置：**`full` 档的字节和 > 预算 = 错误**（不是警告）。
 *
 * 为什么不许沉默超限：今天 `omitted: 131` 这种"装不下但没人说"的状态，正是
 * "配置与预算脱节"的证据 —— 配额从"先到先得"换成"声明式 + 硬校验"后，
 * 超限必须有人在写的时候改主意，而不是等到某轮发现知识没带上。
 */
export function checkExpose(
    facts: readonly Fact[],
    map: ExposeMap,
    opts: { budget?: number } = {},
): ExposeProblem[] {
    const budget = opts.budget ?? DEFAULT_FULL_BUDGET;
    const weights = weightsOf(facts);
    const unknown = Object.keys(map).filter((s) => EXPOSE_LEVELS.every((l) => map[s] !== l));
    const problems: ExposeProblem[] = [];
    if (unknown.length > 0) {
        problems.push({
            code: 'facts/expose-level',
            detail: `expose 档位非法（只认 ${EXPOSE_LEVELS.join(' / ')}）：${unknown.join(', ')}`,
        });
    }
    const full = weights.filter((w) => exposeOf(map, w.subject) === 'full');
    const used = full.reduce((n, w) => n + w.bytes, 0);
    if (used > budget) {
        problems.push({
            code: 'facts/expose-budget',
            detail:
                `expose: full 的字节和 ${used} 超预算 ${budget}（${full.map((w) => `${w.subject} ${w.bytes}B`).join(' · ')}）` +
                ` —— 把最大的降到 index，或把主题拆细（每主题 ≤ ${Math.floor(budget / 4)} B）`,
            facts: full.map((w) => `${w.subject}#*`),
        });
    }
    return problems;
}
