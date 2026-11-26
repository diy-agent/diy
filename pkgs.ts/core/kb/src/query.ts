// query.ts —— 知识库的**只读投影**（brief / get / find）。
//
// 为什么会有这一层：kb 的原始决定是「只写不查，模型自己 rg」（2026-11-06，依据是
// facts 时代「要模型学一套 API」的 43:1 失败）。但 2026-11 的现场是：68 个 md / 400 KB，
// 每次 rg 都要模型自己拼路径、自己截首句，token 与格式都不稳定。
//
// 所以口径改成：**文件仍是唯一真源**（不建索引、不引入 claim / evidence），但允许一个
// 只读投影 —— brief（目录级首句）/ get（单节正文）/ find（全文检索）。它省的是 token 与
// 格式，不是数据模型；写侧仍然是 `writeEntry / writeIndex / moveEntry`。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { bodyOf, scanKb } from './index.js';

export interface KbSectionRef {
    /** 相对知识库根的路径（`rule/dev.md`） */
    readonly path: string;
    readonly section: string;
    /** 1-based；正文里的行号 */
    readonly line: number;
    readonly body: string;
}

export interface KbBriefItem {
    readonly path: string;
    readonly sections: readonly { readonly section: string; readonly first: string }[];
}

export interface KbFindHit {
    readonly path: string;
    readonly section: string;
    readonly line: number;
    readonly snippet: string;
}

/** 解析正文里的 `## ` 小节（`###` 不算；yaml 头与第一个 `##` 前的内容不在任何小节里） */
export function parseSections(text: string): KbSectionRef[] {
    const lines = text.split('\n');
    const out: KbSectionRef[] = [];
    let current: { section: string; line: number; buffer: string[] } | null = null;
    const flush = (): void => {
        if (current === null) return;
        out.push({ path: '', section: current.section, line: current.line, body: current.buffer.join('\n').trim() });
        current = null;
    };
    for (let index = 0; index < lines.length; index++) {
        const match = /^##\s+(\S.*)$/.exec(lines[index] ?? '');
        if (match !== null) {
            flush();
            current = { section: match[1]!.trim(), line: index + 1, buffer: [] };
            continue;
        }
        if (current !== null) current.buffer.push(lines[index] ?? '');
    }
    flush();
    return out;
}

/** 首句：压平空白，取到第一个句末标点或 maxChars 为止 */
export function firstSentence(body: string, maxChars = 80): string {
    const flat = body.replace(/\s+/g, ' ').trim();
    const end = flat.search(/[。！？；.!?]/);
    const sentence = end >= 0 ? flat.slice(0, end + 1) : flat;
    return sentence.length <= maxChars ? sentence : `${sentence.slice(0, maxChars - 1)}…`;
}

/** 路径必须落在 root 内（拒绝 `..` / 绝对路径越界；知识库只读自己的 md） */
function within(root: string, rel: string): string | null {
    const base = resolve(root);
    const abs = resolve(base, rel);
    if (abs !== base && !abs.startsWith(base + sep)) return null;
    return abs;
}

function withoutMd(path: string): string {
    return path.endsWith('.md') ? path.slice(0, -3) : path;
}

/** 把 subject 展开成若干条目的相对路径（`rule` = 整个目录；`rule/dev` = 单文件；`app*` = 前缀） */
export function pathsOf(root: string, subject: string): string[] {
    const entries = scanKb(root).entries.map((entry) => entry.path);
    const raw = subject.trim().replace(/^\.\//, '');
    if (raw === '') return [];

    if (raw.includes('*')) {
        const prefix = withoutMd(raw.replace(/\*+$/, '')).replace(/\.$/, '');
        return entries.filter((path) => withoutMd(path).startsWith(prefix)).sort();
    }

    const norm = withoutMd(raw).replace(/\/+$/, '');
    const dir = within(root, norm);
    if (dir !== null && existsSync(dir) && statSync(dir).isDirectory()) {
        const prefix = `${norm}/`;
        return entries.filter((path) => path.startsWith(prefix)).sort();
    }
    const file = withoutMd(norm);
    return entries.filter((path) => withoutMd(path) === file).sort();
}

/** `brief`：列主题（目录 / 文件 / 前缀）下每条知识的全部小节 + 首句 */
export function briefOf(root: string, subject: string, maxChars = 80): KbBriefItem[] {
    const out: KbBriefItem[] = [];
    for (const path of pathsOf(root, subject)) {
        const abs = within(root, path);
        if (abs === null) continue;
        let text: string;
        try {
            text = readFileSync(abs, 'utf-8');
        } catch {
            continue;
        }
        out.push({
            path,
            sections: parseSections(text).map((section) => ({
                section: section.section,
                first: firstSentence(section.body, maxChars),
            })),
        });
    }
    return out;
}

/** `get`：`<路径>#<小节>` 取正文；不带 `#` 就整篇正文（去掉 yaml 头） */
export function getSection(root: string, ref: string): { path: string; section: string | null; body: string } | null {
    const hash = ref.lastIndexOf('#');
    const pathPart = hash >= 0 ? ref.slice(0, hash) : ref;
    const sectionPart = hash >= 0 ? ref.slice(hash + 1).trim() : '';
    const norm = withoutMd(pathPart.trim().replace(/^\.\//, ''));
    if (norm === '') return null;
    const abs = within(root, `${norm}.md`);
    if (abs === null || !existsSync(abs)) return null;
    let text: string;
    try {
        text = readFileSync(abs, 'utf-8');
    } catch {
        return null;
    }
    const path = `${norm}.md`;
    if (sectionPart === '') return { path, section: null, body: bodyOf(text).trim() };
    const sections = parseSections(text);
    const hit =
        sections.find((section) => section.section === sectionPart) ??
        sections.find((section) => section.section.toLowerCase() === sectionPart.toLowerCase());
    if (hit === undefined) return null;
    return { path, section: hit.section, body: hit.body };
}

/** `find`：全文检索（多个关键词 = 全都要命中，大小写不敏感）；命中按路径 + 行号排序 */
export function findIn(root: string, keywords: readonly string[], limit = 50): KbFindHit[] {
    const words = keywords.map((word) => word.trim()).filter((word) => word !== '');
    if (words.length === 0) return [];
    const lowered = words.map((word) => word.toLowerCase());
    const hits: KbFindHit[] = [];
    for (const path of scanKb(root)
        .entries.map((entry) => entry.path)
        .sort()) {
        const abs = within(root, path);
        if (abs === null) continue;
        let text: string;
        try {
            text = readFileSync(abs, 'utf-8');
        } catch {
            continue;
        }
        for (const section of parseSections(text)) {
            const haystack = `${section.section}\n${section.body}`.toLowerCase();
            if (!lowered.every((word) => haystack.includes(word))) continue;
            const lines = section.body.split('\n');
            const matched = lines.findIndex((line) => lowered.every((word) => line.toLowerCase().includes(word)));
            const snippet = (matched >= 0 ? lines[matched]! : section.section).replace(/\s+/g, ' ').trim();
            hits.push({
                path,
                section: section.section,
                line: section.line + (matched >= 0 ? matched + 1 : 0),
                snippet: snippet.length <= 160 ? snippet : `${snippet.slice(0, 159)}…`,
            });
            if (hits.length >= limit) return hits;
        }
    }
    return hits;
}

/**
 * 设备级知识库根：`<设备根>/knowledge`，缺省 `<设备根>` = `~/.diy2`。
 *
 * 为什么不读 `DIY_HOME`（2026-11-26 裁）：`DIY_HOME` 在 diy2 里表示**实例数据根**
 * （生产 `~/.diy2`，lab 是 `run/diy2/lab`），在 diy-app 时代却表示「设备数据根」。
 * 两语义一撞，设备库就被算成「实例根下的 knowledge」：生产实测算成
 * `~/.diy/diy2/knowledge`（不存在）→ 所有 bot 的上下文里一条设备条目都没有。
 * 现在设备根是**显式参数**：由宿主注入（生产 = home 本身，lab 指生产根），
 * 缺省 `~/.diy2` 兜住「宿主没给」的场合。
 */
export function deviceKbRoot(home: string | undefined, homedir: string): string {
    const base = home !== undefined && home.trim() !== '' ? home.trim() : join(homedir, '.diy2');
    return join(base, 'knowledge');
}
