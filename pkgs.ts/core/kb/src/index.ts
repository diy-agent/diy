// kb —— 知识库目录（多级 markdown + yaml 头，**文件名即索引**）。
//
// ── 为什么是文件（2026-11-06 用户拍板，有实测数据）──
//   218 个任务的完整 llm.jsonl：facts 写入 861 条 claims / 读取只有 20 次（43:1），
//   218 个里只有 3 个任务用过。根因**不是投递方式**，而是「要求模型主动查」这个前提不成立 ——
//   AGENTS.md 天天生效是因为它**不需要模型做任何动作**。
//   所以：知识变成模型天然会用的形态（文件，`rg` 是肌肉记忆），而不是一套要学的 API。
//
// ── 三条铁律（用户定死，别自由发挥）──
//   ① 多级目录，**根目录不许散文件**（只有 INDEX.md）；中文目录名 / 文件名欢迎
//   ② 元数据只留 `desc` + `updated`；`subject` / `id` / `review` / `lifecycle` /
//      `source` / `evidence` / `scope` / `supersedes` / `verifiedAt` 全部不要
//   ③ 本包只做**写 + 整理**（write / check / index / move），**不提供查询** —— 模型自己 `rg`
//
// ── 与 docs 的判据 ──
//   docs/           「为什么这么设计」—— 改代码**不一定**要改它
//   .diy/knowledge/ 「现在是什么」   —— 改代码**就该**改它
//   可执行判据：这条知识在代码改动后**会变**吗？会 → knowledge

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** 索引文件的名字（根目录唯一允许的散文件） */
export const INDEX_NAME = 'INDEX.md';

/** 一条知识（扫描结果） */
export interface KbEntry {
    /** 相对 root 的路径（`rules/通用硬约束.md`） */
    readonly path: string;
    /** yaml 头的 desc */
    readonly desc: string;
    /** yaml 头的 updated（`YYYY-MM-DD`；缺失 = 空串） */
    readonly updated: string;
    /** 正文里 `##` 小节数（INDEX 上显示「N 节」） */
    readonly sections: number;
    /** 正文字节数 */
    readonly bytes: number;
}

/** 校验问题（`check` 的产出） */
export interface KbProblem {
    /** 相对路径；空串 = 根目录层面的问题 */
    readonly path: string;
    /** 机器码 */
    readonly code: string;
    /** 给人看的一句话 */
    readonly message: string;
}

export interface KbScanResult {
    readonly root: string;
    readonly entries: readonly KbEntry[];
    readonly problems: readonly KbProblem[];
}

/**
 * 读 yaml 头（`---` 之间的 `key: value`）。
 *
 * 与 `@diy-agent/skills` 的 `readFrontmatter` 同一套判据（那边只取 name/description，
 * 这边只取 desc/updated）；不引 yaml 库的理由也一样 —— 只要两个扁平字符串字段，
 * 但要精确处理 `>-`（折叠）与 `|`（字面）两种常见写法。
 */
export function readFrontmatter(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!text.startsWith('---')) return out;
    const end = text.indexOf('\n---', 3);
    if (end < 0) return out;
    const lines = text.slice(3, end).split('\n');

    let key: string | null = null;
    let block: string[] = [];
    const flush = (): void => {
        if (key === null) return;
        out[key] = block.map((l) => l.trim()).filter((l) => l !== '').join(' ');
        key = null;
        block = [];
    };

    for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (line.trim() === '') continue;
        if (/^\s+\S/.test(line)) {
            if (key !== null) block.push(line);
            continue;
        }
        flush();
        const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
        if (m === null) continue;
        const [, k, v] = m;
        key = k!;
        const value = (v ?? '').trim();
        if (value === '>' || value === '>-' || value === '|' || value === '|-') {
            block = [];
        } else {
            out[key] = value.replace(/^["']|["']$/g, '');
            key = null;
        }
    }
    flush();
    return out;
}

/** 正文（yaml 头之后的部分） */
export function bodyOf(text: string): string {
    if (!text.startsWith('---')) return text;
    const end = text.indexOf('\n---', 3);
    if (end < 0) return text;
    return text.slice(end + 4).replace(/^\n+/, '');
}

/** 正文里 `## ` 开头的行数（不算 `###`） */
export function sectionsOf(body: string): number {
    let n = 0;
    for (const line of body.split('\n')) {
        if (/^##\s+\S/.test(line)) n += 1;
    }
    return n;
}

/**
 * 递归扫 `*.md`（跳过 INDEX.md 与 `.` 开头的目录）。
 *
 * 不跟 symlink 目录：知识库是**这个仓库自己的**，跟出去会收到别人家的东西。
 */
function walk(root: string, dir: string, out: string[]): void {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return;
    }
    for (const name of names.sort()) {
        if (name.startsWith('.')) continue;
        const full = join(dir, name);
        let st;
        try {
            st = statSync(full);
        } catch {
            continue;
        }
        if (st.isDirectory()) {
            walk(root, full, out);
        } else if (st.isFile() && name.endsWith('.md') && !(dir === root && name === INDEX_NAME)) {
            out.push(full);
        }
    }
}

/**
 * 扫描一个知识库根：收集全部条目 + 报出问题。
 *
 * 问题只有四类（都不阻断扫描，`check` 用来报、`index` 用来跳过）：
 *   · `kb/no-frontmatter`  没有 yaml 头
 *   · `kb/no-desc`         desc 缺失或为空
 *   · `kb/root-file`       根目录散文件（必须放进子目录）
 *   · `kb/empty-body`      只有头没有正文
 */
export function scanKb(root: string): KbScanResult {
    const abs = resolve(root);
    const entries: KbEntry[] = [];
    const problems: KbProblem[] = [];
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        return { root: abs, entries, problems };
    }

    // 根目录散文件：单独报（walk 会扫到，但问题更早报）
    for (const name of readdirSync(abs)) {
        const full = join(abs, name);
        if (name.startsWith('.') || name === INDEX_NAME) continue;
        try {
            if (statSync(full).isFile() && name.endsWith('.md')) {
                problems.push({
                    path: name,
                    code: 'kb/root-file',
                    message: '根目录不许放知识文件（必须放进子目录；中文目录名欢迎）',
                });
            }
        } catch {
            /* 读不到 = 忽略 */
        }
    }

    const files: string[] = [];
    walk(abs, abs, files);
    // 根目录散文件已在上面报过 kb/root-file —— 这里**必须滤掉**，
    // 否则它既报错又进 INDEX（`writeIndex` 断言「条目数 = 子目录里的文件数」就挂了）
    const inSubdir = files.filter((f) => dirname(f) !== abs);
    for (const file of inSubdir) {
        const rel = relative(abs, file).split(sep).join('/');
        const text = readFileSync(file, 'utf-8');
        const meta = readFrontmatter(text);
        const body = bodyOf(text);
        if (Object.keys(meta).length === 0) {
            problems.push({ path: rel, code: 'kb/no-frontmatter', message: '缺 yaml 头（`---` 之间至少要 desc）' });
            continue;
        }
        const desc = (meta['desc'] ?? '').trim();
        if (desc === '') {
            problems.push({ path: rel, code: 'kb/no-desc', message: 'yaml 头缺 `desc`（INDEX 上靠它说明这是什么）' });
            continue;
        }
        if (body.trim() === '') {
            problems.push({ path: rel, code: 'kb/empty-body', message: '只有 yaml 头，没有正文' });
            continue;
        }
        entries.push({
            path: rel,
            desc,
            updated: (meta['updated'] ?? '').trim(),
            sections: sectionsOf(body),
            bytes: Buffer.byteLength(body),
        });
    }
    return { root: abs, entries, problems };
}

/**
 * 生成 INDEX.md 的内容（纯函数，方便测）。
 *
 * 按目录分组、组内按文件名排序；目录按名字排序。**组标题就是目录名**，
 * 不再另设「条目名」字段 —— 路径即标识。
 */
export function renderIndex(entries: readonly KbEntry[], rootLabel = ''): string {
    const lines: string[] = [];
    lines.push('# 知识索引');
    lines.push('');
    lines.push('> 自动生成（`diy kb index`），**勿手改**。一行一条，点开就是正文。');
    if (rootLabel !== '') {
        lines.push('>');
        lines.push(`> ${rootLabel}`);
    }
    lines.push('');

    const byDir = new Map<string, KbEntry[]>();
    for (const e of entries) {
        const dir = dirname(e.path) === '.' ? '' : `${dirname(e.path)}/`;
        const bucket = byDir.get(dir);
        if (bucket === undefined) byDir.set(dir, [e]);
        else bucket.push(e);
    }
    // 最深的一层放最后不直观；按路径排序更自然（`app/` 在 `rules/` 前，根目录组在最前）
    const dirs = [...byDir.keys()].sort();
    for (const dir of dirs) {
        lines.push(dir === '' ? '## （根目录）' : `## ${dir}`);
        lines.push('');
        for (const e of [...byDir.get(dir)!].sort((a, b) => a.path.localeCompare(b.path))) {
            const name = e.path.slice(dir.length);
            const meta: string[] = [`${e.sections} 节`];
            if (e.updated !== '') meta.push(e.updated);
            lines.push(`- \`${name}\` — ${e.desc}（${meta.join(' · ')}）`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

/**
 * 写一条知识（覆盖）。
 *
 * **路径校验在这里**：根目录散文件一律拒绝 —— 这是「多级目录」那条铁律唯一的强制点，
 * 放到 `check` 里只能事后报，写的时候就挡住才不会让人先写错再被骂。
 */
export function writeEntry(root: string, relPath: string, content: string): { path: string; bytes: number } {
    const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (norm === '' || norm.includes('..')) {
        throw new Error(`kb: 非法路径 "${relPath}"`);
    }
    if (!norm.endsWith('.md')) {
        throw new Error(`kb: 路径必须以 .md 结尾（拿到的是 "${relPath}"）`);
    }
    if (norm === INDEX_NAME) {
        throw new Error(`kb: INDEX.md 由工具生成，不要手写（用 \`diy kb index\`）`);
    }
    if (!norm.includes('/')) {
        throw new Error(
            `kb: 根目录不许放知识文件（"${norm}"）—— 放进子目录，例如 \`rules/${norm}\`、\`app/${norm}\``,
        );
    }
    const rootAbs = resolve(root);
    const abs = join(rootAbs, norm);
    if (!abs.startsWith(rootAbs + sep)) {
        throw new Error(`kb: 路径越界（"${relPath}"）`);
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
    return { path: abs, bytes: Buffer.byteLength(content) };
}

/**
 * 重新生成 `root/INDEX.md`。
 *
 * 有问题的条目**不进 INDEX**（宁可少一条，也不让索引里出现没有说明的行）。
 */
export function writeIndex(root: string, rootLabel = ''): { entries: number; problems: readonly KbProblem[]; path: string } {
    const scan = scanKb(root);
    const abs = join(resolve(root), INDEX_NAME);
    // label 为空的调用（`write` / `move` 写完自动刷索引）不能把原有的抬头冲掉 ——
    // 抬头是**人写的**（`diy kb index --label "项目 diy"`），自动刷新只该改条目部分。
    const label = rootLabel !== '' ? rootLabel : existingLabelOf(abs);
    const text = renderIndex(scan.entries, label);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${text}\n`, 'utf-8');
    return { entries: scan.entries.length, problems: scan.problems, path: abs };
}

/** 读旧 INDEX 里 `> ` 那一行（自动刷新时沿用，不覆盖人写的抬头） */
function existingLabelOf(abs: string): string {
    if (!existsSync(abs)) return '';
    try {
        const lines = readFileSync(abs, 'utf-8').split('\n');
        // 抬头在第 5~7 行（`# 知识索引` / 空 / `> 自动生成…` / `>` / `> <label>`）
        for (const line of lines.slice(0, 12)) {
            const m = /^>\s+(?!自动生成)(.+)$/.exec(line);
            if (m !== null) {
                const v = m[1]!.trim();
                if (v !== '' && v !== '>') return v;
            }
        }
    } catch {
        /* 读不到 = 没有抬头 */
    }
    return '';
}

/** 移动 / 改名（`to` 同样走写路径校验）。 */
export function moveEntry(root: string, from: string, to: string): { from: string; to: string } {
    const normFrom = from.replace(/\\/g, '/').replace(/^\/+/, '');
    if (normFrom === '' || normFrom.includes('..') || !normFrom.endsWith('.md')) {
        throw new Error(`kb: 非法源路径 "${from}"`);
    }
    if (normFrom === INDEX_NAME) {
        throw new Error('kb: INDEX.md 由工具生成，不要移动');
    }
    const rootAbs = resolve(root);
    const absFrom = join(rootAbs, normFrom);
    if (!absFrom.startsWith(rootAbs + sep) || !existsSync(absFrom)) {
        throw new Error(`kb: 源文件不存在或越界（"${from}"）`);
    }
    const content = readFileSync(absFrom, 'utf-8');
    const written = writeEntry(rootAbs, to, content);
    rmSync(absFrom);
    return { from: absFrom, to: written.path };
}

/**
 * 从某目录向上找最近的 `.diy/knowledge`（找不到则给该目录下的——可能不存在，调用方自己 scanKb 判空）。
 *
 * 为什么放在本包：`existsSync` 这种同步探测在 **app 里是禁新增的**（`check-sync-io` 护栏），
 * 而这里是纯 IO 包、本来就是同步的。宿主只拿结果，不自己去做探测。
 */
export function kbRootOf(from: string): string {
    let at = resolve(from);
    for (;;) {
        const candidate = join(at, '.diy', 'knowledge');
        if (existsSync(candidate)) return candidate;
        const parent = resolve(at, '..');
        if (parent === at) break;
        at = parent;
    }
    return join(resolve(from), '.diy', 'knowledge');
}
