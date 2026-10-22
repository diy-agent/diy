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
import { claimOf, derivedFactId } from '../claim.js';
import { DEFAULT_FULL_BUDGET, checkExpose, exposeOf, type ExposeLevel, type ExposeMap } from '../expose.js';
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
    /**
     * **本地** subjects.yaml 里声明过的 key（继承来的不算）。
     *
     * 两个用途：① `subject-unused` 的判定范围（任务级库继承仓库词表后，仓库里
     * "已登记但本任务没用"的 subject 会刷出一屏假警告，把真问题淹掉）；
     * ② **写回词表时只写本地的** —— 否则第一次 `submit` 就把继承来的整份词表
     * 复制到任务目录，继承关系当场退化成快照（此后仓库加 subject，任务库看不到）。
     */
    readonly localSubjects: readonly SubjectDef[];
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

export interface LoadRepoOptions {
    /**
     * 词表缺省来源（另一份 `subjects.yaml` 的绝对路径）。
     *
     * 为**任务级库**而设：任务库只放本任务的事实，不该复制一份全局词表 ——
     * 复制就会分叉（两处对同一 subject 的描述迟早不同），且新 subject 还得同步两遍。
     * 继承语义只有一条：**本地有就本地优先，本地没有才回落**。
     */
    readonly subjectsFallback?: string;
    /**
     * facts 目录不存在时是否当空库（并在 `submit` 时建出来）。
     * 缺省 `false` —— 仓库真源缺失是环境问题，静默当空库会让 `submit` 写到别处。
     * 任务级库才开：它本来就是"第一次写入时诞生"。
     */
    readonly allowMissing?: boolean;
    /**
     * 覆盖 `root`（缺省 = `knowledge/` 的父目录）。
     *
     * 为**任务级库**而设：任务的库住在 `$DIY_HOME/projects/<p>/tasks/<t>/knowledge/`，
     * 但它写的事实讲的是**代码仓**的事 —— `evidence.at` / `scope.paths` 都是相对仓库根的
     * （`pkgs.ts/diy-app/src/x.ts:10`）。按"库目录的父目录"解析会让每一条证据都悬空。
     */
    readonly root?: string;
    /**
     * **额外只读库**（`knowledge/` 绝对路径，主库已有的 claim 一律不覆盖）。
     *
     * 为**设备级库跨根读**而设：lab 的 `$DIY_HOME` 在 `build/lab/home`，写进那里的
     * "设备级"事实生产 `~/.diy/knowledge` 看不到，反之亦然 —— 但 `~/AGENTS.md`
     * 物理上只有一份，这正是"设备级"该有的语义。判据：**读跨根无害且有用，写才有风险**
     * （agent 不写生产数据根，见 guard）。故只读合并，主库优先。
     */
    readonly extraDirs?: readonly string[];
}

/**
 * 真源 `facts` 的两种形态都认：
 *   - **claim map**（现行）：`{ "<subject>#<aspect>": {value,...} | [{value,...}, ...] }`
 *   - 旧数组：`[{ id, subject, aspect, value, ... }]`（迁移期兼容，写入一律产出 map）
 * map 形态下 subject/aspect 由 key 拆出后注入，id 缺省由校验层派生。
 */
function expandClaims(rawFacts: unknown): unknown[] {
    if (Array.isArray(rawFacts)) return rawFacts;
    if (typeof rawFacts !== 'object' || rawFacts === null) return [];
    const out: unknown[] = [];
    for (const [key, body] of Object.entries(rawFacts as Record<string, unknown>)) {
        const at = key.indexOf('#');
        if (at <= 0 || at === key.length - 1) {
            out.push(body); // 非法 key：原样交给校验层报错
            continue;
        }
        const subject = key.slice(0, at);
        const aspect = key.slice(at + 1);
        for (const cell of Array.isArray(body) ? body : [body]) {
            if (typeof cell !== 'object' || cell === null) {
                out.push(cell);
                continue;
            }
            out.push({ ...(cell as Record<string, unknown>), subject, aspect });
        }
    }
    return out;
}

/** 词表读取：本地优先，缺省回落（任务级库继承仓库词表，见 LoadRepoOptions.subjectsFallback） */
function readSubjects(localFile: string, fallbackFile?: string): { all: SubjectDef[]; local: SubjectDef[] } {
    const hasLocal = existsSync(localFile);
    const file = hasLocal ? localFile : fallbackFile !== undefined && existsSync(fallbackFile) ? fallbackFile : null;
    if (file === null) return { all: [], local: [] };
    const doc = readYaml(file) as { subjects?: Record<string, { description?: string; aliases?: string[] }> } | null;
    const all = Object.entries(doc?.subjects ?? {}).map(([key, def]) => ({
        key,
        ...(def?.description ? { description: def.description } : {}),
        ...(def?.aliases ? { aliases: def.aliases } : {}),
    }));
    return { all, local: hasLocal ? all : [] };
}

/**
 * 读一份库的**词表**（`<dir>/subjects.yaml`）；没有 / 坏了都返回空表。
 *
 * 为什么单独开一个口：`status` 跨库读时要判"这个 subject 在哪份词表里登记过" ——
 * 只认主库词表会把额外库（设备级）独有的 subject 全判成"未登记"（实测 `skill` 就是这样）。
 * 用 `loadRepo` 去读额外库不行：它带 `allowMissing` 会**顺手建目录**，读操作不该有副作用。
 */
export function readSubjectDefs(knowledgeDir: string): SubjectDef[] {
    try {
        return readSubjects(path.join(path.resolve(knowledgeDir), 'subjects.yaml')).all;
    } catch {
        return [];
    }
}

/**
 * 读一份库的**暴露档**（`<dir>/expose.yaml`）：`{ expose: { <subject>: full|index|none } }`。
 *
 * 为什么单独一个文件而不是塞进 `subjects.yaml`：词表描述的是"这个对象是什么"（语义），
 * 暴露档是"这个对象在上下文里露多少"（投递策略）—— 两者的 owner 和变更节奏都不同
 * （词表随知识演进，档位随字节预算调整，频繁得多）。
 *
 * 读不到 / 坏了一律返回空表（= 全 index）：投递策略出问题不该让整轮上下文构造失败。
 */
export function readExpose(knowledgeDir: string): ExposeMap {
    const file = path.join(path.resolve(knowledgeDir), 'expose.yaml');
    if (!existsSync(file)) return {};
    try {
        const doc = readYaml(file) as { expose?: unknown } | null;
        const raw = doc?.expose;
        if (typeof raw !== 'object' || raw === null) return {};
        const out: Record<string, ExposeLevel> = {};
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            // 非法值原样收下（字符串化）：让 `checkExpose` 报出来，而不是读到这儿就悄悄忽略
            out[k] = (typeof v === 'string' ? v : String(v)) as ExposeLevel;
        }
        return out;
    } catch {
        return {};
    }
}

/** 装载真源。除非 `allowMissing`，目录不存在 = 环境问题（不是"空库"） */
export function loadRepo(knowledgeDir: string, opts: LoadRepoOptions = {}): Repo {
    const dir = path.resolve(knowledgeDir);
    const factsDir = path.join(dir, 'facts');
    if (!existsSync(factsDir)) {
        if (opts.allowMissing !== true) {
            throw new FactsRepoError('facts/repo-missing', `事实库真源不存在：${factsDir}（--dir 指错？）`);
        }
        mkdirSync(factsDir, { recursive: true });
    }
    const { all: subjects, local: localSubjects } = readSubjects(path.join(dir, 'subjects.yaml'), opts.subjectsFallback);

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
        const rawFacts: unknown = Array.isArray(doc) ? doc : (doc?.facts ?? {});
        if (typeof rawFacts !== 'object' || rawFacts === null) {
            throw new FactsRepoError('facts/yaml-shape', `${file}: 期望 { domain, facts: {<subject>#<aspect>: ...} }（旧数组形态仍认）`);
        }
        const list = expandClaims(rawFacts);
        if (!Array.isArray(doc)) {
            // 空头注不落 map：留给 renderDoc 用「文件名」兜底（否则会写出一个空的 `#` 行）
            const note = typeof doc?.note === 'string' ? doc.note : leadingComments(text);
            if (note !== '') notes.set(file, note);
            if (typeof doc?.domain === 'string') domains.set(file, doc.domain);
        }
        for (const item of list) {
            if (typeof item === 'object' && item !== null) {
                const it = item as { id?: unknown; subject?: unknown; aspect?: unknown };
                const id = typeof it.id === 'string'
                    ? it.id
                    : typeof it.subject === 'string' && typeof it.aspect === 'string' ? `${it.subject}#${it.aspect}` : undefined;
                if (id !== undefined) origin.set(id, file);
            }
            raw.push(item);
        }
    }

    // 额外只读库：主库已有的 claim 不覆盖（同 claim 两处写 = 必漂移，以本根为准）
    if (opts.extraDirs !== undefined && opts.extraDirs.length > 0) {
        const claimKey = (item: unknown): string | undefined => {
            if (typeof item !== 'object' || item === null) return undefined;
            const it = item as { subject?: unknown; aspect?: unknown };
            return typeof it.subject === 'string' && typeof it.aspect === 'string' ? `${it.subject}#${it.aspect}` : undefined;
        };
        // 只算**可用**的 claim（active + accepted）：主库同 claim 全被 superseded / 待审时，
        // 视为"主库没有"，让额外库那份顶上 —— 否则标一条 superseded 就等于知识凭空消失。
        const seen = new Set<string>();
        for (const item of raw) {
            const k = claimKey(item);
            if (k === undefined) continue;
            const it = item as { review?: unknown; lifecycle?: unknown };
            const usable = (it.lifecycle ?? 'active') === 'active' && (it.review ?? 'accepted') === 'accepted';
            if (usable) seen.add(k);
        }
        for (const extra of opts.extraDirs) {
            const extraFactsDir = path.join(path.resolve(extra), 'facts');
            if (extraFactsDir === factsDir || !existsSync(extraFactsDir)) continue;
            for (const f of readdirSync(extraFactsDir).filter((n) => n.endsWith('.yaml') || n.endsWith('.yml')).sort()) {
                const file = path.join(extraFactsDir, f);
                let doc: unknown;
                try {
                    doc = readYaml(file) as unknown;
                } catch {
                    // 额外库坏了不该让主库不可用（它是"参考"，不是真源）
                    continue;
                }
                const d = doc as { facts?: unknown } | unknown[] | null;
                const rawFacts: unknown = Array.isArray(d) ? d : (d?.facts ?? {});
                if (typeof rawFacts !== 'object' || rawFacts === null) continue;
                for (const item of expandClaims(rawFacts)) {
                    const k = claimKey(item);
                    if (k !== undefined && seen.has(k)) continue;
                    if (k !== undefined) seen.add(k);
                    // 记来源：`get` 要报"这条在哪个文件"，额外库不记会让路径变成空串
                    const id = typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string'
                        ? (item as { id: string }).id
                        : k;
                    if (id !== undefined) origin.set(id, file);
                    raw.push(item);
                }
            }
        }
    }

    const { facts, issues } = validateFacts(raw);
    return {
        dir,
        root: opts.root === undefined ? path.dirname(dir) : path.resolve(opts.root),
        files,
        facts,
        origin,
        notes,
        domains,
        subjects,
        localSubjects,
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
    opts: {
        subjects: readonly SubjectDef[];
        root: string;
        asOf?: Date;
        maxAgeDays?: number;
        /** `subject-unused` 的判定范围；缺省 = 全部词表（任务级库传本地声明的 key） */
        subjectsUnusedScope?: readonly string[];
    },
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
    const unusedScope = opts.subjectsUnusedScope ?? [...vocab];
    for (const s of unusedScope) {
        if (!used.has(s) && vocab.has(s)) problems.push({ level: 'warning', code: 'facts/subject-unused', detail: `词表里的 subject 无任何 fact 使用：${s}` });
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
export function checkRepo(
    knowledgeDir: string,
    opts: { asOf?: Date; maxAgeDays?: number } & LoadRepoOptions = {},
): {
    repo: Repo;
    problems: readonly RepoProblem[];
} {
    const repo = loadRepo(knowledgeDir, opts);
    const problems: RepoProblem[] = [
        ...repo.schemaIssues,
        ...checkFacts(repo.facts, {
            subjects: repo.subjects,
            root: repo.root,
            subjectsUnusedScope: repo.localSubjects.map((s) => s.key),
            ...opts,
        }),
    ];
    // 暴露档超预算 = **错误**（不是警告）：否则 `omitted: 131` 那种"装不下但没人说"
    // 会一直沉默下去。只在写了 expose.yaml 的库上判（兼容窗口，见 `buildFactsContext`）。
    if (existsSync(path.join(repo.dir, 'expose.yaml'))) {
        for (const p of checkExpose(repo.facts, readExpose(repo.dir), { budget: DEFAULT_FULL_BUDGET })) {
            problems.push({ level: 'error', code: p.code, detail: p.detail, ...(p.facts ? { facts: p.facts } : {}) });
        }
    }
    return { repo, problems };
}

// ── 写入 ──────────────────────────────────────────────────────────────

/** 字段顺序固化（少了它，谁先写谁定顺序，diff 会整篇翻红） */
function evidenceOf(f: Fact): Record<string, unknown> {
    const ev: Record<string, unknown> = { source: f.evidence.source };
    if (f.evidence.probe !== undefined) ev['probe'] = f.evidence.probe;
    if (f.evidence.probeDigest !== undefined) ev['probeDigest'] = f.evidence.probeDigest;
    if (f.evidence.at !== undefined) ev['at'] = f.evidence.at;
    if (f.evidence.verifiedAt !== undefined) ev['verifiedAt'] = f.evidence.verifiedAt;
    return ev;
}

/** 比较用的完整形态（含 subject/aspect —— 改名但 id 不变也是一种变更） */
function canonicalFact(f: Fact): Record<string, unknown> {
    const out: Record<string, unknown> = { id: f.id, subject: f.subject, aspect: f.aspect, value: f.value };
    if (f.scope !== undefined) out['scope'] = canonicalScope(f.scope);
    out['review'] = f.review;
    out['lifecycle'] = f.lifecycle;
    out['evidence'] = evidenceOf(f);
    if (f.refs !== undefined && f.refs.length > 0) out['refs'] = f.refs.map(canonicalRef);
    return out;
}

/**
 * 落盘用的单条形态：**不含 subject / aspect**（由 claim key 携带），
 * `id` 只在显式给出（≠ 派生值 `<subject>#<aspect>`）时才写。
 */
function factCell(f: Fact): Record<string, unknown> {
    const out: Record<string, unknown> = { value: f.value };
    if (f.scope !== undefined) out['scope'] = canonicalScope(f.scope);
    if (f.id !== derivedFactId(f)) out['id'] = f.id;
    out['review'] = f.review;
    out['lifecycle'] = f.lifecycle;
    out['evidence'] = evidenceOf(f);
    if (f.refs !== undefined && f.refs.length > 0) out['refs'] = f.refs.map(canonicalRef);
    return out;
}

/**
 * 真源形态：`facts` 是 **map**，key = claim（`subject#aspect`）。
 * 单条内联成对象；同 claim 的多个变体（不同 scope）成数组。
 * 为什么 map 而不是数组：key 即身份，省掉重复的 subject/aspect/id；
 * 且 js-yaml 遇重复 key 直接抛错（`duplicated mapping key`），不比数组查重弱。
 */
function claimMap(facts: readonly Fact[]): Record<string, unknown> {
    const groups = new Map<string, unknown[]>();
    for (const f of sortFacts(facts)) {
        const key = claimOf(f);
        const list = groups.get(key);
        if (list === undefined) groups.set(key, [factCell(f)]);
        else list.push(factCell(f));
    }
    const out: Record<string, unknown> = {};
    for (const [key, cells] of groups) out[key] = cells.length === 1 ? cells[0] : cells;
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
        { domain: opts.domain, facts: claimMap(opts.facts) },
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
    /** 本批物理删除的 id（不存在于本库的 id 不在此列 —— 删不存在的东西不该算成功） */
    readonly dropped: readonly string[];
}

export interface SubmitInput {
    /** 待写入的事实（已由内核 validateFacts 转换过） */
    readonly facts: readonly Fact[];
    /** 新增/修订的 subject（词表扩展也走同一个事务，免得"事实先落地、词表后补"的中间态） */
    readonly subjects?: readonly SubjectDef[];
    /** subject 词表里的 description 缺失时是否允许落（缺省拒：description 是词表唯一人读信息） */
    readonly dryRun?: boolean;
    /**
     * 物理删除的 fact id（同批事务内生效）。
     *
     * 为什么需要它：id 是**审计锚点**，写错就没法用"覆盖同 id"修 —— 早期把设备级事实的
     * id 写成 `agents.rule.lang`（与项目库同 id）就是这样卡死的：标 `superseded` 也消除不了
     * `facts/id-duplicate`（唯一性对全部条目判），而 submit 只能按 id 覆盖。没有删除/改名入口，
     * 这个冲突用现有 CLI **无法消解**。
     *
     * 为什么是 `drop` 而不是 `rename`：改名本质 = 删旧 + 写新 + 补 `supersedes` 边，
     * 三件事本该在同一个事务里（否则中间态是"旧 id 悬空边"或"新 id 无来源"）。
     * 给 `rename` 一条捷径就会造出第四种写法；给 `drop` 则一切组合都由 `facts + drop` 表达。
     *
     * 安全性：删完照样跑整套判据（`byId` 候选集）—— 删错了会以「边悬空」当场拒写，磁盘不动。
     */
    readonly drop?: readonly string[];
    /**
     * 暴露档修订（`subject → full|index|none`），与事实**同一事务**。
     *
     * 为什么由 `submit` 写而不是让人改 `expose.yaml`：与「agent 不碰 YAML」同一条纪律 ——
     * 手改必错（漏引号 / 拼错档位 / 排序乱），而且**档位超预算这件事只有写入侧知道**
     * （它要拿整库的字节和跟预算比）。故档位也是一种"提交"，一样整批校验、整批落。
     */
    readonly expose?: ExposeMap;
}

/**
 * 整批事务：**全过才写**。
 *
 * 为什么原子：agent 一轮会提 3~10 条，第 4 条写错了却把前 3 条落了盘 —— 人看到的是
 * "部分生效"，下一轮 agent 读到半截状态又会重复提。宁可整批退，让它重提。
 */
export function submit(
    knowledgeDir: string,
    input: SubmitInput,
    repoOpts: LoadRepoOptions = {},
): { report: SubmitReport; problems: readonly RepoProblem[] } {
    const repo = loadRepo(knowledgeDir, repoOpts);

    // 1) 候选事实集：同 id 覆盖（审计锚点稳定），新 id 追加
    const byId = new Map(repo.facts.map((f) => [f.id, f]));
    const dropped: string[] = [];
    for (const id of input.drop ?? []) {
        if (byId.delete(id)) dropped.push(id);
    }
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
    // 两份词表：`subjectMap` = 校验用（含继承），`localMap` = 写回用（只有本地 + 本次新增）。
    // 两者混用就会出现"第一次 submit 把继承的整份词表复制成本地快照"。
    const subjectMap = new Map(repo.subjects.map((s) => [s.key, s]));
    const localMap = new Map(repo.localSubjects.map((s) => [s.key, s]));
    const newSubjects: string[] = [];
    for (const s of input.subjects ?? []) {
        const prev = subjectMap.get(s.key);
        if (prev === undefined) newSubjects.push(s.key);
        subjectMap.set(s.key, { ...prev, ...s });
        localMap.set(s.key, { ...localMap.get(s.key), ...s });
    }
    const subjects = [...subjectMap.values()];

    // 3) 候选集跑**同一套判据**（与 ./sha.sh check 一致）
    const candidate = [...byId.values()];
    const schema = validateFacts(candidate);
    const problems: RepoProblem[] = [
        ...schema.issues.map((i) => ({ level: 'error' as const, code: i.code, detail: i.detail, ...(i.facts ? { facts: i.facts } : {}) })),
        // unused 的判定范围跟着**本地**词表走：本批新声明的 subject 也算本地
        ...checkFacts(schema.facts, { subjects, root: repo.root, subjectsUnusedScope: [...localMap.keys()] }),
    ];
    // 词表条目必须有 description（人读的唯一入口，空词表等于没词表）
    for (const s of input.subjects ?? []) {
        if ((s.description ?? subjectMap.get(s.key)?.description ?? '') === '') {
            problems.push({ level: 'error', code: 'facts/subject-no-desc', detail: `subject 缺 description：${s.key}` });
        }
    }
    // 3.5) 暴露档与预算：`full` 档字节和 > 预算 ⇒ **错误**（写不进去）。
    // 不许沉默超限：`omitted: 131` 那种"装不下但没人说"的状态，正是配置与预算脱节的证据。
    // 库目录里没有 `expose.yaml` 时不判（兼容窗口：升级当天不能把存量库卡死）。
    const exposeFile = path.join(repo.dir, 'expose.yaml');
    const hasExposeFile = existsSync(exposeFile);
    const exposeMap: ExposeMap = { ...readExpose(repo.dir), ...(input.expose ?? {}) };
    if (hasExposeFile || input.expose !== undefined) {
        for (const p of checkExpose(schema.facts, exposeMap, { budget: DEFAULT_FULL_BUDGET })) {
            problems.push({ level: 'error', code: p.code, detail: p.detail, ...(p.facts ? { facts: p.facts } : {}) });
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
        for (const s of [...localMap.values()].sort((a, b) => a.key.localeCompare(b.key))) {
            vocab[s.key] = { ...(s.description ? { description: s.description } : {}), ...(s.aliases ? { aliases: s.aliases } : {}) };
        }
        writes.push({ file: vocabFile, text: `${VOCAB_HEAD}\n${dump({ subjects: vocab }, { noRefs: true, lineWidth: -1, quoteStyle: 'single' })}` });
    }

    // 6) 暴露档：只在**真的给了** `expose` 时重写（未给不动文件 —— 空提交不该把档位洗成默认）
    if (input.expose !== undefined) {
        const merged: Record<string, string> = {};
        for (const k of Object.keys(exposeMap).sort()) merged[k] = exposeOf(exposeMap, k);
        writes.push({
            file: exposeFile,
            text: `${EXPOSE_HEAD}\n${dump({ expose: merged }, { noRefs: true, lineWidth: -1, quoteStyle: 'single' })}`,
        });
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
        report: { dryRun: input.dryRun ?? false, added, updated, unchanged, newSubjects, files, dropped },
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

export const EXPOSE_HEAD = `# knowledge/expose.yaml — 主题的**暴露档**（##404）
#
# 决定一个 subject 在上下文里露多少（值只有三档）：
#   full  —— 正文进 runtime.facts（**常驻**：每一轮都付这个字节）
#   index —— 只在 runtime.kb 一行（知道有这个话题，要值就 \`diy facts get\`）
#   none  —— 两处都不给，只能 get / brief（临时性 / 体量太大）
#
# 缺省档 = index（没列出来的 subject 就是 index）：新写的主题自动进索引、不抢正文预算。
# 硬约束：\`full\` 的字节和超过预算 ⇒ \`diy facts submit\` / \`./sha.sh check\` **报错**，
# 不许沉默超限。改档位也走 \`diy facts submit\` 的 \`expose\` 载荷（**别手改本文件**）。
#
# 判据：搬走一条 X 字节的知识每轮省 X，但查它一次 ≈ 一次完整请求的前缀重发（约 41 KB）。
# 故 full 给"每轮都要知道"的，index 给"知道有、偶尔查"的。`;

function emptyReport(
    added: readonly string[],
    updated: SubmitReport['updated'],
    unchanged: readonly string[],
    newSubjects: readonly string[],
    dryRun: boolean,
): SubmitReport {
    return { dryRun, added, updated, unchanged, newSubjects, files: [], dropped: [] };
}

/** 供 CLI 展示：把报告压成几行中文（渲染层不拼句子，句子归这里 —— 单处维护） */
export function formatReport(r: SubmitReport): string {
    const lines: string[] = [];
    if (r.dropped.length > 0) lines.push(`- 删除 ${r.dropped.length}：${r.dropped.join(', ')}`);
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
