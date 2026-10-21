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
import { existsSync } from "node:fs";
import path from "node:path";
import { affected, buildIndex, resolveClaim, validateFacts, type Env, type Fact, type Ref, type Scope } from "@diy/facts";
import { checkRepo, loadRepo, submit, type SubjectDef, type SubmitReport } from "@diy/facts/node";
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
export function resolveFactsDir(explicit?: string): string {
    if (explicit !== undefined && explicit !== "") return path.resolve(explicit);
    const fromEnv = process.env["DIY_FACTS_DIR"];
    if (fromEnv !== undefined && fromEnv !== "") return path.resolve(fromEnv);
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
        return {
            dir: path.join(taskDir, "knowledge"),
            // 任务库继承仓库词表：本地 subjects.yaml 存在则本地优先（局部扩词），否则用仓库的
            subjectsFallback: path.join(repoKb, "subjects.yaml"),
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
