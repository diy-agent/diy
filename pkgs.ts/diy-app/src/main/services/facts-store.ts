/**
 * facts-store.ts — 事实库的 RPC 侧适配（##404）
 *
 * 分工：**判据与存储都在 `@diy/facts`**（内核纯函数 + `@diy/facts/node` 读写/事务），
 * 本文件只做三件 RPC 才有的事：
 *   1. 定位真源目录（`--dir` > `DIY_FACTS_DIR` > 从 cwd / 包根向上找 `knowledge/subjects.yaml`）
 *   2. 把 CLI 的一行参数（逗号分隔的 claim / files）摊成表
 *   3. 把内核的结构化结果原样往上抛（**不在这里拼给用户看的句子** —— 句子都在内核的 format*）
 *
 * 为什么不在这里直接 `readFileSync` 真源：任何"第二个读取实现"都会与 check 脚本分叉，
 * 而"CLI 能写、CI 却红"正是本次要消除的病（见 scripts/facts-index.mts 头注）。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { affected, buildIndex, resolveClaim, validateFacts, type Env, type Fact, type Ns, type Ref, type Scope } from "@diy/facts";
import { checkRepo, loadRepo, submit, project, type SubjectDef, type SubmitReport } from "@diy/facts/node";
import type { z } from "zod";
import { diyHome } from "../core/state";
import type { FactSchema, RefSchema } from "../../shared/facts";

/**
 * 边界转换：内核的 `Fact` 字段是 `readonly`（不可变纪律），zod 推出的是可变 DTO。
 * 转换只在这里做一次 —— 直接 `as` 强转能把 readonly 抹掉，但也会把**多出来的字段**
 * 与**类型不符**一起抹掉，那正是这条边界该拦住的东西。
 */
type DtoFact = z.infer<typeof FactSchema>;
type DtoProblem = { level: "error" | "warning"; code: string; detail: string; facts?: string[] };

/** 问题表同样是 readonly→plain（`facts` 数组要摊开，否则 DTO 类型对不上） */
/** 报告里全是 readonly 数组（内核不可变纪律）→ 摊成 DTO */
function plainReport(r: SubmitReport) {
    return {
        dryRun: r.dryRun,
        added: [...r.added],
        updated: r.updated.map((u) => ({ id: u.id, before: u.before, after: u.after })),
        unchanged: [...r.unchanged],
        newSubjects: [...r.newSubjects],
        files: r.files.map((f) => ({ file: f.file, before: f.before, after: f.after })),
    };
}

function plainProblems(list: readonly { level: "error" | "warning"; code: string; detail: string; facts?: readonly string[] }[]): DtoProblem[] {
    return list.map((p) => ({ level: p.level, code: p.code, detail: p.detail, ...(p.facts ? { facts: [...p.facts] } : {}) }));
}
type DtoScope = NonNullable<DtoFact["scope"]>;

function plainScope(s: Scope): DtoScope {
    const out: DtoScope = {};
    if (s.env !== undefined) {
        out.env = Array.isArray(s.env) ? [...(s.env as readonly Env[])] : (s.env as Env);
    }
    if (s.paths !== undefined) out.paths = [...s.paths];
    if (s.task !== undefined) out.task = s.task;
    return out;
}

function plainRef(r: Ref): z.infer<typeof RefSchema> {
    return r.rel === "depends-on"
        ? { rel: "depends-on", data: { toClaim: r.data.toClaim, ...(r.data.when ? { when: plainScope(r.data.when) } : {}) } }
        : { rel: "supersedes", data: { toFactId: r.data.toFactId, ...(r.data.within ? { within: plainScope(r.data.within) } : {}) } };
}

function plainFact(f: Fact, file: string): DtoFact & { file: string } {
    return {
        id: f.id,
        subject: f.subject,
        aspect: f.aspect,
        value: f.value,
        ...(f.scope ? { scope: plainScope(f.scope) } : {}),
        review: f.review,
        lifecycle: f.lifecycle,
        evidence: { ...f.evidence },
        ...(f.refs ? { refs: f.refs.map(plainRef) } : {}),
        file,
    };
}

/** 环境不对（找不到真源 / 载荷解析失败）：直接 throw，带 code 便于三处出口统一 */
export class FactsStoreError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "FactsStoreError";
    }
}

function walkUp(start: string): string | null {
    let dir = path.resolve(start);
    for (;;) {
        const candidate = path.join(dir, "knowledge", "subjects.yaml");
        if (existsSync(candidate)) return path.join(dir, "knowledge");
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/**
 * 真源目录。顺序：显式 → 环境变量 → 调用方 cwd → **包根向上**。
 *
 * 为什么要「包根向上」这一档：handler 跑在 app 进程，cwd 是应用根（`pkgs.ts/diy-app`），
 * 不是用户敲命令的目录 —— 只认 cwd 会让 `diy facts status` 在仓库里任何位置都报「找不到」。
 */
/**
 * 归一成 `knowledge/` 目录。为什么要这一层：调用方（人、脚本、CI）习惯把"仓库根"和
 * "knowledge 目录"两种写法混着传，两者都合理 —— 但下游只认后者。不归一 = 传仓库根时
 * 静默退回"没有词表"（继承关系当场失效且**不报错**，最难查的那种）。
 */
function normalizeKbDir(p: string): string {
    const resolved = path.resolve(p);
    if (existsSync(path.join(resolved, "subjects.yaml"))) return resolved;
    const nested = path.join(resolved, "knowledge");
    if (existsSync(path.join(nested, "subjects.yaml"))) return nested;
    return resolved;
}

export function resolveFactsDir(explicit?: string): string {
    if (explicit !== undefined && explicit !== "") return normalizeKbDir(explicit);
    const fromEnv = process.env["DIY_FACTS_DIR"];
    if (fromEnv !== undefined && fromEnv !== "") return normalizeKbDir(fromEnv);
    const hit = walkUp(process.cwd()) ?? walkUp(path.resolve(import.meta.dirname, "../../../.."));
    if (hit === null) {
        throw new FactsStoreError(
            "agent/facts-repo-missing",
            "找不到事实库真源（向上找 knowledge/subjects.yaml 未命中）——用 --dir 指到仓库根，或 set DIY_FACTS_DIR",
        );
    }
    return hit;
}

/**
 * 库的定位结果。**为什么不是单纯一个目录**：任务级库与仓库库的差别不在路径，
 * 而在两条附加语义 —— ① 词表继承（否则每个任务复制一份 subjects.yaml 必然分叉）
 * ② 首次写入即诞生（任务库第一次 `submit` 前目录根本不存在）。
 * 把这两条塞进调用方，`submit` / `status` 就各写一遍，迟早不一致。
 */
export interface FactsTarget {
    /** 库的 `knowledge/` 绝对路径 */
    readonly dir: string;
    /** 词表缺省来源（任务级库 → 仓库词表；仓库库自身 = 无） */
    readonly subjectsFallback?: string;
    /** 首次写入可建库（只有任务级库为 true） */
    readonly allowMissing: boolean;
    /**
     * 证据 / paths 的解析根。任务级库指向**仓库根**而非任务目录 ——
     * 任务写的事实讲的是代码仓的事（`pkgs.ts/diy-app/src/x.ts:10`），
     * 按任务目录解析会让每条证据都悬空。
     */
    readonly root?: string;
}

const TASK_IN = /^task:(projects\/\d+\/tasks\/\d+)$/;

/**
 * `--in` 的语义：`task:<taskUri>` 指向任务级库，其余（含缺省）指向仓库库。
 *
 * 为什么不给任务库留「当前任务」缺省：agent 常常同时在两个任务里干活（父任务排期、
 * 子任务开发），"当前"根本无从判断 —— 写错库比多敲十次 uri 危险得多。
 */
export function resolveFactsTarget(opts: { dir?: string; in?: string } = {}): FactsTarget {
    const spec = opts.in?.trim();
    if (spec !== undefined && spec !== "" && spec !== "global" && spec !== "project") {
        const m = TASK_IN.exec(spec);
        if (m === null) {
            throw new FactsStoreError(
                "agent/facts-bad-in",
                `--in 只认 task:<taskUri>（如 task:projects/4/tasks/404）或 global —— 收到「${spec}」`,
            );
        }
        const taskDir = path.join(diyHome(), m[1] as string);
        if (!existsSync(taskDir)) {
            throw new FactsStoreError("agent/facts-task-missing", `任务目录不存在：${taskDir}`);
        }
        const repoKb = resolveFactsDir(undefined);
        const subjectsFallback = path.join(repoKb, "subjects.yaml");
        if (!existsSync(subjectsFallback)) {
            // 继承是任务库的硬前提：词表缺失时**继续跑**会让每条新 subject 都被判"未登记"，
            // 症状像"我的 fact 写错了"，实际是环境不对 —— 所以这里直接亮出来。
            throw new FactsStoreError(
                "agent/facts-repo-missing",
                `任务库要继承仓库词表，但没找到：${subjectsFallback} —— 用 --dir 指到仓库根或 set DIY_FACTS_DIR`,
            );
        }
        return {
            dir: path.join(taskDir, "knowledge"),
            // 任务库继承仓库词表：本地 subjects.yaml 存在则本地优先（局部扩词），否则用仓库的
            subjectsFallback,
            allowMissing: true,
            root: path.dirname(repoKb),
        };
    }
    return { dir: resolveFactsDir(opts.dir), allowMissing: false };
}

/**
 * `FactsTarget` → 内核选项。`forWrite` 才允许"建库"：**读操作永不制造目录** ——
 * `status` 顺手建出一个空库，会让"库在哪、建没建"这件事变得不可判定。
 */
function targetOpts(t: FactsTarget, forWrite = false) {
    return {
        allowMissing: forWrite && t.allowMissing,
        ...(t.subjectsFallback === undefined ? {} : { subjectsFallback: t.subjectsFallback }),
        ...(t.root === undefined ? {} : { root: t.root }),
    };
}

export function status(opts: { dir?: string; in?: string } = {}) {
    const target = resolveFactsTarget(opts);
    const kb = target.dir;
    if (target.allowMissing && !existsSync(path.join(kb, "facts"))) {
        throw new FactsStoreError(
            "agent/facts-repo-missing",
            `任务级库还没建：${kb} —— 第一次写入自动创建，先跑 \`diy facts submit --in ${opts.in ?? "task:<uri>"}\``,
        );
    }
    const { repo, problems } = checkRepo(kb, targetOpts(target));
    const claims = new Set(repo.facts.map((f) => `${f.subject}#${f.aspect}`));
    return {
        dir: kb,
        in: opts.in ?? "global",
        facts: repo.facts.length,
        claims: claims.size,
        subjects: new Set(repo.facts.map((f) => f.subject)).size,
        files: repo.files.length,
        problems: plainProblems(problems),
    };
}

/** 逗号分隔 → 表（CLI 位置参数只能收一个串，见 diy-rpc 的 cliArg 实现） */
export function splitList(raw: string): string[] {
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
}

export interface GetResult {
    resolved: { claim: string; facts: (DtoFact & { file: string })[] }[];
    notes: string[];
}

export function get(
    claims: readonly string[],
    opts: { dir?: string; in?: string; env?: Env; paths?: readonly string[]; task?: string } = {},
): GetResult {
    const target = resolveFactsTarget(opts);
    const kb = target.dir;
    const repo = loadRepo(kb, targetOpts(target));
    // schema 坏到解读不出事实时，`get` 不能"猜着答"：报错退出比给出可能错的值好
    if (repo.schemaIssues.length > 0) {
        throw new FactsStoreError("agent/facts-schema", `真源有 schema 问题（先跑 \`diy facts status\`）：${repo.schemaIssues[0]?.detail ?? ""}`);
    }
    const ctx = {
        ...(opts.env === undefined ? {} : { env: opts.env }),
        ...(opts.paths === undefined ? {} : { paths: opts.paths }),
        ...(opts.task === undefined ? {} : { task: opts.task }),
    };
    const resolved: GetResult["resolved"] = [];
    const notes: string[] = [];
    for (const claim of claims) {
        const r = resolveClaim(repo.facts, claim, ctx);
        if (!r.ok) {
            // 悬空 / 冲突不是"没找到"，要带着码说出来（读取侧不返回 null 的纪律）
            notes.push(`${claim}: ${r.code}${r.detail === undefined ? "" : ` — ${r.detail}`}`);
            continue;
        }
        const chosen = repo.facts.find((f) => f.id === r.value.factId);
        if (chosen === undefined) continue;
        resolved.push({ claim, facts: [plainFact(chosen, path.relative(repo.root, repo.origin.get(chosen.id) ?? ""))] });
        notes.push(`${claim}: 取 ${r.value.factId}（${r.value.value}）`);
    }
    return { resolved, notes };
}

/**
 * 读侧摘要：值压成一行、取前 `max` 字（尽量在句末断）。
 *
 * 为什么要有它：链上正文删掉之后，agent 得先"扫一眼有哪些条目、各是什么"才知道
 * 该精确 `get` 哪条 —— 而完整值动辄几百字（`pit` 类），全列出来就是另一种链。
 * 所以这里只给**够判断该不该展开**的量，摘要永远是线索、不是结论（精确值走 `get`）。
 */
export function previewOf(value: string, max = 80): string {
    const flat = value.replace(/\s+/g, " ").replace(/[*`]/g, "").trim();
    if (flat.length <= max) return flat;
    const cut = flat.slice(0, max);
    const stop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"));
    return `${stop > max / 2 ? cut.slice(0, stop + 1) : cut}…`;
}

export interface BriefEntry {
    aspect: string;
    gid: string;
    preview: string;
    /** 该 claim 的变体数（>1 ⇒ 还有别的值，问"当前环境是哪个"要 `get --env`） */
    variants: number;
    review: string;
    lifecycle: string;
    file: string;
}

export interface BriefResult {
    subject: string;
    desc: string | null;
    claims: number;
    facts: number;
    entries: BriefEntry[];
    notes: string[];
}

/** 变体组的代表：accepted 优先 → 限定条件最少（无条件比"仅 production"更接近通例）→ id 短 */
function pickRepresentative(list: readonly Fact[]): Fact {
    const rank = (f: Fact): number => (f.review === "accepted" ? 0 : f.review === "proposed" ? 1 : 2);
    const weight = (f: Fact): number =>
        f.scope === undefined
            ? 0
            : (f.scope.env === undefined ? 0 : 1) + (f.scope.paths === undefined ? 0 : 1) + (f.scope.task === undefined ? 0 : 1);
    return [...list].sort((a, b) => rank(a) - rank(b) || weight(a) - weight(b) || a.id.localeCompare(b.id))[0] as Fact;
}

/**
 * 目录级：列一个 subject 的**全部 aspect**（gid + 值首句）。
 *
 * 为什么需要它（这是本命令存在的唯一理由）：`get` 要精确 claim、`status` 只给计数，
 * 中间那层"这个主题下有哪些条目"原本不存在 ⇒ 链上正文就删不掉（删了不知从何查起）。
 */
export function brief(subjectIn: string, opts: { dir?: string; in?: string; maxChars?: number } = {}): BriefResult {
    const subject = subjectIn.trim();
    if (subject === "") {
        throw new FactsStoreError("agent/facts-brief-arg", "brief 需要 subject（如 `diy facts brief find`）");
    }
    const target = resolveFactsTarget(opts);
    const repo = loadRepo(target.dir, targetOpts(target));
    if (repo.schemaIssues.length > 0) {
        throw new FactsStoreError(
            "agent/facts-schema",
            `真源有 schema 问题（先跑 \`diy facts status\`）：${repo.schemaIssues[0]?.detail ?? ""}`,
        );
    }
    const desc = repo.subjects.find((s) => s.key === subject)?.description ?? null;
    const mine = repo.facts.filter((f) => f.subject === subject);
    const notes: string[] = [];
    if (mine.length === 0) {
        // 空不是错误（可能拼错）。给"相近主题"让其自纠 —— 只说"没有"等于让人重敲一次。
        const all = [...new Set(repo.facts.map((f) => f.subject))];
        const near = all.filter((s) => s.includes(subject) || subject.includes(s)).slice(0, 5);
        notes.push(near.length > 0 ? `没这个 subject；相近的有：${near.join(", ")}` : "没这个 subject（`diy facts status` 看全部主题）");
        return { subject, desc, claims: 0, facts: 0, entries: [], notes };
    }
    const max = opts.maxChars ?? 80;
    const byAspect = new Map<string, Fact[]>();
    for (const f of mine) {
        const arr = byAspect.get(f.aspect) ?? [];
        arr.push(f);
        byAspect.set(f.aspect, arr);
    }
    const entries: BriefEntry[] = [...byAspect.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([aspect, list]) => {
            const rep = pickRepresentative(list);
            return {
                aspect,
                gid: `${subject}#${aspect}`,
                preview: previewOf(rep.value, max),
                variants: list.length,
                review: rep.review,
                lifecycle: rep.lifecycle,
                file: path.relative(repo.root, repo.origin.get(rep.id) ?? ""),
            };
        });
    return { subject, desc, claims: entries.length, facts: mine.length, entries, notes };
}

export interface FindHit {
    gid: string;
    id: string;
    preview: string;
    /** 命中位置（claim / id / value 的并集）—— "命中键名"和"命中内容"的可信度不一样 */
    hitIn: string[];
    review: string;
    lifecycle: string;
}

export interface FindResult {
    keyword: string;
    hits: FindHit[];
    /** 命中总数（`hits` 可能被 `limit` 截断） */
    total: number;
    notes: string[];
}

/**
 * 全文检索：claim / id / value 上的大小写不敏感子串，多关键词 = **与**（每个都得命中某处）。
 *
 * 为什么不用模糊匹配 / 分词：agent 查的是它刚听到的**专有词**（"异常三档"、"reqlog"），
 * 子串足够；分词会引入"命中了但是不相干"的噪声，反而要人再看一遍。
 */
export function find(keywordIn: string, opts: { dir?: string; in?: string; limit?: number; maxChars?: number } = {}): FindResult {
    const keyword = keywordIn.trim();
    const terms = splitList(keyword).map((t) => t.toLowerCase());
    if (terms.length === 0) {
        throw new FactsStoreError("agent/facts-find-arg", "find 需要至少一个关键词（多个用逗号分隔 = 全都要命中）");
    }
    const target = resolveFactsTarget(opts);
    const repo = loadRepo(target.dir, targetOpts(target));
    if (repo.schemaIssues.length > 0) {
        throw new FactsStoreError(
            "agent/facts-schema",
            `真源有 schema 问题（先跑 \`diy facts status\`）：${repo.schemaIssues[0]?.detail ?? ""}`,
        );
    }
    const max = opts.maxChars ?? 80;
    const scored: { hit: FindHit; score: number }[] = [];
    for (const f of repo.facts) {
        const gid = `${f.subject}#${f.aspect}`;
        const haystack: Record<string, string> = { claim: gid.toLowerCase(), id: f.id.toLowerCase(), value: f.value.toLowerCase() };
        const hitIn = new Set<string>();
        let all = true;
        for (const t of terms) {
            const where = Object.keys(haystack).filter((k) => (haystack[k] as string).includes(t));
            if (where.length === 0) {
                all = false;
                break;
            }
            for (const w of where) hitIn.add(w);
        }
        if (!all) continue;
        scored.push({
            hit: {
                gid,
                id: f.id,
                preview: previewOf(f.value, max),
                hitIn: [...hitIn],
                review: f.review,
                lifecycle: f.lifecycle,
            },
            // 命中内容 > 命中键名：查"异常三档"时 value 里真讲了这件事，比 id 里凑巧有这三个字更有用
            score: hitIn.has("value") ? 0 : hitIn.has("id") ? 1 : 2,
        });
    }
    scored.sort((a, b) => a.score - b.score || a.hit.gid.localeCompare(b.hit.gid));
    const limit = opts.limit ?? 20;
    const hits = scored.slice(0, limit).map((s) => s.hit);
    const notes: string[] = [];
    if (scored.length === 0) notes.push(`没有命中「${keyword}」（换更短的词，或 \`diy facts status\` 看主题表）`);
    else if (scored.length > hits.length) notes.push(`共 ${scored.length} 条命中，显示前 ${hits.length}（--limit 调整）`);
    return { keyword, hits, total: scored.length, notes };
}

/** 提交载荷的 JSON 形状：`{ facts: [...], subjects?: [...] }`（也接受裸数组 = 只交 facts） */
export interface SubmitPayload {
    facts: unknown[];
    subjects: SubjectDef[];
}

export function parseSubmitPayload(text: string): SubmitPayload {
    let doc: unknown;
    try {
        doc = JSON.parse(text);
    } catch (err) {
        throw new FactsStoreError("agent/facts-payload-json", `--file 内容不是合法 JSON：${(err as Error).message}`);
    }
    if (Array.isArray(doc)) return { facts: doc, subjects: [] };
    if (doc === null || typeof doc !== "object") {
        throw new FactsStoreError("agent/facts-payload-shape", "载荷期望 { facts: [...], subjects?: [...] } 或裸数组");
    }
    const obj = doc as { facts?: unknown[]; subjects?: SubjectDef[] };
    return { facts: obj.facts ?? [], subjects: obj.subjects ?? [] };
}

export function submitPayload(payload: SubmitPayload, opts: { dir?: string; in?: string; dryRun?: boolean } = {}) {
    const target = resolveFactsTarget(opts);
    const kb = target.dir;
    const { facts, issues } = validateFacts(payload.facts);
    const { report, problems } = submit(
        kb,
        {
            facts,
            ...(payload.subjects.length > 0 ? { subjects: payload.subjects } : {}),
            dryRun: opts.dryRun === true,
        },
        targetOpts(target, true),
    );
    // zod 之外的语义问题由内核给（这里只把"形状都解析不出"的情况补上）
    const schemaProblems = issues.map((i) => ({ level: "error" as const, code: i.code, detail: i.detail, ...(i.facts ? { facts: i.facts } : {}) }));
    return { report: plainReport(report), problems: plainProblems([...schemaProblems, ...problems]) };
}

export function affectedByFiles(files: readonly string[], opts: { dir?: string; in?: string } = {}): { ids: string[] } {
    const target = resolveFactsTarget(opts);
    const kb = target.dir;
    const repo = loadRepo(kb, targetOpts(target));
    const index = buildIndex(repo.facts);
    return { ids: [...affected(index, files)] };
}

/**
 * 真源的**原始文本**（UI 展示「原 YAML」用；不做解析、不做校验）。
 *
 * 为什么不复用 `loadRepo`：`raw` 的用途正是"看真源长什么样"——经过解析再 dump 回来
 * 就变成了另一份文件（顺序、注释、空行全变），那看的就不是真源了。
 * 词表若为继承（任务级库本地没有 `subjects.yaml`），把**仓库那份**一并给出来并标明来源，
 * 否则 UI 上会出现"事实引用了一个词表里没有的 subject"的错觉。
 */
export function raw(opts: { dir?: string; in?: string } = {}) {
    const target = resolveFactsTarget(opts);
    const kb = target.dir;
    const factsDir = path.join(kb, "facts");
    const files = existsSync(factsDir)
        ? readdirSync(factsDir)
              .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
              .sort()
              .map((f) => ({ name: `facts/${f}`, text: readFileSync(path.join(factsDir, f), "utf8") }))
        : [];
    // 词表可能两份都在：本地那份是**局部扩词**，继承那份是仓库的全局词表。
    // 只给一份会让人看串（"任务只用了 1 个 subject"的错觉），所以都列、由 name 标明来源。
    const localSubjects = path.join(kb, "subjects.yaml");
    const subjects: { name: string; text: string }[] = [];
    if (existsSync(localSubjects)) subjects.push({ name: "subjects.yaml（本地）", text: readFileSync(localSubjects, "utf8") });
    if (target.subjectsFallback !== undefined && target.subjectsFallback !== localSubjects && existsSync(target.subjectsFallback)) {
        subjects.push({ name: "subjects.yaml（继承仓库）", text: readFileSync(target.subjectsFallback, "utf8") });
    }
    return { dir: kb, in: opts.in ?? "global", exists: files.length > 0, files, subjects };
}

/**
 * 投影：真源 → 给 LLM 看的形态（可换算法 / 可按预算裁剪 / 变体解析成当前值）。
 *
 * 命名空间按 `--in` 推：`task:<uri>` → task 命名空间；否则 project。
 * （`global` 库 = 设备级 `~/.diy/facts/`，尚无真源，暂不认。）
 */
export function projectFacts(
    opts: { dir?: string; in?: string; algorithm?: "yaml-nested" | "flat-gid" | "md-list"; maxBytes?: number; env?: Env; paths?: string[]; task?: string; includeProposed?: boolean } = {},
) {
    const target = resolveFactsTarget(opts);
    const kb = target.dir;
    if (target.allowMissing && !existsSync(path.join(kb, "facts"))) {
        throw new FactsStoreError(
            "agent/facts-repo-missing",
            `任务级库还没建：${kb} —— 第一次写入自动创建，先跑 \`diy facts submit --in ${opts.in ?? "task:<uri>"}\``,
        );
    }
    const { repo } = checkRepo(kb, targetOpts(target));
    const ns: Ns = opts.in?.startsWith("task:") ? { kind: "task", taskUri: opts.in.slice("task:".length) } : { kind: "project" };
    const out = project({
        entries: repo.facts.map((fact) => ({ ns, fact })),
        ctx: {
            ...(opts.env === undefined ? {} : { env: opts.env }),
            ...(opts.paths === undefined ? {} : { paths: opts.paths }),
            ...(opts.task === undefined ? {} : { task: opts.task }),
            ...(opts.includeProposed === undefined ? {} : { includeProposed: opts.includeProposed }),
        },
        ...(opts.algorithm === undefined ? {} : { algorithm: opts.algorithm }),
        ...(opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }),
    });
    // readonly → plain（同本文件其它 DTO 转换：摊开数组而不是 `as` 强转）
    return {
        algorithm: out.algorithm,
        text: out.text,
        bytes: out.bytes,
        shown: [...out.shown],
        omitted: [...out.omitted],
        skipped: [...out.skipped],
        problems: out.problems.map((p) => ({ gid: p.gid, code: p.code, ...(p.detail === undefined ? {} : { detail: p.detail }) })),
    };
}
