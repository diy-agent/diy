// validate.ts — 未知输入 → Fact[]（CLI / RPC 的唯一入口）
//
// 设计取舍：**一次报全部问题**，不「抛第一个」。
// 理由：agent 提的是一批，逐条返工（改一条跑一次）比一次给全清单贵得多。
// 未知字段一律报错（拼错 `verifedAt` 若被静默丢弃，探针就永远不跑）。

import { derivedFactId } from './claim.js';
import type { Issue } from './index-build';
import type { Env, Evidence, Fact, FactsErrorCode, Format, Ref, Scope } from './types';

export interface Validation {
    readonly facts: readonly Fact[];
    readonly issues: readonly Issue[];
}

const REVIEWS = ['proposed', 'accepted', 'rejected'] as const;
const LIFECYCLES = ['active', 'superseded', 'expired'] as const;
const SOURCES = ['user', 'probe', 'code', 'inference'] as const;
const ENVS = ['production', 'development', 'test'] as const;
const FORMATS = ['md', 'json'] as const;

const FACT_KEYS = new Set(['id', 'subject', 'aspect', 'value', 'format', 'scope', 'review', 'lifecycle', 'evidence', 'refs']);

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): v is string {
    return typeof v === 'string' && v.trim() !== '';
}

function issuePath(path: string): string {
    return path === '' ? '(根)' : path;
}

export function validateFacts(input: unknown): Validation {
    const facts: Fact[] = [];
    const issues: { code: FactsErrorCode; detail: string; facts?: readonly string[] }[] = [];

    const bad = (code: FactsErrorCode, path: string, msg: string, ids?: readonly string[]): void => {
        issues.push({ code, detail: `${issuePath(path)}: ${msg}`, ...(ids ? { facts: ids } : {}) });
    };

    if (!Array.isArray(input)) {
        bad('facts/schema', '', '输入必须是事实数组');
        return { facts, issues };
    }

    input.forEach((raw: unknown, i: number) => {
        const at = `[${i}]`;
        if (!isObj(raw)) {
            bad('facts/schema', at, '每条事实必须是对象');
            return;
        }
        for (const k of Object.keys(raw)) {
            if (!FACT_KEYS.has(k)) bad('facts/schema', `${at}.${k}`, '未知字段（拼错了？）');
        }

        const id = raw.id;
        if (id !== undefined && !nonEmpty(id)) {
            bad('facts/schema', `${at}.id`, '若给出必须是非空字符串（缺省 = `<subject>#<aspect>`）');
            return;
        }
        const ids = nonEmpty(id) ? [id as string] : [];

        const subject = raw.subject;
        const aspect = raw.aspect;
        const value = raw.value;
        if (!nonEmpty(subject)) bad('facts/schema', `${at}.subject`, '必填非空字符串', ids);
        if (typeof subject === 'string' && subject.includes('#')) {
            bad('facts/schema', `${at}.subject`, '不得含 `#`（claim 分隔符）', ids);
        }
        if (typeof subject === 'string' && subject.includes(':')) {
            bad('facts/schema', `${at}.subject`, '不得含 `:`（命名空间/gid 分隔符）', ids);
        }
        if (!nonEmpty(aspect)) bad('facts/schema', `${at}.aspect`, '必填非空字符串', ids);
        if (typeof aspect === 'string' && aspect.includes('#')) {
            bad('facts/schema', `${at}.aspect`, '不得含 `#`（claim 分隔符）', ids);
        }
        if (typeof aspect === 'string' && aspect.includes(':')) {
            bad('facts/schema', `${at}.aspect`, '不得含 `:`（命名空间/gid 分隔符）', ids);
        }
        if (typeof value !== 'string') bad('facts/schema', `${at}.value`, '必填字符串', ids);

        // 值的读取格式（缺省 md 不落盘）。`json` 当场解析 —— 契约类事实写错一个逗号，
        // 让它在 submit 就炸，而不是等消费侧拼 URL 时才发现。
        const format = raw.format;
        if (format !== undefined) {
            if (typeof format !== 'string' || !(FORMATS as readonly string[]).includes(format)) {
                bad('facts/schema', `${at}.format`, `必须是 ${FORMATS.join(' | ')}（缺省 md，不必写）`, ids);
            } else if (format === 'json' && typeof value === 'string') {
                try {
                    JSON.parse(value);
                } catch (e) {
                    bad('facts/value-format', `${at}.value`, `format=json 但值解析失败：${(e as Error).message}`, ids);
                }
            }
        }

        const review = raw.review ?? 'accepted';
        const lifecycle = raw.lifecycle ?? 'active';
        if (typeof review !== 'string' || !(REVIEWS as readonly string[]).includes(review)) {
            bad('facts/schema', `${at}.review`, `必须是 ${REVIEWS.join(' | ')}`, ids);
        }
        if (typeof lifecycle !== 'string' || !(LIFECYCLES as readonly string[]).includes(lifecycle)) {
            bad('facts/schema', `${at}.lifecycle`, `必须是 ${LIFECYCLES.join(' | ')}`, ids);
        }

        const evidence = raw.evidence;
        if (!isObj(evidence)) {
            bad('facts/schema', `${at}.evidence`, '必填对象（来源与证据）', ids);
        } else {
            const source = evidence.source;
            if (typeof source !== 'string' || !(SOURCES as readonly string[]).includes(source)) {
                bad('facts/schema', `${at}.evidence.source`, `必须是 ${SOURCES.join(' | ')}`, ids);
            }
            if (source === 'probe' && !nonEmpty(evidence.probe)) {
                bad('facts/schema', `${at}.evidence.probe`, 'source=probe 时探针命令必填', ids);
            }
            for (const k of ['at', 'probe', 'probeDigest', 'verifiedAt']) {
                if (evidence[k] !== undefined && typeof evidence[k] !== 'string') {
                    bad('facts/schema', `${at}.evidence.${k}`, '必须是字符串', ids);
                }
            }
        }

        const scope = raw.scope === undefined ? undefined : normalizeScope(raw.scope, at, ids, bad);

        const refs = raw.refs === undefined ? undefined : normalizeRefs(raw.refs, at, ids, bad);

        if (issues.length > 0) return;

        facts.push({
            id: nonEmpty(id) ? (id as string) : derivedFactId({ subject: subject as string, aspect: aspect as string, ...(scope === undefined ? {} : { scope }) }),
            subject: subject as string,
            aspect: aspect as string,
            value: value as string,
            ...(format === 'json' ? { format: format as Format } : {}),
            review: review as Fact['review'],
            lifecycle: lifecycle as Fact['lifecycle'],
            evidence: evidence as Evidence,
            ...(scope === undefined ? {} : { scope }),
            ...(refs === undefined ? {} : { refs }),
        });
    });

    return { facts, issues };
}

type Bad = (code: FactsErrorCode, path: string, msg: string, ids?: readonly string[]) => void;

function normalizeScope(raw: unknown, at: string, ids: readonly string[], bad: Bad): Scope | undefined {
    if (!isObj(raw)) {
        bad('facts/schema', `${at}.scope`, '必须是对象', ids);
        return undefined;
    }
    const out: { env?: Env | Env[]; paths?: string[]; task?: string } = {};

    for (const k of Object.keys(raw)) {
        if (!['env', 'paths', 'task'].includes(k)) {
            bad('facts/schema', `${at}.scope.${k}`, '未知字段（三轴只有 env / paths / task）', ids);
        }
    }

    const v = raw.env;
    if (v !== undefined) {
        const list = Array.isArray(v) ? v : [v];
        if (list.some((x) => typeof x !== 'string' || !(ENVS as readonly string[]).includes(x))) {
            bad('facts/schema', `${at}.scope.env`, `必须是 ${ENVS.join(' | ')} 或其数组`, ids);
        } else {
            out.env = Array.isArray(v) ? (v as Env[]) : (v as Env);
        }
    }

    const ps = raw.paths;
    if (ps !== undefined) {
        if (!Array.isArray(ps) || ps.some((x) => typeof x !== 'string' || x.trim() === '')) {
            bad('facts/schema', `${at}.scope.paths`, '必须是非空字符串数组', ids);
        } else {
            out.paths = ps as string[];
        }
    }

    const task = raw.task;
    if (task !== undefined) {
        if (typeof task !== 'string' || task.trim() === '') {
            bad('facts/schema', `${at}.scope.task`, '必须是非空字符串', ids);
        } else {
            out.task = task;
        }
    }

    return out;
}

function normalizeRefs(raw: unknown, at: string, ids: readonly string[], bad: Bad): Ref[] | undefined {
    if (!Array.isArray(raw)) {
        bad('facts/schema', `${at}.refs`, '必须是数组', ids);
        return undefined;
    }
    const out: Ref[] = [];
    raw.forEach((r: unknown, j: number) => {
        const rat = `${at}.refs[${j}]`;
        if (!isObj(r)) {
            bad('facts/schema', rat, '必须是对象', ids);
            return;
        }
        const rel = r.rel;
        const data = r.data;
        if (!isObj(data)) {
            bad('facts/schema', `${rat}.data`, '必须放在 data 里（判别键同级只放公共字段）', ids);
            return;
        }
        if (rel === 'depends-on') {
            if (!nonEmpty(data.toClaim) || !String(data.toClaim).includes('#')) {
                bad('facts/schema', `${rat}.data.toClaim`, '必须是 `subject#aspect`', ids);
                return;
            }
            const when = data.when === undefined ? undefined : normalizeScope(data.when, `${rat}.data.when`, ids, bad);
            out.push({
                rel: 'depends-on',
                data: { toClaim: data.toClaim as string, ...(when === undefined ? {} : { when }) },
            });
            return;
        }
        if (rel === 'supersedes') {
            if (!nonEmpty(data.toFactId)) {
                bad('facts/schema', `${rat}.data.toFactId`, '必须是非空 fact id', ids);
                return;
            }
            const within =
                data.within === undefined ? undefined : normalizeScope(data.within, `${rat}.data.within`, ids, bad);
            out.push({
                rel: 'supersedes',
                data: {
                    toFactId: data.toFactId as string,
                    ...(within === undefined ? {} : { within }),
                },
            });
            return;
        }
        bad('facts/schema', `${rat}.rel`, `未知关系：${String(rel)}（首期只支持 depends-on / supersedes）`, ids);
    });
    return out;
}
