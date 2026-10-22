/**
 * docs-index.ts — 把**仓库文档树**投影成上下文变量树的一个单元（##5 第 11 轮 B）
 *
 * 为什么要有：`docs/` 是设计的活真源（实例三态、事件协议、写契约…），但它**不在任何
 * AGENTS.md 链上** —— agent 不知道有哪些文档、哪篇还活着。而"全量注入"绝无可能
 * （18 篇 100+ KB），"迁进 facts" 也不该是唯一出路（设计稿的**正文**要按需读，索引才有意义）。
 * 故本单元只给**一行一篇**的索引：路径 + 标题 + 字节 + 状态词 + 两个日期。
 *
 * 三条纪律（与 facts-context 同）：
 *   ① 没有文档 ⇒ 整节**缺席**（`null`），不是空对象 —— 空对象会被渲染成 `docs: {}`，
 *      看起来像"有文档目录但一篇都没有"。
 *   ② 读失败不许炸整轮（枚举目录 / 调 git 都可能失败）：坏一篇不许让整节消失。
 *   ③ 此处只出**结构化值**，不拼给人看的句子（行格式由渲染层 / 页面决定）。
 *
 * 两个日期都要给（`docDate` = 自述日期、`touched` = git 最后改动日）：实测 8 篇计划的 git
 * 日期全是同一天（一次全局重排把所有文件刷了），而它们自述是 7-10 / 7-11 —— **不一致本身
 * 就是信号**（"文档说 7-10，实际 7-19 改过"）。只信 git 会得出"8 篇同一天写的"这种假结论。
 *
 * `status` 是**启发式**：只认开篇引用行里以「状态 / 结论 / 核心结论 / 实现状态」开头的那句。
 * 抽不到就留空 —— **不许编**（编出来的状态比没有更坏，人会信）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { DocsEntry, DocsIndex, DocsSummary } from "../../shared/docs";

/** 缺省只扫 `docs/plans`（设计稿正区）。全 `docs/` 实测 ~2 KB，占预算且含已完成的手册类文档 */
export const DEFAULT_DOCS_ROOTS: readonly string[] = ["docs/plans"];

/** 单篇标题 / 状态词的长度上限（索引是"知道有这篇"，不是"读完它"） */
const TITLE_MAX = 26;
const STATUS_MAX = 20;
/** 状态词只在开篇这么多行里找（引用块 = 摘要区，写在正文深处的不是"这篇的现状"） */
const STATUS_SCAN_LINES = 14;

export type { DocsEntry, DocsIndex, DocsSummary } from "../../shared/docs";

export interface BuildDocsIndexOptions {
    /** 仓库根（绝对路径） */
    root: string;
    /** 覆盖扫描根（仓库相对；缺省 `DEFAULT_DOCS_ROOTS`） */
    roots?: readonly string[];
    /** 上限（防某个仓库把 docs 塞成几千篇，撑爆前缀）；超了按路径序截断 */
    maxEntries?: number;
}

export const DEFAULT_DOCS_MAX_ENTRIES = 60;

/** 构造 `docs` 单元。没有文档 / 根不存在 → `null`（整节缺席） */
export function buildDocsIndex(opts: BuildDocsIndexOptions): DocsIndex | null {
    const roots = opts.roots ?? DEFAULT_DOCS_ROOTS;
    const root = path.resolve(opts.root);
    const files: string[] = [];
    for (const rel of roots) {
        collect(root, rel, files);
    }
    if (files.length === 0) return null;
    const uniq = [...new Set(files)].sort();
    const cap = opts.maxEntries ?? DEFAULT_DOCS_MAX_ENTRIES;
    const kept = uniq.slice(0, cap);
    const touched = gitTouched(root, roots);
    const entries: DocsEntry[] = [];
    for (const rel of kept) {
        const entry = describeOne(root, rel, touched.get(rel));
        if (entry) entries.push(entry);
    }
    if (entries.length === 0) return null;
    return { roots: [...roots], entries };
}

/** 递归收集 `<root>/<rel>/**\/*.md`（缺目录 = 空，不报错） */
function collect(root: string, rel: string, out: string[]): void {
    const abs = path.join(root, rel);
    let names: string[];
    try {
        names = readdirSync(abs);
    } catch {
        return; // 目录不存在 / 不可读：这一根没有就当没有
    }
    for (const name of names) {
        if (name.startsWith(".") || name === "node_modules") continue;
        const childRel = path.posix.join(rel.split(path.sep).join("/"), name);
        const childAbs = path.join(abs, name);
        let st;
        try {
            st = statSync(childAbs);
        } catch {
            continue;
        }
        if (st.isDirectory()) collect(root, childRel, out);
        else if (st.isFile() && name.toLowerCase().endsWith(".md")) out.push(childRel);
    }
}

/**
 * 每篇的 git 最后改动日：**一次** `git log --name-only` 拿全量（每篇一次 spawn 实测 277 ms，
 * 而这段代码每轮请求都会跑 —— 18 次 spawn 是白付的前缀成本）。
 * git log 新→旧，故**首次出现**即最新，直接取。
 */
function gitTouched(root: string, roots: readonly string[]): Map<string, string> {
    const map = new Map<string, string>();
    let out: string;
    try {
        out = execFileSync("git", ["log", "--format=@%cs", "--name-only", "--", ...roots], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            maxBuffer: 16 * 1024 * 1024,
        });
    } catch {
        return map; // 非 git 仓库 / 没装 git：日期就是缺省，不许影响索引本身
    }
    let cur = "";
    for (const line of out.split("\n")) {
        const t = line.trim();
        if (t === "") continue;
        if (t.startsWith("@")) {
            cur = t.slice(1);
            continue;
        }
        if (cur !== "" && !map.has(t)) map.set(t, cur.slice(2)); // `2026-07-19` → `26-07-19`
    }
    return map;
}

function describeOne(root: string, rel: string, touched?: string): DocsEntry | null {
    let text: string;
    let size: number;
    try {
        text = readFileSync(path.join(root, rel), "utf8");
        size = Buffer.byteLength(text, "utf8");
    } catch {
        return null;
    }
    const head = /^#\s+(.+)$/m.exec(text);
    // 标题尾部的日期括注是**元数据**（已单列 docDate），留在标题里只是噪声
    const rawTitle = head ? head[1].trim().replace(/[（(]\d{4}-\d{2}-\d{2}[^）)]*[）)]\s*$/, "") : "(无 H1)";
    const title = clip(rawTitle, TITLE_MAX);
    const d = /(\d{4})-(\d{2})-(\d{2})/.exec(rawTitle) ?? /(\d{4})-(\d{2})-(\d{2})/.exec(rel);
    const entry: DocsEntry = { path: rel, title, size: Math.round(size / 1024) || 0 };
    if (d) entry.docDate = `${d[1].slice(2)}-${d[2]}-${d[3]}`;
    if (touched !== undefined) entry.touched = touched;
    const status = statusOf(text);
    if (status !== "") entry.status = status;
    return entry;
}

/** 开篇引用块里的「状态：…」那一句（启发式，抽不到返回空串） */
function statusOf(text: string): string {
    const lines = text.split("\n").slice(1, STATUS_SCAN_LINES);
    for (const line of lines) {
        if (!line.startsWith(">")) continue;
        const body = line.replace(/^>\s*/, "").trim().replace(/^[*_\s]+|[*_\s]+$/g, "");
        if (!/^(状态|结论|核心结论|实现状态|当前状态)\s*[:：]/.test(body)) continue;
        return clip(body.replace(/\s*[|｜].*$/, ""), STATUS_MAX);
    }
    return "";
}

function clip(s: string, max: number): string {
    const arr = [...s];
    return arr.length <= max ? s : `${arr.slice(0, max).join("")}…`;
}

/**
 * 索引 → 变量树里的**摘要**（每轮上下文只给这一小块，见 shared/docs.ts 头注）。
 * `null`（没有文档）→ `null`：整节缺席，不留空对象。
 */
export function summarizeDocsIndex(index: DocsIndex | null): DocsSummary | null {
    if (index === null || index.entries.length === 0) return null;
    const days = index.entries.map((e) => e.touched).filter((d): d is string => typeof d === "string");
    const summary: DocsSummary = { roots: index.roots, count: index.entries.length };
    if (days.length > 0) summary.newest = days.sort().at(-1)!;
    return summary;
}
