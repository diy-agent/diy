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
import { loadRepo, project, projectItems, type ProjectEntry, type ProjectionAlgorithm, type Repo } from "@diy/facts/node";
import type { Ns } from "@diy/facts";
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
}

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

    // ── md 算法：整份渲染成一段 markdown（此时不再给 task/project 两棵树）──
    if (algorithm === "md-list") {
        const entries: ProjectEntry[] = loaded.flatMap((l) => l.repo.facts.map((fact) => ({ ns: l.ns, fact })));
        const out = project({ entries, ctx, algorithm: "md-list", maxBytes, shape: "auto" });
        return {
            algorithm,
            env,
            text: out.text,
            omitted: out.omitted.length,
            problems: out.problems.map((p) => ({ gid: p.gid, code: p.code })),
        };
    }

    // ── structured：按库分组，claim 作 key ──
    const out: FactsContextValue = { algorithm, env, omitted: 0, problems: [] };
    // 预算按"先任务后项目"分配：条目异常多时先保住任务库（本任务的结论最要紧）
    let remaining = maxBytes;
    for (const l of loaded) {
        const entries: ProjectEntry[] = l.repo.facts.map((fact) => ({ ns: l.ns, fact }));
        const { items, skipped, problems } = projectItems({ entries, ctx });
        out.problems.push(...problems.map((p) => ({ gid: p.gid, code: p.code })));
        // `skipped` = 当前 scope 下不适用（正常，不是裁掉），不计入 omitted
        void skipped;
        const cells: Record<string, FactsContextCell> = {};
        for (const item of items) {
            const key = algorithm === "flat-gid" ? item.gid : item.claim;
            const cell: FactsContextCell = {
                value: item.value,
                resolvedBy: item.resolvedBy,
                variants: item.variants,
            };
            const size = Buffer.byteLength(`${key}: ${JSON.stringify(cell)}\n`, "utf8");
            if (size > remaining) {
                out.omitted += 1;
                continue;
            }
            remaining -= size;
            cells[key] = cell;
        }
        if (Object.keys(cells).length === 0) continue;
        if (l.ns.kind === "task") out.task = cells;
        else if (l.ns.kind === "project") out.project = cells;
    }
    return out;
}

/** 索引的一条：主题 + 一句话 + 条目数（正文**不进**索引） */
export interface KbIndexEntry {
    subject: string;
    desc: string;
    claims: number;
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
export function buildKbIndex(): KbIndex | null {
    const repoDir = repoDirQuietly();
    if (repoDir === null) return null;
    const hit = loadQuietly(repoDir, { kind: "project" }, {});
    if (!hit) return null;
    const counts = new Map<string, number>();
    for (const f of hit.repo.facts) counts.set(f.subject, (counts.get(f.subject) ?? 0) + 1);
    const entries = hit.repo.subjects
        .filter((s) => (s.description ?? "") !== "")
        .map((s) => ({ subject: s.key, desc: s.description as string, claims: counts.get(s.key) ?? 0 }))
        .sort((a, b) => a.subject.localeCompare(b.subject));
    if (entries.length === 0) return null;
    return { entries, claims: hit.repo.facts.length };
}
