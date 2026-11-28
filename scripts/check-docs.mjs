#!/usr/bin/env node
// scripts/check-docs.mjs —— 文档状态机 + 数字出处护栏（接 ./sha.sh check）
//
// 背景（2026-11-28 事故）：一份标着「唯一口径」的确认稿把三个数字当事实 ——
// 41（其实是 room_entries 的去重房数）、46（41+5 算的）、34（更早某刻的 session_state 行数），
// 真实是 45 任务房 / 50 领域对象 / 48 行 41 实体。迁移方案按它排会漏 10 个房。
// 而那份稿是从**分支 worktree 里的一份 HTML** 抄过来的 —— 两份都像定稿，谁也没说自己是草稿。
//
// 四条判据：
//
//   ① **状态行**：`docs/plans/*.md` 开篇引用块必须有 `> 状态：草稿 | 候选 | 定稿`
//      存量按 `scripts/docs-status-baseline.txt` 棘轮豁免（**只许减**：给老文档补一行就删一行）
//   ② **权威话术**：正文出现「唯一口径 / 以此为准 / 本稿为准 / 这份取代」⇒ 状态必须是**定稿**
//      （草稿自称口径正是这次事故的形状；写在引用块里的说明不算，见 lib 的 authorityHits）
//   ③ **stats 块新鲜**：文档里的 `<!-- stats:x -->` 块要与库里重算的结果一致
//      （不一致 = 数字过期，跑 `./sha.sh doc-stats <file>`；库不存在时跳过并提示）
//   ④ **手抄数字（只提醒）**：`45 个任务房` / `48 行` 这类断言出现在 stats 块外 → 计数，
//      总数超基线即 ✗（用 stats 块替代，或写清「查哪张表、什么时候跑的」）
//
// 用法：
//   node scripts/check-docs.mjs              # 判（接 check）
//   node scripts/check-docs.mjs --list       # 逐篇列状态 / 手抄数字
//   node scripts/check-docs.mjs --self-test  # 判据正反例自检
//   node scripts/check-docs.mjs --refresh-baseline  # 重算 ①④ 的基线（只该在存量清理后跑）

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { authorityHits, numberClaims, statsBlocks, statusOf, stripCollected } from './lib/doc-status.mjs';
import { QUERIES, renderBlock } from './doc-stats.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = join(ROOT, 'docs/plans');
const STATUS_BASELINE = join(ROOT, 'scripts/docs-status-baseline.txt');

/** ④ 的基线：docs/plans 里现存的手抄数字断言条数（棘轮）。刷新：--refresh-baseline */
const LEGACY_NUMBER_CLAIMS = (() => {
    try {
        return Number(readFileSync(join(ROOT, 'scripts/docs-number-claims-baseline.txt'), 'utf8').trim());
    } catch {
        return 0;
    }
})();

function dbPath() {
    if (process.env['DIY2_DB'] !== undefined && process.env['DIY2_DB'] !== '') return process.env['DIY2_DB'];
    return join(homedir(), '.diy2', 'diy2.db');
}

function docFiles() {
    if (!existsSync(DOCS_DIR)) return [];
    return readdirSync(DOCS_DIR)
        .filter((name) => name.endsWith('.md'))
        .sort()
        .map((name) => join(DOCS_DIR, name));
}

function rel(path) {
    return relative(ROOT, path).split('\\').join('/');
}

function loadStatusBaseline() {
    if (!existsSync(STATUS_BASELINE)) return new Set();
    return new Set(
        readFileSync(STATUS_BASELINE, 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '' && !line.startsWith('#')),
    );
}

async function loadDb() {
    const path = dbPath();
    if (!existsSync(path)) return null;
    const { DatabaseSync } = await import('node:sqlite');
    return { db: new DatabaseSync(path, { readOnly: true }), path };
}

/** 判一篇：返回 { errors, warnings } */
export function judgeDoc(file, text, { statusBaseline, handle }) {
    const errors = [];
    const warnings = [];

    // ① 状态行
    const status = statusOf(text);
    if (status === null && !statusBaseline.has(file)) {
        errors.push(
            '缺状态行：开篇引用块写 `> 状态：草稿 | 候选 | 定稿`（存量豁免见 scripts/docs-status-baseline.txt）',
        );
    }

    // ② 权威话术只许出现在定稿
    for (const hit of authorityHits(text)) {
        if (status !== '定稿') {
            errors.push(
                `第 ${hit.line} 行写了「${hit.phrase}」，但状态是 ${status ?? '（没写）'} —— 权威话术只属于定稿`,
            );
        }
    }

    // ③ stats 块新鲜
    if (handle !== null) {
        for (const block of statsBlocks(text)) {
            if (!(block.name in QUERIES)) {
                errors.push(`stats 块名不存在：stats:${block.name}（node scripts/doc-stats.mjs --list）`);
                continue;
            }
            const fresh = stripCollected(renderBlock(block.name, handle));
            if (stripCollected(block.body) !== fresh) {
                errors.push(`stats:${block.name} 的数字与库对不上（过期了）—— 跑 ./sha.sh doc-stats ${file}`);
            }
        }
    }

    // ④ 手抄数字（只提醒，总数进棘轮）
    const claims = numberClaims(text);
    if (claims.length > 0) {
        warnings.push(
            `${claims.length} 处疑似手抄的库表数字（第 ${claims
                .slice(0, 3)
                .map((c) => c.line)
                .join(' / ')} 行…）—— 建议换成 stats 块：./sha.sh doc-stats ${file}`,
        );
    }

    return { errors, warnings, status, claims: claims.length };
}

function selfTest() {
    const cases = [
        {
            name: '状态行：合法',
            text: '# x\n\n> 状态：候选\n> 出处：本轮会话\n\n正文',
            want: null,
        },
        {
            name: '状态行：缺',
            text: '# x\n\n正文',
            want: '缺状态行',
        },
        {
            name: '权威话术 + 草稿 → 拦',
            text: '# x\n\n> 状态：草稿\n\n这份是唯一口径。',
            want: '权威话术只属于定稿',
        },
        {
            name: '权威话术 + 定稿 → 放行',
            text: '# x\n\n> 状态：定稿\n\n这份是唯一口径。',
            want: null,
        },
        {
            name: '引用块里的「取代」不算权威话术',
            text: '# x\n\n> 状态：草稿\n> 取代：旧稿\n\n正文',
            want: null,
        },
        {
            name: '手抄数字会被数出来',
            text: '# x\n\n> 状态：定稿\n\n现在有 45 个任务房 / 48 行快照。',
            want: null,
            claims: 2,
        },
        {
            name: 'stats 块里的数字不重复计数',
            text: '# x\n\n> 状态：定稿\n\n<!-- stats:tasks -->\n| 任务数 | 45 个任务 |\n<!-- /stats:tasks -->',
            want: null,
            claims: 0,
        },
    ];
    let bad = 0;
    for (const c of cases) {
        const result = judgeDoc('t.md', c.text, { statusBaseline: new Set(), handle: null });
        const err = c.want === null ? result.errors.length === 0 : result.errors.some((e) => e.includes(c.want));
        const claimsOk = c.claims === undefined || result.claims === c.claims;
        if (!err || !claimsOk) {
            bad += 1;
            console.error(
                `✗ ${c.name}：期望 ${c.want ?? '无错'} / ${c.claims ?? '—'}，实际 ${JSON.stringify(result.errors)} claims=${result.claims}`,
            );
        }
    }
    console.log(bad === 0 ? `✓ 自检通过（${cases.length} 例）` : `✗ 自检失败 ${bad} 例`);
    process.exitCode = bad === 0 ? 0 : 1;
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--self-test')) return selfTest();

    const statusBaseline = loadStatusBaseline();
    const handle = await loadDb();
    const files = docFiles();

    if (argv.includes('--list')) {
        for (const file of files) {
            const text = readFileSync(file, 'utf8');
            const result = judgeDoc(rel(file), text, { statusBaseline, handle });
            const mark = result.errors.length > 0 ? '✗' : result.warnings.length > 0 ? '·' : '✓';
            console.log(
                `${mark} ${(result.status ?? '（无状态行）').padEnd(4)} ${rel(file)}  手抄数字 ${result.claims}`,
            );
        }
        return;
    }

    if (argv.includes('--refresh-baseline')) {
        const missing = files.filter((file) => statusOf(readFileSync(file, 'utf8')) === null).map(rel);
        writeFileSync(
            STATUS_BASELINE,
            ['# 缺状态行的存量文档（棘轮：补一行删一行，只许减）', ...missing].join('\n') + '\n',
        );
        let claims = 0;
        for (const file of files) {
            claims += judgeDoc(rel(file), readFileSync(file, 'utf8'), {
                statusBaseline: new Set(),
                handle: null,
            }).claims;
        }
        writeFileSync(join(ROOT, 'scripts/docs-number-claims-baseline.txt'), `${claims}\n`);
        console.log(`基线已刷新：缺状态行 ${missing.length} 篇 · 手抄数字 ${claims} 处`);
        return;
    }

    let errors = 0;
    let warnings = 0;
    let claims = 0;
    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        const result = judgeDoc(rel(file), text, { statusBaseline, handle });
        claims += result.claims;
        for (const message of result.errors) {
            errors += 1;
            console.error(`✗ ${rel(file)}：${message}`);
        }
        for (const message of result.warnings) {
            warnings += 1;
            if (process.env['DOCS_CHECK_VERBOSE'] === '1') console.warn(`· ${rel(file)}：${message}`);
        }
    }

    if (handle === null) console.warn(`· 库不存在（${dbPath()}）→ stats 块新鲜度没判（--db / $DIY2_DB 可指定）`);

    if (claims > LEGACY_NUMBER_CLAIMS) {
        console.error(
            `✗ 手抄的库表数字 ${claims} 处 > 基线 ${LEGACY_NUMBER_CLAIMS}（新增了 —— 用 stats 块代替，` +
                `生成：./sha.sh doc-stats <file>；确实要手写就写明「表 / 查询 / 时刻」并跑 --refresh-baseline）`,
        );
        errors += 1;
    }

    if (errors === 0) {
        console.log(
            `✓ 文档状态护栏通过（${files.length} 篇 · 手抄数字 ${claims}/${LEGACY_NUMBER_CLAIMS} · 提醒 ${warnings} 条，DOCS_CHECK_VERBOSE=1 看详情）`,
        );
    } else {
        console.error(`[check-docs] ✗ ${errors} 处不合格`);
        process.exitCode = 1;
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}
