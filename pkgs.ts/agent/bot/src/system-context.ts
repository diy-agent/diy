// system-context.ts — bot 的**简化版**系统上下文组装器（##516）
//
// 为什么不复用 diy-app 的那套：真正的组装器在 `apps/diy-app/src/main/services/`
// （prompt-registry 的 AGENTS.md 链 + facts-context 的投影），依赖 Electron / 任务 /
// 房间 / 模版引擎 —— bot 用不了，也不该被拖进去。`@diy-agent/context` 只是**信封格式**
// （渲染 / 解析 prompt 里的上下文块），同样不是组装器。
//
// 这里只做两件事，且都**只读**：
//   ① AGENTS.md 链 —— `$DIY_HOME/AGENTS.md` → `$HOME` 逐层 → 工作目录逐层（外 → 内）
//   ② facts 摘要 —— 主题清单 + 每主题条数（**不塞正文**，那会爆窗口）
//
// 三条硬约束（##516 body）：
//   · 只在**新建会话**时调用一次（`chat.ts` 里与 instructions 同一时机）—— 每轮重写会打碎前缀缓存
//   · 有长度上限（缺省 8 KB），超了按优先级截断并**标注**
//   · 组装失败**不抛**（降级为缺席）—— 上下文构造失败 = 人发不出消息

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { claimOf, foldKbIndex, KB_FOLD_MIN_GROUP } from "@diy-agent/facts";
import { loadRepo } from "@diy-agent/facts/node";

/** 系统上下文的缺省字节上限（UTF-8）—— 与 diy-app 的 system 预算同量级 */
export const SYSTEM_CONTEXT_MAX_BYTES = 8192;

/** AGENTS.md 链上的一层（外层在前） */
export interface AgentsFileRef {
    /** 文件绝对路径 */
    readonly path: string;
    /** 生效目录（文件所在目录） */
    readonly scope: string;
    readonly content: string;
}

export interface SystemContextOptions {
    /** 数据根（`$DIY_HOME`）：它的 `AGENTS.md` 是应用级规范 */
    readonly home: string;
    /** 工作目录（bot 的 workspace）；缺省 = `$DIY_HOME` */
    readonly cwd?: string;
    /** 字节上限；缺省 {@link SYSTEM_CONTEXT_MAX_BYTES} */
    readonly maxBytes?: number;
}

export interface SystemContextResult {
    /** 直接塞进 system 的正文（空串 = 什么都没读到） */
    readonly text: string;
    /** 正文的 UTF-8 字节数 */
    readonly bytes: number;
    /** 链上实际读到的文件（外层在前） */
    readonly chain: readonly AgentsFileRef[];
    /** 被预算截掉的部分（人可读；空数组 = 没截） */
    readonly omitted: readonly string[];
}

const EMPTY: SystemContextResult = { text: "", bytes: 0, chain: [], omitted: [] };

/**
 * AGENTS.md 链：从工作目录逐层向上到 `$HOME`，外层在前；再加 `$DIY_HOME/AGENTS.md`。
 *
 * 与 diy-app（`prompt-registry.ts` 的 `chainOf`）同口径的三条：
 *   · 上界 = `$HOME`（不进 `/`、不进 `/Users`）：`~/AGENTS.md`、`~/git/AGENTS.md` 是全局规则
 *   · 工作目录不在 `$HOME` 内时只取该目录自身一层（别把「进程恰好启动在哪」当成规范）
 *   · 应用级 `$DIY_HOME/AGENTS.md` 恒在链首（去重）
 *
 * 与 diy-app 的差异：不排除任务正文（bot 没有任务概念）。
 */
export function agentsChainOf(options: { home: string; cwd?: string }): AgentsFileRef[] {
    const start = resolve(options.cwd ?? options.home);
    const userHome = homedir();
    const underHome = start === userHome || start.startsWith(userHome + sep);
    const stop = underHome ? userHome : start;

    const seen = new Set<string>();
    const files: string[] = [];
    for (let dir = start; ; dir = dirname(dir)) {
        const file = join(dir, "AGENTS.md");
        if (!seen.has(file) && existsSync(file)) {
            seen.add(file);
            files.push(file);
        }
        if (dir === stop || dir === dirname(dir)) break;
    }
    files.reverse(); // 外层在前
    const appLevel = join(options.home, "AGENTS.md");
    if (!seen.has(appLevel) && existsSync(appLevel)) files.unshift(appLevel);

    const out: AgentsFileRef[] = [];
    for (const file of files) {
        const content = readText(file);
        if (content !== "") out.push({ path: file, scope: dirname(file), content });
    }
    return out;
}

function readText(file: string): string {
    try {
        return readFileSync(file, "utf-8").trim();
    } catch {
        return "";
    }
}

/**
 * facts 摘要：`主题 → 条数`（按 claim 去重），按前缀折叠 —— 口径与 `diy facts` 的 kb 索引一致。
 *
 * 读哪些库：
 *   · 设备级 `$DIY_HOME/knowledge`（跨项目共用的用户规则；生产实例里它本身就是 `~/.diy/knowledge`）
 *   · 仓库级 —— 从工作目录往上找第一个 `knowledge/facts/`（bot 的 workspace 通常不在仓里 ⇒ 没有）
 *
 * 为什么只给主题 + 条数：正文动辄几百 KB。索引是给「知道该查什么」用的，
 * 发现成本由 `diy facts brief <主题>` 按需付一次。
 */
export function factsSummaryOf(options: { home: string; cwd?: string }): string {
    const dirs = knowledgeDirsOf(options);
    if (dirs.length === 0) return "";

    /** `subject` → 该主题下 claim 的集合（跨库去重；同一 claim 的 env 变体只算一条） */
    const claimsBySubject = new Map<string, Set<string>>();
    /** `subject` → 描述（后到的 project 覆盖 global） */
    const descOf = new Map<string, string>();
    const nsOf = new Map<string, Set<"project" | "global">>();

    for (const { dir, kind } of dirs) {
        let repo;
        try {
            repo = loadRepo(dir, { kind });
        } catch {
            continue; // 库坏了就跳过这一份，别把整段上下文拖垮
        }
        const ns = kind === "global" ? ("global" as const) : ("project" as const);
        for (const fact of repo.facts) {
            const set = claimsBySubject.get(fact.subject) ?? new Set<string>();
            set.add(claimOf(fact));
            claimsBySubject.set(fact.subject, set);
        }
        for (const subject of repo.subjects) {
            const desc = (subject.description ?? "").trim();
            if (desc === "") continue; // 没描述的 subject 不进索引（与 diy-app 同口径）
            if (ns === "project" || !descOf.has(subject.key)) descOf.set(subject.key, desc);
            const nsSet = nsOf.get(subject.key) ?? new Set<"project" | "global">();
            nsSet.add(ns);
            nsOf.set(subject.key, nsSet);
        }
    }

    const entries = [...descOf.entries()].map(([subject, desc]) => ({
        subject,
        desc,
        claims: claimsBySubject.get(subject)?.size ?? 0,
        ns: [...(nsOf.get(subject) ?? [])],
    }));
    if (entries.length === 0) return "";
    entries.sort((a, b) => a.subject.localeCompare(b.subject));
    const total = new Set([...claimsBySubject.values()].flatMap((set) => [...set])).size;

    const folded = foldKbIndex(entries, { minGroup: KB_FOLD_MIN_GROUP });
    const lines = folded.map((entry) => `- ${entry.subject} — ${entry.desc}`);
    return [`知识库索引（${String(total)} 条 / ${String(entries.length)} 个主题；正文按需 diy facts brief <主题>）`, ...lines].join(
        "\n",
    );
}

/** 该读哪些 `knowledge/` 目录（设备级在前，仓库级在后：同名 subject 由后到的 project 描述覆盖） */
function knowledgeDirsOf(options: { home: string; cwd?: string }): Array<{ dir: string; kind: "global" | "project" }> {
    const out: Array<{ dir: string; kind: "global" | "project" }> = [];
    const globalDir = join(options.home, "knowledge");
    if (existsSync(join(globalDir, "facts"))) out.push({ dir: globalDir, kind: "global" });
    const repo = repoKnowledgeOf(resolve(options.cwd ?? options.home));
    if (repo !== null && !out.some((item) => item.dir === repo)) out.push({ dir: repo, kind: "project" });
    return out;
}

/** 从工作目录往上找第一个 `knowledge/facts/`（不越过 `$HOME`） */
function repoKnowledgeOf(start: string): string | null {
    const userHome = homedir();
    const limit = start.startsWith(userHome + sep) || start === userHome ? userHome : start;
    for (let dir = start; ; dir = dirname(dir)) {
        const candidate = join(dir, "knowledge");
        if (existsSync(join(candidate, "facts"))) return candidate;
        if (dir === limit || dir === dirname(dir)) return null;
    }
}

/**
 * 组装系统上下文（**永不抛**）。
 *
 * 顺序即优先级：AGENTS.md 链（外层 → 内层）在前，facts 摘要垫底。
 * 超预算时从**尾部**砍（内层规则 > 索引），并在末尾标注砍掉了什么 ——
 * 静默截断等于让人以为「规则只有这些」。
 */
export function buildSystemContext(options: SystemContextOptions): SystemContextResult {
    try {
        const budget = options.maxBytes ?? SYSTEM_CONTEXT_MAX_BYTES;
        const chain = agentsChainOf(options);
        const facts = factsSummaryOf(options);

        const parts: Array<{ label: string; text: string }> = chain.map((file) => ({
            label: file.path,
            text: `<!-- AGENTS.md: ${file.path}（作用域 ${file.scope}） -->\n${file.content}`,
        }));
        if (facts !== "") parts.push({ label: "知识库索引", text: facts });

        const kept: string[] = [];
        const omitted: string[] = [];
        let used = 0;
        for (let i = 0; i < parts.length; i += 1) {
            const part = parts[i]!;
            const cost = Buffer.byteLength(part.text, "utf-8") + 2; // +2 = 段间空行
            if (used + cost <= budget) {
                kept.push(part.text);
                used += cost;
                continue;
            }
            // 装不下就从这里开始整段放弃：靠后的段优先级更低，
            // 「跳过大的、塞进后面小的」会打乱优先级顺序（外层规则 > 内层 > 索引）。
            omitted.push(...parts.slice(i).map((rest) => rest.label));
            break;
        }
        if (omitted.length > 0) {
            // 截断必须**可见**：静默截断会让人以为「规则只有这些」
            kept.push(
                `<!-- 系统上下文超过上限 ${String(budget)} 字节：已省略 ${String(omitted.length)} 段（${omitted.join("、")}） -->`,
            );
        }
        const text = kept.join("\n\n");
        return { text, bytes: Buffer.byteLength(text, "utf-8"), chain, omitted };
    } catch {
        // 组装失败 = 降级为缺席：上下文构造失败不该让人发不出消息
        return EMPTY;
    }
}
