#!/usr/bin/env node
// scripts/facts-index.mts — 事实库真源的机械护栏（##404）
//
// 为什么需要它：事实库真正的敌人不是「没有库」，是**腐坏** —— 同一 claim 两个值、证据指向
// 已被删的文件、subject 自由长出同义词、被替代的事实还标 active。这些都不用人肉 review，
// 程序全看得出来；人只负责「这话对不对」。故本脚本只管机械判据，不管语义。
//
//   G1 schema 合法    —— subject / aspect / value / evidence / scope 形状（内核 validateFacts）
//   G2 图结构完整      —— id 唯一 / claim 冲突 / 边悬空 / supersedes 成环（内核 buildIndex）
//   G3 subject 受控    —— fact.subject 必须在 knowledge/subjects.yaml 登记（新词先 review）
//   G4 证据可解析      —— evidence.at 的 `<路径>:<行>` 必须真存在（仓库相对 或 `~/` 开头）
//   G5 probe 档齐备    —— source=probe 必须有 evidence.probe（否则「验证过」是空话）
//   W1 证据陈旧        —— verifiedAt 超过 --max-age 天（缺省 180）= warning，不算失败
//
// 为什么 G3/G4 在脚本而不在内核：它们要读**仓库布局**（文件在不在、词表在不在），内核是纯的
// （不 IO，见 pkgs.ts/diy-facts/AGENTS.md）—— 布局与治理归本项目。
//
// G4 是本脚本最值钱的一条：文档世界最贵的腐坏形态是「指针还在、指向的东西没了」，
// 而它完全可由机器判定（`check-specs` 的 G2 同理，那条治的是规范索引）。
//
// 真源布局：
//   knowledge/subjects.yaml     受控词表（subject → description / aliases）
//   knowledge/facts/<域>.yaml   `{ domain, facts: [...] }`（也接受裸数组）
//   knowledge/index.json        `--write` 生成的缓存（**不进 git**：随时可重建，进 git 只是噪声）
//
// 用法：
//   npx tsx scripts/facts-index.mts                     校验（默认，供 ./sha.sh check 调用）
//   npx tsx scripts/facts-index.mts --write             顺带落 knowledge/index.json
//   npx tsx scripts/facts-index.mts --json              打印索引（调试 / 工具消费）
//   npx tsx scripts/facts-index.mts --dir /tmp/kb       指向别处的真源（可测性 / 演练）
//   npx tsx scripts/facts-index.mts --as-of 2026-01-01 --max-age 90
//
// 退出码：0 = 通过（warning 不影响）· 1 = 有 error
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { load } from 'js-yaml';
import { buildIndex, validateFacts, type Fact } from '@diy/facts';

const ROOT = path.resolve(import.meta.dirname, '..');

interface Problem {
    readonly level: 'error' | 'warning';
    readonly code: string;
    readonly detail: string;
    readonly facts?: readonly string[];
}

function readYaml(file: string): unknown {
    try {
        return load(readFileSync(file, 'utf8'));
    } catch (err) {
        throw new Error(`${file}: YAML 解析失败：${(err as Error).message}`);
    }
}

/** 收集 `knowledge/facts/*.yaml` 里的原始条目（尚未校验）；`origin` 与 `items` 平行，只为报错能指回文件 */
function collectRaw(dir: string): { items: unknown[]; origin: string[]; files: string[] } {
    const factsDir = path.join(dir, 'facts');
    const files = readdirSync(factsDir)
        .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        .sort()
        .map((f) => path.join(factsDir, f));
    const items: unknown[] = [];
    const origin: string[] = [];
    for (const file of files) {
        const doc = readYaml(file) as { facts?: unknown[] } | unknown[] | null;
        const list = Array.isArray(doc) ? doc : (doc?.facts ?? []);
        if (!Array.isArray(list)) throw new Error(`${file}: 期望 { domain, facts: [...] } 或裸数组`);
        for (const item of list) {
            items.push(item);
            origin.push(path.relative(ROOT, file));
        }
    }
    return { items, origin, files };
}

/** G3：subject 必须在词表里；词表里的死条目反向提示 */
function checkSubjects(facts: readonly Fact[], dir: string): Problem[] {
    const out: Problem[] = [];
    const vocabFile = path.join(dir, 'subjects.yaml');
    if (!existsSync(vocabFile)) {
        out.push({ level: 'error', code: 'facts/vocab-missing', detail: `缺词表：${vocabFile}` });
        return out;
    }
    const doc = readYaml(vocabFile) as { subjects?: Record<string, unknown> } | null;
    const vocab = new Set(Object.keys(doc?.subjects ?? {}));
    const used = new Set(facts.map((f) => f.subject));
    for (const subject of used) {
        if (!vocab.has(subject)) {
            out.push({
                level: 'error',
                code: 'facts/subject-unregistered',
                detail: `subject 未登记词表：${subject}（先加进 knowledge/subjects.yaml —— 图的有效性取决于主语规范化）`,
                facts: facts.filter((f) => f.subject === subject).map((f) => f.id),
            });
        }
    }
    for (const subject of vocab) {
        if (!used.has(subject)) {
            out.push({
                level: 'warning',
                code: 'facts/subject-unused',
                detail: `词表里的 subject 无任何 fact 使用：${subject}（词表在撒谎，或该条已该删）`,
            });
        }
    }
    return out;
}

/** G4 / G5 / W1：证据可解析、probe 档齐备、证据陈旧 */
function checkEvidence(facts: readonly Fact[], asOf: Date, maxAgeDays: number): Problem[] {
    const out: Problem[] = [];
    const home = os.homedir();
    for (const f of facts) {
        const ev = f.evidence;
        if (ev.source === 'probe' && (ev.probe === undefined || ev.probe === '')) {
            out.push({
                level: 'error',
                code: 'facts/probe-missing',
                detail: `${f.id}: source=probe 但没给 evidence.probe（「验证过」必须有命令）`,
                facts: [f.id],
            });
        }
        if (ev.at !== undefined) {
            const m = /^(.*):(\d+)$/.exec(ev.at);
            if (m === null) {
                out.push({
                    level: 'error',
                    code: 'facts/evidence-format',
                    detail: `${f.id}: evidence.at 必须是 <路径>:<行>，实际 ${ev.at}`,
                    facts: [f.id],
                });
            } else {
                const rawPath = m[1] as string;
                const line = Number(m[2]);
                const abs = rawPath.startsWith('~/') ? path.join(home, rawPath.slice(2)) : path.resolve(ROOT, rawPath);
                if (!existsSync(abs)) {
                    out.push({
                        level: 'error',
                        code: 'facts/evidence-missing',
                        detail: `${f.id}: evidence.at 指向的文件不存在：${rawPath}`,
                        facts: [f.id],
                    });
                } else {
                    const lines = readFileSync(abs, 'utf8').split('\n').length;
                    if (line < 1 || line > lines) {
                        out.push({
                            level: 'error',
                            code: 'facts/evidence-line',
                            detail: `${f.id}: ${rawPath}:${line} 越界（该文件共 ${lines} 行）`,
                            facts: [f.id],
                        });
                    }
                }
            }
        }
        const verifiedAt = ev.verifiedAt;
        if (verifiedAt !== undefined) {
            const t = Date.parse(verifiedAt);
            if (Number.isNaN(t)) {
                out.push({
                    level: 'error',
                    code: 'facts/verified-at-format',
                    detail: `${f.id}: evidence.verifiedAt 不是合法日期：${verifiedAt}`,
                    facts: [f.id],
                });
            } else {
                const days = Math.floor((asOf.getTime() - t) / 86_400_000);
                if (days > maxAgeDays) {
                    out.push({
                        level: 'warning',
                        code: 'facts/stale',
                        detail: `${f.id}: 证据已 ${days} 天未复核（> ${maxAgeDays}）—— 要么重核，要么把这条 retire`,
                        facts: [f.id],
                    });
                }
            }
        }
    }
    return out;
}

function main(argv: readonly string[]): number {
    const arg = (name: string): string | undefined => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const dir = path.resolve(arg('--dir') ?? path.join(ROOT, 'knowledge'));
    const asOf = arg('--as-of') !== undefined ? new Date(arg('--as-of') as string) : new Date();
    const maxAgeDays = Number(arg('--max-age') ?? 180);
    if (Number.isNaN(asOf.getTime())) {
        console.error(`✗ --as-of 不是合法日期：${arg('--as-of')}`);
        return 1;
    }

    const { items, origin, files } = collectRaw(dir);
    /** schema 报错的 detail 形如 `[3].value: ...`，把 [3] 换成「文件 [3]」方便定位 */
    const withOrigin = (detail: string): string =>
        detail.replace(/^\[(\d+)\]/, (m, n: string) => `${origin[Number(n)] ?? '?'} ${m}`);
    const problems: Problem[] = [];

    // G1 schema：内核一次报全部（含未知字段 / 缺必填）
    const { facts, issues: schemaIssues } = validateFacts(items);
    for (const i of schemaIssues)
        problems.push({ level: 'error', code: i.code, detail: withOrigin(i.detail), ...(i.facts ? { facts: i.facts } : {}) });

    // G2 图结构：id 唯一 / 冲突 / 悬空 / 成环
    const index = buildIndex(facts);
    for (const i of index.issues) problems.push({ level: 'error', code: i.code, detail: i.detail, ...(i.facts ? { facts: i.facts } : {}) });
    for (const c of index.conflicts) {
        problems.push({
            level: 'error',
            code: 'facts/scope-conflict',
            detail: `${c.claim} @ ${c.scopeKey === '' ? '(全局)' : c.scopeKey} 有 ${c.values.length} 个值并存：${c.values.join(' / ')}`,
            facts: c.facts,
        });
    }

    problems.push(...checkSubjects(facts, dir));
    problems.push(...checkEvidence(facts, asOf, maxAgeDays));

    const errors = problems.filter((p) => p.level === 'error');
    const warnings = problems.filter((p) => p.level === 'warning');
    for (const p of [...errors, ...warnings]) {
        console.log(`  ${p.level === 'error' ? '✗' : '⚠'} [${p.code}] ${p.detail}`);
    }
    if (errors.length > 0) {
        const codes = [...new Set(errors.map((e) => e.code))].join(', ');
        console.error(`[facts] ✗ ${errors.length} error / ${warnings.length} warning（${codes}）`);
        return 1;
    }

    if (argv.includes('--json') || argv.includes('--write')) {
        const claims: Record<string, string[]> = {};
        for (const [k, v] of [...index.claims].sort(([a], [b]) => a.localeCompare(b))) claims[k] = [...v];
        const backlinks: Record<string, string[]> = {};
        for (const [k, v] of index.backlinks) backlinks[k] = [...v];
        const payload = {
            _note: '生成物，勿手改（npx tsx scripts/facts-index.mts --write）。真源 = knowledge/facts/*.yaml',
            sources: files.map((f) => path.relative(ROOT, f)),
            counts: { facts: facts.length, claims: index.claims.size },
            claims,
            backlinks,
        };
        const text = `${JSON.stringify(payload, null, 2)}\n`;
        if (argv.includes('--json')) process.stdout.write(text);
        if (argv.includes('--write')) {
            const out = path.join(dir, 'index.json');
            mkdirSync(path.dirname(out), { recursive: true });
            writeFileSync(out, text);
        }
    }

    const subjects = new Set(facts.map((f) => f.subject)).size;
    console.log(
        `[facts] ✅ 通过（${facts.length} facts / ${subjects} subject / ${index.claims.size} claim，${files.length} 文件 · ${warnings.length} warning）`,
    );
    return 0;
}

process.exit(main(process.argv.slice(2)));
