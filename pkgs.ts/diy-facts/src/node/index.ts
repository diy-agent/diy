// src/node/index.ts — 事实库的**存储层**（读 / 校验 / 事务写入）—— ##404
//
// 与内核的分工：内核（src/*）纯函数、不 IO；本入口做**仓库布局**相关的事：
//   - 读 `knowledge/subjects.yaml` + `knowledge/facts/*.yaml`
//   - 校验里需要"文件在不在 / 行号越不越界"那几条（G3/G4/G5/W1）
//   - 事务写入：整批校验全过才落盘（tmp + rename），一条不过整批拒
//
// 为什么把它做成包的子入口而不是塞进 diy-app：**同一条判据有两个消费者**
// （CLI/RPC 的 `diy facts`，和 `./sha.sh check` 里的 `scripts/facts-index.mts`）。
// 判据写两份必然分叉 —— 而"判据分叉"正是本任务要治的病。
//
// 写入策略（为什么整篇重写而不是打补丁）：文件是**生成物式的真源** —— 条目顺序、
// 字段顺序、缩进全由本文件的 canonical 函数决定。手动留的注释会被冲掉，故文件头注
// 改由文档里的 `note` 字段生成（真源里就不能只活在注释里）。这样 `git diff` 恒为
// "条目级"变更，不会因为谁手工排了序而整篇翻红。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dump, load } from 'js-yaml';
import { buildIndex, validateFacts } from '../index.js';
import type { Evidence, Fact, Ref, Scope } from '../types.js';

export {
    PROJECTION_ALGORITHMS,
    project,
    projectItems,
    type ProjectEntry,
    type ProjectionAlgorithm,
    type ProjectInput,
    type ProjectItem,
    type ProjectOutput,
    type ProjectProblem,
} from './project';

/** 校验问题（与 check 脚本 / CLI 同一形状；`level=warning` 不阻断） */
export interface RepoProblem {
    readonly level: 'error' | 'warning';
    readonly code: string;
    readonly detail: string;
    readonly facts?: readonly string[];
}

export interface SubjectDef {
    readonly key: string;
    readonly description?: string;
    readonly aliases?: readonly string[];
}

export interface Repo {
    /** `knowledge/` 目录的绝对路径 */
    readonly dir: string;
    /** 仓库根（`knowledge/` 的父目录）—— 证据路径按它解析 */
    readonly root: string;
    /** `knowledge/facts/*.yaml` 绝对路径（已排序） */
    readonly files: readonly string[];
    readonly facts: readonly Fact[];
    /** fact id → 真源文件（绝对路径），用于判断"改哪一篇"与报错定位 */
    readonly origin: ReadonlyMap<string, string>;
    /** 每篇的文档头注（`note`），写入时原样回写 */
    readonly notes: ReadonlyMap<string, string>;
    /** 每篇的 domain（`note` 之外的第二个文件级字段） */
    readonly domains: ReadonlyMap<string, string>;
    readonly subjects: readonly SubjectDef[];
    readonly schemaIssues: readonly RepoProblem[];
}

/** 解析失败 / 布局缺失：属于"环境不对"，直接 throw（带 code，见 rule.err-triage.code） */
export class FactsRepoError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'FactsRepoError';
    }
}

/**
 * 取文件**开头那段注释**（`# ...` 连续行）当文档头注。
 *
 * 为什么需要：首批三篇是真手写的（头注里写着"为什么这条要这么记"），一旦写入改成
 * 整篇重写，这些注释必须有去处 —— 让 `note` 缺省值 = 现有头注，第一次写入就自动收编，
 * 不必人工迁移一遍（也就不会因为迁移而丢注释）。
 */
function leadingComments(text: string): string {
    const lines: string[] = [];
    for (const line of text.split('\n')) {
        if (line.startsWith('#')) lines.push(line.replace(/^# ?/, ''));
        else if (line.trim() === '' && lines.length === 0) continue;
        else break;
    }
    return lines.join('\n').trimEnd();
}

function readYaml(file: string): unknown {
    try {
        return load(readFileSync(file, 'utf8'));
    } catch (err) {
        throw new FactsRepoError('facts/yaml-parse', `${file}: YAML 解析失败：${(err as Error).message}`);
    }
}

/** 装载真源。目录不存在 = 环境问题（不是"空库"）：静默当空库会让 `submit` 写到别处 */
export function loadRepo(knowledgeDir: string): Repo {
    const dir = path.resolve(knowledgeDir);
    const factsDir = path.join(dir, 'facts');
    if (!existsSync(factsDir)) {
        throw new FactsRepoError('facts/repo-missing', `事实库真源不存在：${factsDir}（--dir 指错？）`);
    }
    const subjectsFile = path.join(dir, 'subjects.yaml');
    const subjects: SubjectDef[] = [];
    if (existsSync(subjectsFile)) {
        const doc = readYaml(subjectsFile) as { subjects?: Record<string, { description?: string; aliases?: string[] }> } | null;
        for (const [key, def] of Object.entries(doc?.subjects ?? {})) {
            subjects.push({ key, ...(def?.description ? { description: def.description } : {}), ...(def?.aliases ? { aliases: def.aliases } : {}) });
        }
    }

    const files = readdirSync(factsDir)
        .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        .sort()
        .map((f) => path.join(factsDir, f));

    const raw: unknown[] = [];
    const origin = new Map<string, string>();
    const notes = new Map<string, string>();
    const domains = new Map<string, string>();
    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        const doc = readYaml(file) as { domain?: string; note?: string; facts?: unknown[] } | unknown[] | null;
        const list = Array.isArray(doc) ? doc : (doc?.facts ?? []);
        if (!Array.isArray(list)) throw new FactsRepoError('facts/yaml-shape', `${file}: 期望 { domain, facts: [...] } 或裸数组`);
        if (!Array.isArray(doc)) {
            // 空头注不落 map：留给 renderDoc 用「文件名」兜底（否则会写出一个空的 `#` 行）
            const note = typeof doc?.note === 'string' ? doc.note : leadingComments(text);
            if (note !== '') notes.set(file, note);
            if (typeof doc?.domain === 'string') domains.set(file, doc.domain);
        }
        for (const item of list) {
            if (typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string') {
                origin.set((item as { id: string }).id, file);
            }
            raw.push(item);
        }
    }

    const { facts, issues } = validateFacts(raw);
    return {
        dir,
        root: path.dirname(dir),
        files,
        facts,
        origin,
        notes,
        domains,
        subjects,
        schemaIssues: issues.map((i) => ({ level: 'error' as const, code: i.code, detail: i.detail, ...(i.facts ? { facts: i.facts } : {}) })),
    };
}

/** 证据路径解析：`~/…` 走 home，其余按仓库根 */
function resolveEvidencePath(root: string, raw: string): string {
    return raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : path.resolve(root, raw);
}

/**
 * 全量校验（G1…W1）。`facts` 可传"候选集"——`submit` 落盘前先拿候选集跑一遍同样的判据，
 * 保证「能写进去的」与「check 会通过的」是同一套规则（否则 CLI 能过、CI 红）。
 */
export function checkFacts(
    facts: readonly Fact[],
    opts: { subjects: readonly SubjectDef[]; root: string; asOf?: Date; maxAgeDays?: number },
): RepoProblem[] {
    const problems: RepoProblem[] = [];
    const asOf = opts.asOf ?? new Date();
    const maxAgeDays = opts.maxAgeDays ?? 180;

    // G2：id 唯一 / claim 冲突 / 边悬空 / supersedes 成环
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

    // G3：subject 受控词表（图的有效性取决于主语规范化）
    const vocab = new Set(opts.subjects.map((s) => s.key));
    const used = new Set(facts.map((f) => f.subject));
    for (const subject of used) {
        if (!vocab.has(subject)) {
            problems.push({
                level: 'error',
                code: 'facts/subject-unregistered',
                detail: `subject 未登记词表：${subject}（先 submit 一条 subject —— 图的有效性取决于主语规范化）`,
                facts: facts.filter((f) => f.subject === subject).map((f) => f.id),
            });
        }
    }
    for (const s of vocab) {
        if (!used.has(s)) problems.push({ level: 'warning', code: 'facts/subject-unused', detail: `词表里的 subject 无任何 fact 使用：${s}` });
    }

    // G4 / G5 / W1：证据可解析、probe 档齐备、证据陈旧
    for (const f of facts) {
        const ev = f.evidence;
        if (ev.source === 'probe' && (ev.probe === undefined || ev.probe === '')) {
            problems.push({ level: 'error', code: 'facts/probe-missing', detail: `${f.id}: source=probe 但没给 evidence.probe`, facts: [f.id] });
        }
        if (ev.at !== undefined) {
            const m = /^(.*):(\d+)$/.exec(ev.at);
            if (m === null) {
                problems.push({ level: 'error', code: 'facts/evidence-format', detail: `${f.id}: evidence.at 必须是 <路径>:<行>，实际 ${ev.at}`, facts: [f.id] });
            } else {
                const abs = resolveEvidencePath(opts.root, m[1] as string);
                const line = Number(m[2]);
                if (!existsSync(abs)) {
                    problems.push({ level: 'error', code: 'facts/evidence-missing', detail: `${f.id}: evidence.at 指向的文件不存在：${m[1]}`, facts: [f.id] });
                } else {
                    const lines = readFileSync(abs, 'utf8').split('\n').length;
                    if (line < 1 || line > lines) {
                        problems.push({ level: 'error', code: 'facts/evidence-line', detail: `${f.id}: ${m[1]}:${line} 越界（该文件共 ${lines} 行）`, facts: [f.id] });
                    }
                }
            }
        }
        if (ev.verifiedAt !== undefined) {
            const t = Date.parse(ev.verifiedAt);
            if (Number.isNaN(t)) {
                problems.push({ level: 'error', code: 'facts/verified-at-format', detail: `${f.id}: evidence.verifiedAt 不是合法日期：${ev.verifiedAt}`, facts: [f.id] });
            } else if ((asOf.getTime() - t) / 86_400_000 > maxAgeDays) {
                problems.push({
                    level: 'warning',
                    code: 'facts/stale',
                    detail: `${f.id}: 证据已 ${Math.floor((asOf.getTime() - t) / 86_400_000)} 天未复核（> ${maxAgeDays}）`,
                    facts: [f.id],
                });
            }
        }
    }
    return problems;
}

/** 装载 + 全量校验（脚本与 CLI 都走这一个入口） */
export function checkRepo(knowledgeDir: string, opts: { asOf?: Date; maxAgeDays?: number } = {}): {
    repo: Repo;
    problems: readonly RepoProblem[];
} {
    const repo = loadRepo(knowledgeDir);
    const problems = [
        ...repo.schemaIssues,
        ...checkFacts(repo.facts, { subjects: repo.subjects, root: repo.root, ...opts }),
    ];
    return { repo, problems };
}

// ── 写入 ──────────────────────────────────────────────────────────────

/** 字段顺序固化（少了它，谁先写谁定顺序，diff 会整篇翻红） */
function canonicalFact(f: Fact): Record<string, unknown> {
    const out: Record<string, unknown> = { id: f.id, subject: f.subject, aspect: f.aspect, value: f.value };
    if (f.scope !== undefined) out['scope'] = canonicalScope(f.scope);
    out['review'] = f.review;
    out['lifecycle'] = f.lifecycle;
    const ev: Record<string, unknown> = { source: f.evidence.source };
    if (f.evidence.probe !== undefined) ev['probe'] = f.evidence.probe;
    if (f.evidence.probeDigest !== undefined) ev['probeDigest'] = f.evidence.probeDigest;
    if (f.evidence.at !== undefined) ev['at'] = f.evidence.at;
    if (f.evidence.verifiedAt !== undefined) ev['verifiedAt'] = f.evidence.verifiedAt;
    out['evidence'] = ev;
    if (f.refs !== undefined && f.refs.length > 0) out['refs'] = f.refs.map(canonicalRef);
    return out;
}

function canonicalScope(s: Scope): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (s.env !== undefined) out['env'] = s.env;
    if (s.paths !== undefined) out['paths'] = s.paths;
    if (s.task !== undefined) out['task'] = s.task;
    return out;
}

function canonicalRef(r: Ref): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    if (r.rel === 'depends-on') {
        data['toClaim'] = r.data.toClaim;
        if (r.data.when !== undefined) data['when'] = canonicalScope(r.data.when);
    } else {
        data['toFactId'] = r.data.toFactId;
        if (r.data.within !== undefined) data['within'] = canonicalScope(r.data.within);
    }
    return { rel: r.rel, data };
}

/** claim 的第一段 = 文件域（`app.port` → `app.yaml`）：省掉一个必须手填的字段 */
export function domainOf(f: Fact): string {
    const head = f.subject.split('.')[0];
    return head !== undefined && head !== '' ? head : 'misc';
}

function sortFacts(facts: readonly Fact[]): Fact[] {
    return [...facts].sort((a, b) => {
        const ka = `${a.subject}#${a.aspect}|${a.id}`;
        const kb = `${b.subject}#${b.aspect}|${b.id}`;
        return ka.localeCompare(kb);
    });
}

/** 一篇真源的完整文本（头注来自 `note`，条目由 canonical + 排序决定） */
export function renderDoc(opts: { note?: string; domain: string; facts: readonly Fact[] }): string {
    const head = (opts.note ?? `knowledge/facts/${opts.domain}.yaml`)
        .split('\n')
        .map((l) => `# ${l}`.trimEnd())
        .join('\n');
    const body = dump(
        { domain: opts.domain, facts: sortFacts(opts.facts).map(canonicalFact) },
        { noRefs: true, lineWidth: -1, quoteStyle: 'single' },
    );
    return `${head}\n\n# 生成物式的真源：整篇由 \`diy facts submit\` 写入（字段顺序、条目排序都由程序定）。\n${body}`;
}

/** 写入报告：`--dry-run` 与真写走同一条路径，区别只在最后是否落盘 */
export interface SubmitReport {
    readonly dryRun: boolean;
    readonly added: readonly string[];
    readonly updated: readonly { readonly id: string; readonly before: string; readonly after: string }[];
    readonly unchanged: readonly string[];
    readonly newSubjects: readonly string[];
    /** 每篇的字节变化（`path → [before, after]`） */
    readonly files: readonly { readonly file: string; readonly before: number; readonly after: number }[];
}

export interface SubmitInput {
    /** 待写入的事实（已由内核 validateFacts 转换过） */
    readonly facts: readonly Fact[];
    /** 新增/修订的 subject（词表扩展也走同一个事务，免得"事实先落地、词表后补"的中间态） */
    readonly subjects?: readonly SubjectDef[];
    /** subject 词表里的 description 缺失时是否允许落（缺省拒：description 是词表唯一人读信息） */
    readonly dryRun?: boolean;
}

/**
 * 整批事务：**全过才写**。
 *
 * 为什么原子：agent 一轮会提 3~10 条，第 4 条写错了却把前 3 条落了盘 —— 人看到的是
 * "部分生效"，下一轮 agent 读到半截状态又会重复提。宁可整批退，让它重提。
 */
export function submit(knowledgeDir: string, input: SubmitInput): { report: SubmitReport; problems: readonly RepoProblem[] } {
    const repo = loadRepo(knowledgeDir);

    // 1) 候选事实集：同 id 覆盖（审计锚点稳定），新 id 追加
    const byId = new Map(repo.facts.map((f) => [f.id, f]));
    const added: string[] = [];
    const updated: { id: string; before: string; after: string }[] = [];
    const unchanged: string[] = [];
    for (const f of input.facts) {
        const prev = byId.get(f.id);
        if (prev === undefined) {
            added.push(f.id);
            byId.set(f.id, f);
        } else if (JSON.stringify(canonicalFact(prev)) === JSON.stringify(canonicalFact(f))) {
            unchanged.push(f.id);
        } else {
            updated.push({ id: f.id, before: `${prev.value}${prev.scope ? ` @${JSON.stringify(canonicalScope(prev.scope))}` : ''}`, after: `${f.value}${f.scope ? ` @${JSON.stringify(canonicalScope(f.scope))}` : ''}` });
            byId.set(f.id, f);
        }
    }

    // 2) 候选词表
    const subjectMap = new Map(repo.subjects.map((s) => [s.key, s]));
    const newSubjects: string[] = [];
    for (const s of input.subjects ?? []) {
        const prev = subjectMap.get(s.key);
        if (prev === undefined) newSubjects.push(s.key);
        subjectMap.set(s.key, { ...prev, ...s });
    }
    const subjects = [...subjectMap.values()];

    // 3) 候选集跑**同一套判据**（与 ./sha.sh check 一致）
    const candidate = [...byId.values()];
    const schema = validateFacts(candidate);
    const problems: RepoProblem[] = [
        ...schema.issues.map((i) => ({ level: 'error' as const, code: i.code, detail: i.detail, ...(i.facts ? { facts: i.facts } : {}) })),
        ...checkFacts(schema.facts, { subjects, root: repo.root }),
    ];
    // 词表条目必须有 description（人读的唯一入口，空词表等于没词表）
    for (const s of input.subjects ?? []) {
        if ((s.description ?? subjectMap.get(s.key)?.description ?? '') === '') {
            problems.push({ level: 'error', code: 'facts/subject-no-desc', detail: `subject 缺 description：${s.key}` });
        }
    }
    const errors = problems.filter((p) => p.level === 'error');
    if (errors.length > 0) return { report: emptyReport(added, updated, unchanged, newSubjects, input.dryRun ?? false), problems };

    // 4) 分组成篇：已有条目留在原篇，新条目按 subject 首段归档
    const fileOf = new Map<string, Fact[]>();
    for (const f of candidate) {
        const file = repo.origin.get(f.id) ?? path.join(repo.dir, 'facts', `${domainOf(f)}.yaml`);
        const list = fileOf.get(file) ?? [];
        list.push(f);
        fileOf.set(file, list);
    }

    const files: { file: string; before: number; after: number }[] = [];
    const writes: { file: string; text: string }[] = [];
    for (const [file, list] of fileOf) {
        const before = existsSync(file) ? readFileSync(file, 'utf8').length : 0;
        const text = renderDoc({
            note: repo.notes.get(file) ?? `knowledge/facts/${path.basename(file)}`,
            domain: repo.domains.get(file) ?? path.basename(file, '.yaml'),
            facts: list,
        });
        files.push({ file: path.relative(repo.root, file), before, after: text.length });
        writes.push({ file, text });
    }

    // 5) 词表也要写（新 subject 落在同一事务里）
    if (newSubjects.length > 0 || (input.subjects ?? []).length > 0) {
        const vocabFile = path.join(repo.dir, 'subjects.yaml');
        const vocab: Record<string, unknown> = {};
        for (const s of [...subjects].sort((a, b) => a.key.localeCompare(b.key))) {
            vocab[s.key] = { ...(s.description ? { description: s.description } : {}), ...(s.aliases ? { aliases: s.aliases } : {}) };
        }
        writes.push({ file: vocabFile, text: `${VOCAB_HEAD}\n${dump({ subjects: vocab }, { noRefs: true, lineWidth: -1, quoteStyle: 'single' })}` });
    }

    if (!(input.dryRun ?? false)) {
        for (const w of writes) {
            mkdirSync(path.dirname(w.file), { recursive: true });
            const tmp = `${w.file}.tmp-${process.pid}`;
            writeFileSync(tmp, w.text);
            renameSync(tmp, w.file);
        }
    }
    return {
        report: { dryRun: input.dryRun ?? false, added, updated, unchanged, newSubjects, files },
        problems,
    };
}

const VOCAB_HEAD = `# knowledge/subjects.yaml — subject 受控词表（##404）
#
# **新增 subject 必须走 \`diy facts submit\` 的 subjects 载荷**（会与本批事实同一事务校验）：
# 图的关系有效性完全取决于主语规范化 —— 若 \`端口\` / \`port\` / \`app.port\` 混用，边立刻退化成噪声。
# 别名只解决**命名归一**（人读），不进图（\`same-as\` 才是实体等价，别混用）。
#
# 字段：description（必填，一句话说清这个对象）· aliases（选填，只做提示，不参与匹配）`;

function emptyReport(added: readonly string[], updated: SubmitReport['updated'], unchanged: readonly string[], newSubjects: readonly string[], dryRun: boolean): SubmitReport {
    return { dryRun, added, updated, unchanged, newSubjects, files: [] };
}

/** 供 CLI 展示：把报告压成几行中文（渲染层不拼句子，句子归这里 —— 单处维护） */
export function formatReport(r: SubmitReport): string {
    const lines: string[] = [];
    if (r.added.length > 0) lines.push(`+ 新增 ${r.added.length}：${r.added.join(', ')}`);
    for (const u of r.updated) lines.push(`! 更新 ${u.id}：${u.before} → ${u.after}`);
    if (r.newSubjects.length > 0) lines.push(`+ 词表新增 ${r.newSubjects.length}：${r.newSubjects.join(', ')}`);
    if (lines.length === 0) lines.push(`= 无变化（${r.unchanged.length} 条与真源一致）`);
    for (const f of r.files) lines.push(`  ${f.file}: ${f.before} → ${f.after} B`);
    if (r.dryRun) lines.push('（--dry-run：以上均未落盘）');
    return lines.join('\n');
}

/** 证据字段的展示（CLI `get` 用；别在渲染层拼串） */
export function formatEvidence(ev: Evidence): string {
    const parts = [`source=${ev.source}`];
    if (ev.at !== undefined) parts.push(`at=${ev.at}`);
    if (ev.probe !== undefined) parts.push(`probe=${ev.probe}`);
    if (ev.verifiedAt !== undefined) parts.push(`verified=${ev.verifiedAt}`);
    return parts.join(' ');
}
