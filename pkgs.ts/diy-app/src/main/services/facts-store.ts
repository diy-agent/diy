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
import os from "node:os";
import path from "node:path";
import {
    DEFAULT_FULL_BUDGET,
    affected,
    buildIndex,
    checkExposeLeveled,
    defaultExposeOf,
    exposeOf,
    claimOf,
    resolveClaim,
    validateFacts,
    weightsOf,
    type Env,
    type ExposeLevel,
    type ExposeMap,
    type Fact,
    type Ns,
    type Ref,
    type Scope,
} from "@diy/facts";
import {
    checkFacts,
    checkRepo,
    loadRepo,
    readExpose,
    readSubjectDefs,
    submit,
    project,
    type SubjectDef,
    type Repo,
    type SubmitReport,
} from "@diy/facts/node";
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
/**
 * 报告里全是 readonly 数组（内核不可变纪律）→ 摊成 DTO。
 *
 * `created` 是 **app 侧**加的（内核不知道"库刚诞生"这件事 —— 它只管写文件，
 * 而 `atomic-write` 顺手建目录；"是不是新建的"只有调用方在写前那次 `existsSync` 能答）。
 */
function plainReport(r: SubmitReport, created?: { dir: string }) {
    return {
        dryRun: r.dryRun,
        added: [...r.added],
        updated: r.updated.map((u) => ({ id: u.id, before: u.before, after: u.after })),
        unchanged: [...r.unchanged],
        newSubjects: [...r.newSubjects],
        droppedSubjects: [...r.droppedSubjects],
        files: r.files.map((f) => ({ file: f.file, before: f.before, after: f.after })),
        dropped: [...r.dropped],
        ...(created === undefined ? {} : { created }),
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
 * 而在附加语义 —— 词表继承（否则每个任务复制一份 subjects.yaml 必然分叉），
 * 以及证据 / paths 的解析根不同（任务库讲的是代码仓的事）。
 * 把这几条塞进调用方，`submit` / `status` 就各写一遍，迟早不一致。
 *
 * **这里没有 `allowMissing`**（2026-10-23 删）：库不存在就是空库 —— 读就出空、
 * 写就直接写（`atomic-write` 顺带建目录）。"库建没建"不再需要每个入口各自判、各自抛。
 */
export interface FactsTarget {
    /** 库的 `knowledge/` 绝对路径 */
    readonly dir: string;
    /** 词表缺省来源（任务级库 → 仓库词表；仓库库自身 = 无） */
    readonly subjectsFallback?: string;
    /**
     * 证据 / paths 的解析根。任务级库指向**仓库根**而非任务目录 ——
     * 任务写的事实讲的是代码仓的事（`pkgs.ts/diy-app/src/x.ts:10`），
     * 按任务目录解析会让每条证据都悬空。
     */
    readonly root?: string;
    /**
     * 额外只读库（跨根读取）。目前只有 `global` 用：设备级事实讲的是"这台机器 / 这个用户"，
     * 与 `$DIY_HOME` 无关 —— lab 里也该看得到生产积累的全局规则。**只读**，写永远落本根。
     */
    readonly readExtra?: readonly string[];
    /** 库类型（只用来选缺省暴露档：task = full，project / global = index） */
    readonly kind?: "task" | "project" | "global";
}

/**
 * 设备级库的候选目录（**读**用）：本根 `<数据根>/knowledge` + 生产 `~/.diy/knowledge`。
 *
 * 为什么读要跨根、写不跨：设备级事实讲的是"这台机器 / 这个用户"，lab 里也该看到生产
 * 积累的全局规则；而写生产数据根是 guard 禁区（agent 不碰），故只读。
 */
function globalKbDirs(): string[] {
    const own = path.join(diyHome(), "knowledge");
    const prod = path.join(os.homedir(), ".diy", "knowledge");
    const out: string[] = [];
    for (const d of [own, prod]) {
        if (!out.includes(d) && existsSync(path.join(d, "facts"))) out.push(d);
    }
    return out;
}

const TASK_IN = /^task:(projects\/\d+\/tasks\/\d+)$/;

/**
 * `--in` 的语义：`task:<taskUri>` 指向任务级库，其余（含缺省）指向仓库库。
 *
 * 为什么不给任务库留「当前任务」缺省：agent 常常同时在两个任务里干活（父任务排期、
 * 子任务开发），"当前"根本无从判断 —— 写错库比多敲十次 uri 危险得多。
 */
export function resolveFactsTarget(opts: { dir?: string; in?: string } = {}): FactsTarget {
    const spec = opts.in?.trim() ?? "";
    // 设备级库（`~/.diy/knowledge/`）：讲"这台机器 / 这个用户"的事实，跨项目可用
    // （`~/AGENTS.md` 的全局规则归它）。与仓库库分开是因为**归属不同**：全局规则换到
    // 另一个项目里也该查得到 —— 塞进某项目的 `knowledge/` 就是 scope 错位。
    if (spec === "global") {
        const ownDir = path.join(diyHome(), "knowledge");
        // 跨根读：生产 `~/.diy/knowledge` 与本根不同则并入（只读）。用真 home 而不是
        // dirname(DIY_HOME)：lab 的 DIY_HOME 在 build/lab/home，dirname 会算到 build/lab。
        const prodKb = path.join(os.homedir(), ".diy", "knowledge");
        const readExtra = prodKb === ownDir || !existsSync(path.join(prodKb, "facts")) ? [] : [prodKb];
        const out: FactsTarget = { dir: ownDir, kind: "global", ...(readExtra.length > 0 ? { readExtra } : {}) };
        // 词表仍优先继承仓库（同一套 subject 命名），但**仓库缺失时不阻塞**：设备库
        // 可能在任何目录下被读（agent 的 cwd 不一定是仓库）。
        try {
            const repoKb = resolveFactsDir(undefined);
            return {
                ...out,
                subjectsFallback: path.join(repoKb, "subjects.yaml"),
                // 证据按**真家目录**解析（不是 dirname(DIY_HOME)）：全局规则引用的是
                // `~/AGENTS.md` 这类位置，而 lab 的 DIY_HOME 在 build/lab/home 下，
                // dirname 会算到 build/lab —— 生产里两者恰好相同，所以只有 lab 会暴露。
                root: os.homedir(),
            };
        } catch {
            return out;
        }
    }
    if (spec !== "" && spec !== "project") {
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
        // 读时并入低层库（project → global）：**三个读入口（get / brief / project）与
        // runtime 投影必须同口径**，否则会出现"投影里看得到、CLI 查不到"的中间态
        // （实测：把 project 侧同名 claim 标 superseded 后，投影正常而 `get` 报 scope-no-match）。
        const taskExtra = [...globalKbDirs(), repoKb].filter((d) => d !== path.join(taskDir, "knowledge"));
        return {
            dir: path.join(taskDir, "knowledge"),
            kind: "task",
            // 任务库继承仓库词表：本地 subjects.yaml 存在则本地优先（局部扩词），否则用仓库的
            subjectsFallback,
            root: path.dirname(repoKb),
            ...(taskExtra.length > 0 ? { readExtra: taskExtra } : {}),
        };
    }
    // 仓库库（缺省 / project）：读时同样并入设备级库 —— 与 runtime 投影同口径
    const projectDir = resolveFactsDir(opts.dir);
    const projectExtra = globalKbDirs().filter((d) => d !== projectDir);
    return {
        dir: projectDir,
        kind: "project",
        ...(projectExtra.length > 0 ? { readExtra: projectExtra } : {}),
    };
}

/**
 * `FactsTarget` → 内核选项。
 *
 * `forWrite` 现在只做一件事：**写时不读额外库**（否则 submit 会把跨根读来的条目当成
 * "本库已有"而漏写）。"建不建目录"已不在选项里 —— 读永不碰磁盘，写由 `atomic-write` 建。
 */
function targetOpts(t: FactsTarget, forWrite = false) {
    return {
        ...(t.subjectsFallback === undefined ? {} : { subjectsFallback: t.subjectsFallback }),
        ...(t.root === undefined ? {} : { root: t.root }),
        ...(t.kind === undefined ? {} : { kind: t.kind }),
        // 写时**不**读额外库：否则 submit 会把跨根读来的条目当成"本库已有"而漏写
        ...(!forWrite && t.readExtra !== undefined ? { extraDirs: t.readExtra } : {}),
    };
}

/**
 * 跨库双写审计：**同一 claim 在两个库都有可用事实**（active + accepted）⇒ 漂移风险。
 *
 * 为什么要单写一份扫描（而不是统计 `repo.facts`）：额外库装载时主库已可用的 claim 会被
 * **跳过**（`loadRepo` 的 `seen`）—— 合并后的条目表里天然看不到"两处都写"，问题也就藏在这里。
 * 判据只看「可用事实」：`superseded` 让位是正确的覆盖表达，不算双写；同库内多个 env 变体
 * 也不算（那是同一处维护的变体）。
 *
 * 为什么是问题：覆盖的正确表达是**让位**，投影只解析一次。两处都 active = 两个真源各自维护
 * 同一件事 —— 今天值一样是巧合，明天改一处就分叉，而分叉是**静默的**（低层那份永不现形）。
 */
function crossLibDups(repo: Repo, kb: string, extraDirs: readonly string[]): DtoProblem[] {
    const usable = (f: Fact): boolean => f.lifecycle === "active" && f.review === "accepted";
    const mine = new Set(repo.files.map((f) => path.resolve(f)));
    const local = new Map<string, { ids: string[]; values: Set<string> }>();
    for (const f of repo.facts) {
        if (!usable(f) || !mine.has(path.resolve(repo.origin.get(f.id) ?? ""))) continue;
        const claim = claimOf(f);
        const slot = local.get(claim) ?? { ids: [], values: new Set<string>() };
        slot.ids.push(f.id);
        slot.values.add(f.value);
        local.set(claim, slot);
    }
    if (local.size === 0) return [];
    const out: DtoProblem[] = [];
    for (const dir of extraDirs) {
        const abs = path.resolve(dir);
        if (abs === path.resolve(kb) || !existsSync(path.join(abs, "facts"))) continue;
        let other: Repo;
        try {
            // 读操作永不建库（2026-10-23：`allowMissing` 已从内核删掉，读路径本就不碰磁盘）
            other = loadRepo(abs);
        } catch {
            // 额外库坏了不该让 status 不可用（它是"参考"，不是真源）
            continue;
        }
        const theirs = new Map<string, { ids: string[]; values: Set<string> }>();
        for (const f of other.facts) {
            if (!usable(f)) continue;
            const claim = claimOf(f);
            const slot = theirs.get(claim) ?? { ids: [], values: new Set<string>() };
            slot.ids.push(f.id);
            slot.values.add(f.value);
            theirs.set(claim, slot);
        }
        for (const [claim, a] of local) {
            const b = theirs.get(claim);
            if (b === undefined) continue;
            const values = new Set([...a.values, ...b.values]);
            out.push({
                level: "warning",
                code: "facts/cross-lib-dup",
                detail:
                    values.size === 1
                        ? `同一 claim 在 2 个库都有可用事实（两处维护 = 必然漂移，值暂时相同）：${claim} —— 本库{${a.ids.join(", ")}} / ${abs}{${b.ids.join(", ")}}；删掉冗余的一份`
                        : `同一 claim 在 2 个库有**不同**值（低特定度那份被静默让位、永不现形）：${claim} —— 本库{${a.ids.join(", ")}} / ${abs}{${b.ids.join(", ")}}；把让位的那份标 superseded 或 drop`,
                facts: [...a.ids, ...b.ids],
            });
        }
    }
    return out;
}

export function status(opts: { dir?: string; in?: string } = {}) {
    const target = resolveFactsTarget(opts);
    const kb = target.dir;
    // 库不存在 = 空库（2026-10-23 删掉"库还没建"的抛错）：读就出空，零计数照常返回。
    // 这行注释是**护栏**，别把「没库」当错误加回来 —— 那会让空库上 `status` 不可用，
    // 而 `submit --dry-run` 又偷偷把库建出来，两边自相矛盾。
    const repo = loadRepo(kb, targetOpts(target));
    // 词表 = 本根 ∪ 额外库：额外库（设备级）独有的 subject 在本根词表里当然没有 ——
    // 只认本根会把它们全判 `subject-unregistered`（实测 `skill` 只在设备库词表里，
    // 于是 `diy facts status` 对着自己的库报"未登记"，看着像库坏了）。
    const extraDirs = target.readExtra ?? [];
    const extraSubjects = extraDirs.flatMap((d) => readSubjectDefs(d));
    const vocab = new Map<string, SubjectDef>();
    for (const s of [...repo.subjects, ...extraSubjects]) if (!vocab.has(s.key)) vocab.set(s.key, s);
    const problems = [
        ...repo.schemaIssues,
        ...checkFacts(repo.facts, {
            subjects: [...vocab.values()],
            root: repo.root,
            // unused 只看**本地声明**的 subject：继承来的不该因为"本库没用"就告警
            subjectsUnusedScope: repo.localSubjects.map((s) => s.key),
        }),
    ];
    // 计数分桶：本根 vs 额外库。混在一桶里会让"我什么都没干，项目库一夜多 19 条"
    // 这种假象出现（实测 ##5 就这么被误导过）。
    const mine = new Set(repo.files.map((f) => path.resolve(f)));
    const isMine = (id: string): boolean => mine.has(path.resolve(repo.origin.get(id) ?? ""));
    const local = repo.facts.filter((f) => isMine(f.id));
    const extra = repo.facts.filter((f) => !isMine(f.id));
    const countOf = (list: readonly Fact[]) => ({
        facts: list.length,
        claims: new Set(list.map((f) => `${f.subject}#${f.aspect}`)).size,
        subjects: new Set(list.map((f) => f.subject)).size,
    });
    // 暴露档：**按库**解析（每个库各读自己的 `expose.yaml`，各按库类型缺省档回落）。
    // 曾合并成一张表 —— 那会让"项目库声明了一条 expose"顺手把任务库的结论降级（##5 第 8 轮）。
    const libKind = opts.in !== undefined && opts.in.startsWith("task:") ? "task" : opts.in === "global" ? "global" : "project";
    const libExpose = new Map<string, { map: ExposeMap; kind: string }>();
    for (const d of [...extraDirs, kb]) {
        libExpose.set(path.resolve(d), { map: readExpose(d), kind: path.resolve(d) === path.resolve(kb) ? libKind : "global" });
    }
    const libOf = (f: Fact): { map: ExposeMap; kind: string } => {
        const origin = path.resolve(repo.origin.get(f.id) ?? kb);
        for (const [dir, lib] of libExpose) if (origin === dir || origin.startsWith(`${dir}${path.sep}`)) return lib;
        return { map: {} as ExposeMap, kind: libKind };
    };
    const hasExposeFile = [...libExpose.keys()].some((d) => existsSync(path.join(d, "expose.yaml")));
    const exposeProblems = hasExposeFile
        ? checkExposeLeveled(
              repo.facts.map((f) => {
                  const lib = libOf(f);
                  return { fact: f, level: exposeOf(lib.map, f.subject, defaultExposeOf(lib.kind)) };
              }),
              { budget: DEFAULT_FULL_BUDGET },
          )
        : [];
    for (const p of exposeProblems) problems.push({ level: "error", code: p.code, detail: p.detail, ...(p.facts ? { facts: [...p.facts] } : {}) });
    for (const p of crossLibDups(repo, kb, extraDirs)) problems.push(p);

    // 按 subject 的字节账：预算的单位是**字节**，而 status 原本只给 claims 数 ——
    // 人看不到"这个话题占多少"就没法决定该把它放 full 还是 index（实测 `rule` 一个主题 9.3 KB）。
    const weights = weightsOf(repo.facts);
    // 一个 subject 可能横跨多库（project 声明 index、global 声明 full）：取**先到的那个库**
    // 的档位（`weightsOf` 已按字节降序，这里只借它挑代表库）。档位是给人看的提示，
    // 真正的判据在投影里逐库解析。
    const bySubject = weights.map((w) => {
        const first = repo.facts.find((f) => f.subject === w.subject && f.lifecycle === "active" && f.review === "accepted");
        const lib = first === undefined ? { map: {} as ExposeMap, kind: libKind } : libOf(first);
        return { ...w, expose: exposeOf(lib.map, w.subject, defaultExposeOf(lib.kind)) };
    });

    return {
        dir: kb,
        // 缺省读仓库库 ⇒ 回报 project（`global` 是另一份真源，别混）
        in: opts.in ?? "project",
        // 顶层计数 = **本根**（与加分桶前口径一致：status 报的是"我的库")
        ...countOf(local),
        files: repo.files.length,
        /** 额外只读库的并入量（读跨根、写不跨根；`dirs` 为空时 `facts === 0`） */
        extra: { ...countOf(extra), dirs: [...extraDirs] },
        /** 按 subject 的权重表（bytes = 可用事实的 value 字节和；按字节降序） */
        bySubject,
        /** `full` 档字节和 / 预算（>limit ⇒ problems 里有 `facts/expose-budget`） */
        exposeBudget: { used: bySubject.filter((s) => s.expose === "full").reduce((n, s) => n + s.bytes, 0), limit: DEFAULT_FULL_BUDGET },
        problems: plainProblems(problems),
    };
}

/**
 * 条目来源文件的**可读路径**：一律绝对。
 *
 * 为什么不再给相对路径：agent 的 cwd 是项目目录（`build/lab/home/sample-project`），
 * 而 `repo.root` 是**库的**根（`build/lab/home` 或仓库根）—— 相对 `repo.root` 给出的
 * `build/lab/home/knowledge/facts/rule.yaml` 在 cwd 下 `cat` 不到。上一版"逃逸才绝对"
 * 的判据在 lab 里永远不触发（`build/lab/home` 就在 repo 内），于是这个 bug 只在生产现形。
 *
 * 判据只有一条：**路径必须能直接 `open`**。去掉"你得先知道自己在哪个目录"这个隐含前提。
 */
function displayFile(repo: { readonly root: string; readonly origin: ReadonlyMap<string, string> }, id: string): string {
    const abs = repo.origin.get(id) ?? "";
    return abs === "" ? "" : path.resolve(abs);
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
        resolved.push({ claim, facts: [plainFact(chosen, displayFile(repo, chosen.id))] });
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

/**
 * 一条摘要。**除 aspect/gid/preview 外都可省** —— 省掉的是"缺省值"和"重复值"：
 * - `variants` 只在 >1 时出现（1 个变体是常态，32 条各写一次 `variants: 1` 纯噪声）
 * - `review` / `lifecycle` 只在**异常态**出现（accepted / active 是常态）
 * - `file` 只在同主题内**不同源**时出现在条目上；同源时提到 `BriefResult.file`
 *   （实测 `brief app.find` 10.5 KB 里 5.3 KB 是元数据，其中 32 份同一个绝对路径 ≈2.9 KB）
 */
export interface BriefEntry {
    aspect: string;
    gid: string;
    preview: string;
    /** 变体数（>1 才出现 ⇒ 还有别的值，问"当前环境是哪个"要 `get --env`） */
    variants?: number;
    /** 只在非 accepted 时出现 */
    review?: string;
    /** 只在非 active 时出现（`superseded` 说明这个 claim 的可用值在另一条上） */
    lifecycle?: string;
    /** 只在同一主题的条目**不共享同一个文件**时出现 */
    file?: string;
}

export interface BriefMultiResult {
    readonly subjects: BriefResult[];
    /** 给了 `--budget` 才有：上限与实际占用（近似字数，不是 UTF-8 字节） */
    readonly budget?: { readonly limit: number; readonly used: number };
}

export interface BriefResult {
    subject: string;
    desc: string | null;
    claims: number;
    facts: number;
    /** 该主题全部条目同源一个文件时给出（条目上就不再重复） */
    file?: string;
    entries: BriefEntry[];
    notes: string[];
}

/**
 * 变体组的代表：accepted 优先 → **最通用**的一条 → id（保证稳定，不随文件行序抖）。
 *
 * "最通用"不是"限定条件个数最少"，而是**覆盖面最大**：`env: [development, test]`
 * 同时管两个环境，比 `env: production` 更像通例。所以按覆盖数算宽窄，不是按"有没有 scope"。
 */
function pickRepresentative(list: readonly Fact[]): Fact {
    // lifecycle 必须是**第一维**：跨库并存时同 claim 会有两条（项目库 + 设备库），
    // 只按 review 排 + id 字典序 ⇒ 永远选中 `agents.*`（项目库那条）。一旦它被标
    // superseded，代表条目就成了"已失效的那条"，人/agent 读到 `lifecycle: superseded`
    // 会以为这个 claim 没有可用值 —— 而值其实是好的，只是住在另一条上（实测 ##5 撞到）。
    const stale = (f: Fact): number => (f.lifecycle === "active" ? 0 : 1);
    const rank = (f: Fact): number => (f.review === "accepted" ? 0 : f.review === "proposed" ? 1 : 2);
    const breadth = (f: Fact): number => {
        const s = f.scope;
        if (s === undefined) return 0;
        const env = s.env === undefined ? 0 : Array.isArray(s.env) ? s.env.length : 1;
        const paths = s.paths === undefined ? 0 : s.paths.length;
        const task = s.task === undefined ? 0 : 1;
        return 100 - (env + paths + task);
    };
    return [...list].sort(
        (a, b) => stale(a) - stale(b) || rank(a) - rank(b) || breadth(a) - breadth(b) || a.id.localeCompare(b.id),
    )[0] as Fact;
}

/**
 * 目录级：列一个 subject 的**全部 aspect**（gid + 值首句）。
 *
 * 为什么需要它（这是本命令存在的唯一理由）：`get` 要精确 claim、`status` 只给计数，
 * 中间那层"这个主题下有哪些条目"原本不存在 ⇒ 链上正文就删不掉（删了不知从何查起）。
 */
function briefOne(
    subjectIn: string,
    opts: { dir?: string; in?: string; maxChars?: number } = {},
    /** 预载的库（`brief` 多主题 / 通配时避免同一份 YAML 反复解析） */
    preloaded?: Repo,
): BriefResult {
    const subject = subjectIn.trim();
    if (subject === "") {
        throw new FactsStoreError("agent/facts-brief-arg", "brief 需要 subject（如 `diy facts brief find`）");
    }
    const repo =
        preloaded ??
        (() => {
            const target = resolveFactsTarget(opts);
            return loadRepo(target.dir, targetOpts(target));
        })();
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
            const entry: BriefEntry = {
                aspect,
                gid: `${subject}#${aspect}`,
                preview: previewOf(rep.value, max),
            };
            // 缺省值不写：1 个变体 / accepted / active 是常态，写出来只是给每条加 ~30 B
            if (list.length > 1) entry.variants = list.length;
            if (rep.review !== "accepted") entry.review = rep.review;
            if (rep.lifecycle !== "active") entry.lifecycle = rep.lifecycle;
            entry.file = displayFile(repo, rep.id);
            return entry;
        });
    // 同源时把 `file` 提到主题级（32 条重复同一个绝对路径 ≈2.9 KB/次查询）
    const files = new Set(entries.map((e) => e.file));
    const out: BriefResult = { subject, desc, claims: entries.length, facts: mine.length, entries, notes };
    if (files.size === 1) {
        out.file = [...files][0] as string;
        for (const e of entries) delete e.file;
    }
    return out;
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

/**
 * 通配展开：`app.*` 或裸前缀 `app`（当库里没有恰好叫 `app` 的主题时）展开成全部同前缀主题。
 * 精确命中的主题原样保留（不做前缀猜测 —— 猜错比不猜更贵）。
 */
export function expandSubjects(list: readonly string[], all: readonly string[]): string[] {
    const known = new Set(all);
    const out: string[] = [];
    for (const raw of list) {
        const glob = raw.endsWith(".*") ? raw.slice(0, -2) : null;
        const prefix = glob ?? raw;
        // 裸前缀本体算组内（与索引折叠同口径：`dev.*` 展开要能看到 `dev` 自己）
        const hits = [...known].filter((s) => s === prefix || s.startsWith(`${prefix}.`)).sort((a, b) => a.localeCompare(b));
        if (glob !== null || (!known.has(raw) && hits.length > 0)) {
            if (hits.length === 0) out.push(raw); // 一个都没展开 ⇒ 照旧交给 briefOne 报"没这个 subject + 相近的"
            else out.push(...hits);
            continue;
        }
        out.push(raw);
    }
    return [...new Set(out)];
}

/**
 * 目录级摘要（支持**多个 subject**，逗号分隔）。
 *
 * 为什么多主题是一等需求而不是便利功能：了解 3 个主题 = 3 次工具调用 = 3 轮，
 * 而每轮都要重发整份前缀（实测 41 KB）。**查询次数是隐藏成本**，把它压成 1 次
 * 省下的比"少几条正文"多一个量级。
 *
 * `--budget`（总字节）：先按 `maxChars` 生成，超预算才按比例缩（下限 24 字）重算一次。
 * 不追求精确贴合 —— 宁可少缩一点，也不要为了凑整把 preview 截成看不懂的样子。
 */
export function brief(
    subjectsIn: string,
    opts: { dir?: string; in?: string; maxChars?: number; budget?: number } = {},
): BriefMultiResult {
    const list = subjectsIn
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x !== "");
    if (list.length === 0) {
        throw new FactsStoreError("agent/facts-brief-arg", "brief 需要 subject（如 `diy facts brief find`，多个用逗号）");
    }
    const max = opts.maxChars ?? 80;
    // 通配展开（##5 第 9 轮）：索引折叠后 `app.*` 只剩一行，展开必须**一次调用**能完成 ——
    // 否则折叠省下的索引用途变成了"省了字节、断了去路"。
    const target = resolveFactsTarget(opts);
    const repo = loadRepo(target.dir, targetOpts(target));
    const subjects = expandSubjects(list, repo.facts.map((f) => f.subject));
    const build = (chars: number): BriefResult[] => subjects.map((s) => briefOne(s, { ...opts, maxChars: chars }, repo));
    const usedOf = (rs: readonly BriefResult[]): number =>
        rs.reduce(
            (n, r) => n + r.subject.length + r.entries.reduce((m, e) => m + e.gid.length + e.preview.length + 12, 0),
            0,
        );
    let results = build(max);
    let used = usedOf(results);
    if (opts.budget !== undefined && opts.budget > 0 && used > opts.budget) {
        // 按**固定开销**先扣掉再均分：gid + 每条 12 字的结构开销是省不掉的，按比例缩
        // preview 会在条目多时永远够不着预算（试过：24 字下限 + 20 字固定开销仍超）。
        const fixed = results.reduce(
            (n, r) => n + r.subject.length + r.entries.reduce((m, e) => m + e.gid.length + 12, 0),
            0,
        );
        const entries = results.reduce((n, r) => n + r.entries.length, 0);
        // -1 给截断符 `…` 留位（previewOf 超长时输出 max+1 字符）
        const per = entries === 0 ? max : Math.max(8, Math.floor((opts.budget - fixed) / entries) - 1);
        results = build(Math.min(max, per));
        used = usedOf(results);
    }
    return {
        subjects: results,
        ...(opts.budget === undefined ? {} : { budget: { limit: opts.budget, used } }),
    };
}

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
    // subject 的 description 也进检索面：agent 听到的往往是**人话**（"端口"、"异常三档"），
    // 而 claim 里是 `app.port` / `rule.err-triage` —— 只搜键名等于要求它先知道答案。
    const descOf = new Map(repo.subjects.map((s) => [s.key, (s.description ?? "").toLowerCase()]));
    const scored: { hit: FindHit; score: number }[] = [];
    for (const f of repo.facts) {
        const gid = `${f.subject}#${f.aspect}`;
        const haystack: Record<string, string> = {
            claim: gid.toLowerCase(),
            id: f.id.toLowerCase(),
            value: f.value.toLowerCase(),
            subject: descOf.get(f.subject) ?? "",
        };
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
            // 命中内容 > 命中主题说明 > 命中键名：查"异常三档"时 value 里真讲了这件事，
            // 比 id 里凑巧有三个字更有用；主题说明（人话）又比 claim（标识符）更接近提问方式。
            score: hitIn.has("value") ? 0 : hitIn.has("subject") ? 1 : hitIn.has("id") ? 2 : 3,
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

/**
 * 提交载荷的 JSON 形状：`{ facts: [...], subjects?: [...], drop?: [...] }`（也接受裸数组 = 只交 facts）。
 *
 * `drop` 是**物理删除**的 id 列表，与 `facts` 同批事务（见内核 `SubmitInput.drop` 的长注）。
 * 典型用法 = 改名：`{ drop: ["agents.rule.lang"], facts: [{ id: "global.rule.lang", ... }] }`
 * —— 删旧 + 写新 + 补 `supersedes` 边三件事必须原子，否则中间态是悬空边或断头事实。
 */
export interface SubmitPayload {
    facts: unknown[];
    subjects: SubjectDef[];
    /** 选填：老载荷（`{facts, subjects}`）不带它也得能跑 —— 缺省 = 不删任何东西 */
    drop?: string[];
    /**
     * 选填：从**本地**词表删除的 subject key（与 `facts` / `subjects` / `drop` **同批事务**）。
     *
     * 为什么要它（实测事故）：`subjects` 只有增没有删，写错一个 key 就永久占着词表；agent
     * 不许手改 YAML ⇒ 唯一出路是 `git checkout knowledge/subjects.yaml` —— 那等于"写入口
     * 有护栏、删入口绕过护栏"。删入口同样只有 `submit` 这一条。
     */
    dropSubjects?: string[];
    /** 暴露档修订（`subject → full|index|none`）；不给 = 不动 `expose.yaml` */
    expose?: Record<string, ExposeLevel>;
}

export function parseSubmitPayload(text: string): SubmitPayload {
    let doc: unknown;
    try {
        doc = JSON.parse(text);
    } catch (err) {
        throw new FactsStoreError("agent/facts-payload-json", `--file 内容不是合法 JSON：${(err as Error).message}`);
    }
    if (Array.isArray(doc)) return { facts: doc, subjects: [], drop: [], dropSubjects: [] };
    if (doc === null || typeof doc !== "object") {
        throw new FactsStoreError("agent/facts-payload-shape", "载荷期望 { facts: [...], subjects?: [...], drop?: [...] } 或裸数组");
    }
    const obj = doc as { facts?: unknown[]; subjects?: SubjectDef[]; drop?: unknown[]; dropSubjects?: unknown[]; expose?: unknown };
    const drop = (obj.drop ?? []).map((id) => {
        if (typeof id !== "string" || id.trim() === "") {
            throw new FactsStoreError("agent/facts-payload-shape", `drop 只收 fact id 字符串，实际收到：${JSON.stringify(id)}`);
        }
        return id.trim();
    });
    const dropSubjects = (obj.dropSubjects ?? []).map((key) => {
        if (typeof key !== "string" || key.trim() === "") {
            throw new FactsStoreError("agent/facts-payload-shape", `dropSubjects 只收 subject key 字符串，实际收到：${JSON.stringify(key)}`);
        }
        return key.trim();
    });
    const expose = parseExpose(obj.expose);
    return {
        facts: obj.facts ?? [],
        subjects: parseSubjects(obj.subjects),
        drop,
        dropSubjects,
        ...(expose === undefined ? {} : { expose }),
    };
}

/** `subjects` 元素允许的字段（写错字段名**必须当场报错**，见 `parseSubjects`） */
const SUBJECT_KEYS = new Set(["key", "description", "aliases"]);

/**
 * `subjects` 载荷：`[{ key, description?, aliases? }]`。
 *
 * 为什么必须在这里严格校验（实测事故）：元素写错字段名（`subject:` 而不是 `key:`）时
 * `key` 是 `undefined`，一路穿到写盘阶段才在 `undefined.localeCompare` 上抛
 * `TypeError: Cannot read properties of undefined` —— 报错看起来像程序崩了，而不是
 * "你载荷写错了"。**形状错必须在入口拒**，并直接给正确形状。
 *
 * （`facts` 里拼错字段有 `facts/schema` 的「未知字段（拼错了？）」兜着，subjects 原先连这个都没有。）
 */
function parseSubjects(raw: unknown): SubjectDef[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
        throw new FactsStoreError("agent/facts-payload-shape", `subjects 期望数组，实际收到：${JSON.stringify(raw)}`);
    }
    return raw.map((item, i) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
            throw new FactsStoreError("agent/facts-payload-shape", `subjects[${i}] 期望对象，实际收到：${JSON.stringify(item)}`);
        }
        const rec = item as Record<string, unknown>;
        for (const k of Object.keys(rec)) {
            if (!SUBJECT_KEYS.has(k)) {
                throw new FactsStoreError(
                    "agent/facts-payload-shape",
                    `subjects[${i}] 未知字段 "${k}"（拼错了？）—— 元素形如 { key, description?, aliases? }；` +
                        `注意字段名是 key，不是 subject/name/id`,
                );
            }
        }
        if (typeof rec.key !== "string" || rec.key.trim() === "") {
            throw new FactsStoreError(
                "agent/facts-payload-shape",
                `subjects[${i}].key 必须是非空字符串 —— 元素形如 { key, description?, aliases? }`,
            );
        }
        const aliases = rec.aliases;
        if (aliases !== undefined && (!Array.isArray(aliases) || aliases.some((a) => typeof a !== "string"))) {
            throw new FactsStoreError("agent/facts-payload-shape", `subjects[${i}].aliases 期望字符串数组`);
        }
        return {
            key: rec.key.trim(),
            ...(typeof rec.description === "string" ? { description: rec.description } : {}),
            ...(aliases === undefined ? {} : { aliases: aliases as string[] }),
        };
    });
}

/**
 * `expose` 载荷：`{ "<subject>": "full" | "index" | "none" }`。
 *
 * 形状错在这里就拒（`agent/facts-payload-shape`）；**档位非法不在这里拒** —— 交给内核
 * `checkExpose` 报 `facts/expose-level`，一处判据（否则两处会分叉）。
 */
function parseExpose(raw: unknown): Record<string, ExposeLevel> | undefined {
    if (raw === undefined) return undefined;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new FactsStoreError("agent/facts-payload-shape", `expose 期望 { subject: level } 对象，实际收到：${JSON.stringify(raw)}`);
    }
    if (Object.keys(raw).length === 0) return undefined;
    const out: Record<string, ExposeLevel> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        out[k] = (typeof v === "string" ? v : String(v)) as ExposeLevel;
    }
    return out;
}

export function submitPayload(payload: SubmitPayload, opts: { dir?: string; in?: string; dryRun?: boolean } = {}) {
    const target = resolveFactsTarget(opts);
    const kb = target.dir;
    /**
     * 本批会不会**顺手建库**（写前磁盘状态）。
     *
     * 为什么需要回显：`--in task:<uri>` / `global` 的路径是**推导**出来的，建库是预期行为；
     * 而 `--dir <path>` 是**人手敲的**，写到一个不存在的路径也会"成功"—— 不提示就等于默许
     * 他把知识写进了另一个库。判据：**不阻止，也不静默**。
     * `--dry-run` 恒不出（它一个字都不写，自然也不会建库）。
     */
    const willCreate = opts.dryRun !== true && !existsSync(path.join(kb, "facts"));
    const { facts, issues } = validateFacts(payload.facts);
    // 事务边界在这一句上：**形状校验不过，一个字都不写**。
    //
    // 原先这里只是"把 issues 拼进返回值"，照样调用 `submit(facts)` —— 于是坏事实被过滤成空集，
    // 内核愉快地写下了 subjects，最终返回"error：事实 0 条"，磁盘上却已经多了那个 subject
    // （实测 ##5：`runtime.kb` 冒出 `flow.* — 6 个主题 / 0 条`，且没有任何 CLI 出口能撤）。
    // 判据：`facts` 的 schema 错属于**载荷错误**，不是"部分可用"——整批退，让它重提。
    if (issues.length > 0) {
        return {
            report: plainReport({
                dryRun: opts.dryRun === true,
                added: [],
                updated: [],
                unchanged: [],
                newSubjects: [],
                droppedSubjects: [],
                files: [],
                dropped: [],
            }),
            problems: plainProblems(issues.map((i) => ({ level: "error" as const, code: i.code, detail: i.detail, ...(i.facts ? { facts: i.facts } : {}) }))),
        };
    }
    const { report, problems } = submit(
        kb,
        {
            facts,
            ...(payload.subjects.length > 0 ? { subjects: payload.subjects } : {}),
            ...((payload.drop ?? []).length > 0 ? { drop: payload.drop ?? [] } : {}),
            ...((payload.dropSubjects ?? []).length > 0 ? { dropSubjects: payload.dropSubjects ?? [] } : {}),
            ...(payload.expose === undefined ? {} : { expose: payload.expose }),
            dryRun: opts.dryRun === true,
        },
        targetOpts(target, true),
    );
    // zod 之外的语义问题由内核给（这里只把"形状都解析不出"的情况补上）
    const schemaProblems = issues.map((i) => ({ level: "error" as const, code: i.code, detail: i.detail, ...(i.facts ? { facts: i.facts } : {}) }));
    // 写成功后库才真的在：以**写后**的磁盘状态为准（写失败会抛，走不到这里）
    const created = willCreate && existsSync(path.join(kb, "facts")) ? { dir: kb } : undefined;
    return { report: plainReport(report, created), problems: plainProblems([...schemaProblems, ...problems]) };
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
    // 库不存在 = 空库（2026-10-23 删掉"库还没建"的抛错）：读就出空，零计数照常返回。
    // 这行注释是**护栏**，别把「没库」当错误加回来 —— 那会让空库上 `status` 不可用，
    // 而 `submit --dry-run` 又偷偷把库建出来，两边自相矛盾。
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
