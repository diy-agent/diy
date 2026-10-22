/**
 * facts-context.ts — 把事实库**投影成上下文变量树的一个单元**（##404 待办 4）
 *
 * 为什么单独一份而不是塞进 prompt-registry：本文件是"读真源 + 投影"的唯一入口，
 * 而 prompt-registry 只负责"把它挂到变量树上"。分开放，是因为将来还有第二个消费者
 * （`diy facts context --in task:<uri>` 预览 / 页面上的"这一轮会投什么"）。
 *
 * 三条纪律：
 *   ① **读操作永不建库**（`allowMissing: false`）：投影顺手 `mkdir` 会让"库建没建"不可判定。
 *   ② **读失败不许炸掉整轮**：库坏了 / 找不到，降级为"这个单元缺席 + 一条 problem" ——
 *      上下文构造失败 = 人连消息都发不出去，代价远大于"这一轮没看到事实"。
 *   ③ **不在这里拼给人看的句子**（句子归 CLI 的 format*）：这里只出结构化值，
 *      信封由通用渲染器出 YAML。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { foldKbIndex, KB_FOLD_MIN_GROUP } from "@diy/facts";
import { loadRepo, project, projectItems, readExpose, type ProjectEntry, type ProjectionAlgorithm, type Repo } from "@diy/facts/node";
import { bytesOf, checkExposeLeveled, defaultExposeOf, exposeOf, type ExposeLevel, type ExposeMap, type LeveledFact, type Ns } from "@diy/facts";
import { diyHome } from "../core/state";
import { readRuntimeConfig } from "../../runtime";
import { resolveFactsDir } from "./facts-store";
import type { FactsCell } from "../../shared/prompt-schema";

/** 投影的一个值（与 `FactsContextSchema` 的 cell 同形；renderer 侧由 schema 推） */
export type FactsContextCell = FactsCell;

export interface FactsContextValue {
    algorithm: ProjectionAlgorithm;
    env: string;
    task?: Record<string, FactsContextCell>;
    /** 设备级库（`~/.diy/knowledge/`）：跨项目的用户规则 */
    global?: Record<string, FactsContextCell>;
    project?: Record<string, FactsContextCell>;
    text?: string;
    omitted: number;
    problems: { gid: string; code: string }[];
}

/** 投影默认预算：超了从尾部（project 侧）裁。不是硬上限 —— 只在条目异常多时兜底 */
export const DEFAULT_FACTS_MAX_BYTES = 4000;

interface Loaded {
    ns: Ns;
    repo: Repo;
    /** 该库的暴露档（`<库>/expose.yaml`；空表 = 全走缺省 index） */
    expose: ExposeMap;
}

/**
 * **按库**解析档位 —— 这一层曾经写错过，别再合回一张表（##5 第 8 轮的铁证）。
 *
 * 错法：把三库的 `expose.yaml` 合并成一张 subject → 档位 的表，再拿它套所有库。
 * 后果：项目库写了 `expose.yaml`（哪怕只声明一条），**任务库的 4 条结论一起被降级**
 * ——它们从不属于任何 expose 配置，却因为"合并后集合里有人声明了"而被套上了缺省 index。
 * 而 `omitted` 仍是 0（被 index 掉的根本不计入），于是**静默**。省掉的正好是这一轮
 * 最该看的东西（本任务自己的结论），是最坏的一种省。
 *
 * 正确判据：每个库各读各的 `expose.yaml`，各按**自己库类型**的缺省档回落
 * （`task = full` / `project`·`global` = index，见 `DEFAULT_EXPOSE_BY_KIND`）。
 */
function levelOf(loaded: readonly Loaded[], declared: boolean, entry: ProjectEntry): ExposeLevel {
    // 兼容窗口：**谁都没写** `expose.yaml` ⇒ 回落旧行为（全进正文 + 按预算裁）。
    // 一旦任一个库写了（哪怕一条），声明式生效 —— 此时按库解析，未声明的主题走该库缺省档。
    if (!declared) return "full";
    const lib = loaded.find((l) => l.ns.kind === entry.ns.kind && libKey(l.ns) === libKey(entry.ns));
    return exposeOf(lib?.expose ?? {}, entry.fact.subject, defaultExposeOf(entry.ns.kind));
}

const libKey = (ns: Ns): string => (ns.kind === "task" ? `task:${ns.taskUri}` : ns.kind);

/**
 * 读一个库；不存在 / 解析失败 → `null`（**不是**空库，也不是异常）。
 * 调用方据此决定"缺席"而不是"给了个空对象"—— 空对象会被信封渲染成 `facts.task: {}`，
 * 看起来像"任务库存在但没有事实"，与"根本没有库"是两件事。
 */
function loadQuietly(dir: string, ns: Ns, opts: { subjectsFallback?: string; root?: string; allowMissing?: boolean }): Loaded | null {
    if (!existsSync(path.join(dir, "facts"))) return null;
    try {
        return {
            ns,
            expose: readExpose(dir),
            repo: loadRepo(dir, {
                allowMissing: opts.allowMissing === true,
                ...(opts.subjectsFallback === undefined ? {} : { subjectsFallback: opts.subjectsFallback }),
                ...(opts.root === undefined ? {} : { root: opts.root }),
            }),
        };
    } catch {
        // YAML 坏到读不出来：不抛（见纪律 ②）。真问题会在 `diy facts status` 里亮出来。
        return null;
    }
}

/** 仓库库的 `knowledge/`：与 CLI 同一份定位（`DIY_FACTS_DIR` > 向上找），找不到 → null */
function repoDirQuietly(): string | null {
    try {
        return resolveFactsDir(undefined);
    } catch {
        return null;
    }
}

export interface BuildFactsContextOptions {
    /** 数据根（缺省 = `diyHome()`）；显式传是为了测试与 lab 实例 */
    home?: string;
    /** 任务 URI（`projects/4/tasks/404`）；空串 = 不读任务库 */
    taskUri?: string;
    env?: "production" | "development" | "test";
    /** 参与 `scope.paths` 匹配的代码位置（缺省 = 不按路径筛） */
    paths?: readonly string[];
    algorithm?: ProjectionAlgorithm;
    maxBytes?: number;
}

/**
 * 构造 `globals.facts`。
 *
 * @returns `null` = 两面库都不存在 ⇒ **单元缺席**（与接入前逐字不变）。
 */
export function buildFactsContext(opts: BuildFactsContextOptions = {}): FactsContextValue | null {
    const home = opts.home ?? diyHome();
    const env = opts.env ?? readRuntimeConfig().env;
    const algorithm = opts.algorithm ?? "yaml-nested";
    const maxBytes = opts.maxBytes ?? DEFAULT_FACTS_MAX_BYTES;

    const taskUri = opts.taskUri ?? "";
    const repoDir = repoDirQuietly();
    const loaded: Loaded[] = [];

    if (taskUri !== "") {
        const taskKb = path.join(home, taskUri, "knowledge");
        const hit = loadQuietly(taskKb, { kind: "task", taskUri }, {
            ...(repoDir === null ? {} : { subjectsFallback: path.join(repoDir, "subjects.yaml") }),
            ...(repoDir === null ? {} : { root: path.dirname(repoDir) }),
        });
        if (hit) loaded.push(hit);
    }
    // 设备级库排在项目库之前：预算按这个顺序分配，而"用户的硬规则"比"仓库细节"更该保住
    const globalKb = path.join(home, "knowledge");
    const globalHit = loadQuietly(globalKb, { kind: "global" }, {
        ...(repoDir === null ? {} : { subjectsFallback: path.join(repoDir, "subjects.yaml"), root: path.dirname(repoDir) }),
    });
    if (globalHit) loaded.push(globalHit);
    if (repoDir !== null) {
        const hit = loadQuietly(repoDir, { kind: "project" }, {});
        if (hit) loaded.push(hit);
    }
    if (loaded.length === 0) return null;

    const ctx = {
        env,
        ...(opts.paths === undefined ? {} : { paths: opts.paths }),
        ...(taskUri === "" ? {} : { task: taskUri }),
    };

    // 暴露档：只有 `full` 进正文。`index` 在 kb 索引里（知道有、要值就查），`none` 两处都不给。
    // **按库**解析（见 `levelOf` 的注释：合并成一张表会把任务库一起降级）。
    const allEntries: ProjectEntry[] = loaded.flatMap((l) => l.repo.facts.map((fact) => ({ ns: l.ns, fact })));
    const declared = loaded.some((l) => Object.keys(l.expose).length > 0);
    const leveled: LeveledFact[] = allEntries.map((e) => ({ fact: e.fact, level: levelOf(loaded, declared, e) }));
    const levelByFact = new Map(leveled.map((x) => [x.fact, x.level] as const));
    const full = (e: ProjectEntry): boolean => levelByFact.get(e.fact) === "full";
    const budgetProblems = checkExposeLeveled(leveled, { budget: maxBytes }).map((p) => ({
        gid: "facts.expose",
        code: p.code,
    }));

    if (algorithm === "md-list") {
        const entries = allEntries.filter(full);
        const out = project({ entries, ctx, algorithm: "md-list", maxBytes, shape: "auto" });
        return {
            algorithm,
            env,
            text: out.text,
            omitted: out.omitted.length,
            problems: [...out.problems.map((p) => ({ gid: p.gid, code: p.code })), ...budgetProblems],
        };
    }

    // ── structured：一次解析全部库、再按 ns 分桶 ──
    //
    // **必须一次传全部 entries**：`projectItems` 跨库去重（同 claim 取 ns 高层），
    // 每个库各自调一次就退化成"各出一条"—— 实测 16 条同 claim 在两库重复（`level` 6 /
    // `tool` 5 / `ref` 5），4 KB 预算里白占一倍。
    const out: FactsContextValue = { algorithm, env, omitted: 0, problems: [...budgetProblems] };
    const parsed = projectItems({ entries: allEntries.filter(full), ctx });
    out.problems.push(...parsed.problems.map((p) => ({ gid: p.gid, code: p.code })));
    void parsed.skipped; // 当前 scope 下不适用（正常，不是裁掉）

    // 预算按 items 顺序分配：`projectItems` 已按 ns 优先级排序（task > project > global），
    // 故"本任务的结论"先保住
    let remaining = maxBytes;
    for (const item of parsed.items) {
        const key = algorithm === "flat-gid" ? item.gid : item.claim;
        const cell: FactsContextCell = { value: item.value, resolvedBy: item.resolvedBy, variants: item.variants };
        const size = Buffer.byteLength(`${key}: ${JSON.stringify(cell)}\n`, "utf8");
        if (size > remaining) {
            out.omitted += 1;
            continue;
        }
        remaining -= size;
        const kind = item.ns.kind;
        const bucket = kind === "task" ? (out.task ??= {}) : kind === "global" ? (out.global ??= {}) : (out.project ??= {});
        bucket[key] = cell;
    }
    return out;
}

/** 索引的一条：主题 + 一句话 + 条目数（正文**不进**索引） */
export interface KbIndexEntry {
    subject: string;
    desc: string;
    claims: number;
    /**
     * 该主题在**哪些库**（查的时候要带 `--in`，否则落空）。
     * 同一 subject 在项目库与设备库里可以各写各的（局部覆盖全局），故是**数组**；
     * 但**合并成一条**：各出一条会让 agent 以为是两个不同主题、还把 claims 数看错
     * （实测 `tool` 两行，22 + 5，读起来像"库里有 44 条 tool"）。
     */
    ns: ("project" | "global")[];
}

export interface KbIndex {
    entries: KbIndexEntry[];
    /** 全库条目总数（含没进索引的 subject —— 数字对不上时说明有 subject 缺 description） */
    claims: number;
}

/**
 * **知识库索引**（##404：AGENTS.md 的「按需」条目迁进 facts 后，靠它找回）。
 *
 * 为什么只给 subject 不给条目：条目全文是 `yaml-nested` 投影（runtime）的活，而 runtime 那段
 * 有 4 KB 硬预算，实测溢出 120+ 条。索引要的是「**库里有什么**」，字节量与条目数无关 ——
 * 26 个主题约 1.5 KB，迁走 25 KB 只留下这一个量级的常驻成本。
 *
 * 为什么 description 是索引唯一的人读信息：它已经是 subject 词表的必填字段（写词表时就要求
 * 能一句话说清这个对象），索引直接复用它 —— 不新增一份要同步的说明。
 *
 * 读不到库 → `null`（缺席，与 `buildFactsContext` 同一纪律：读失败不炸整轮）。
 */
export function buildKbIndex(opts: { home?: string } = {}): KbIndex | null {
    const home = opts.home ?? diyHome();
    const repoDir = repoDirQuietly();
    const loaded: Loaded[] = [];
    // 设备级库先读（与投影同序：用户的硬规则优先保住）
    const globalHit = loadQuietly(path.join(home, "knowledge"), { kind: "global" }, {});
    if (globalHit) loaded.push(globalHit);
    if (repoDir !== null) {
        const hit = loadQuietly(repoDir, { kind: "project" }, {});
        if (hit) loaded.push(hit);
    }
    if (loaded.length === 0) return null;
    let total = 0;
    // 按 subject 聚：多库同名合并成一条（`ns` 记来源数组、`claims` 求和）
    const merged = new Map<string, KbIndexEntry>();
    for (const l of loaded) {
        const counts = new Map<string, number>();
        for (const f of l.repo.facts) counts.set(f.subject, (counts.get(f.subject) ?? 0) + 1);
        total += l.repo.facts.length;
        const ns = l.ns.kind === "global" ? ("global" as const) : ("project" as const);
        for (const sub of l.repo.subjects) {
            if ((sub.description ?? "") === "") continue;
            // `none` = 连索引都不给（体量太大 / 临时性）：库里有，但 agent 得自己知道去查。
            // **按库**判定（该库自己的 expose.yaml + 该库类型的缺省档）—— 与正文投影同口径。
            // 注意与正文的区别：`index` 与 `full` **都进索引**（full 也要能被发现），只有 `none` 不进。
            if (exposeOf(l.expose, sub.key, defaultExposeOf(ns)) === "none") continue;
            const hit = merged.get(sub.key);
            const claims = counts.get(sub.key) ?? 0;
            if (hit === undefined) {
                merged.set(sub.key, { subject: sub.key, desc: sub.description as string, claims, ns: [ns] });
            } else {
                // desc 取**先到的**那份：loaded 已按 ns 优先级排（global 先读），但项目库的
                // 描述更具体 —— 故项目库那份覆盖（后到者赢，仅当它来自 project）
                if (ns === "project") hit.desc = sub.description as string;
                if (!hit.ns.includes(ns)) hit.ns.push(ns);
                hit.claims += claims;
            }
        }
    }
    const entries = [...merged.values()];
    if (entries.length === 0) return null;
    entries.sort((a, b) => a.subject.localeCompare(b.subject));
    // 按前缀折叠（##5 第 9 轮）：主题数会随迁入线性涨，而索引是每轮固定前缀 ——
    // 41 主题 ≈ 4 KB/轮、全仓所有任务都付。折叠项自带展开方法（`brief app.*`）。
    // 折叠结果转成可变的 ns（zod 那边 output 形状是 `string[]`，两处别各定义一份）
    const folded = foldKbIndex(entries, { minGroup: KB_FOLD_MIN_GROUP }).map((e) => ({ ...e, ns: [...e.ns] }));
    return { entries: folded, claims: total };
}
