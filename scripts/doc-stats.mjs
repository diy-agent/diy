#!/usr/bin/env node
// scripts/doc-stats.mjs —— 文档里的库表数字**由脚本生成**（2026-11-28 事故的直接处方）
//
// 事故：`2026-11-28-bot-session-domain.md` 标着「唯一口径」，里面三个数字分别来自
// **三张不同的表 / 三个不同的时刻**（41 = room_entries 的去重房数、46 = 41+5 算出来的、
// 34 = 更早某刻的 session_state 行数），而真实值是 45 任务房 / 50 领域对象 / 48 行 41 实体。
// 迁移方案按它排会漏 10 个房。数字手抄一次就再也没人重算 —— 所以这里不让你手写。
//
// 用法：
//   node scripts/doc-stats.mjs --list                     # 有哪些命名查询
//   node scripts/doc-stats.mjs --print tasks              # 打印一个块（贴进文档前先看）
//   node scripts/doc-stats.mjs --update docs/plans/x.md   # 重写这份文档里所有 stats 块
//   ./sha.sh doc-stats docs/plans/x.md                    # 同上（入口）
//
// 文档里的形状：
//
//   <!-- stats:tasks -->
//   | 指标 | 值 |
//   |---|---|
//   | 任务数 | 45 |
//   <!-- /stats:tasks -->
//
// 块的内容永远是**生成物**：`check-docs` 会重算一次比对，对不上就报「数字过期，跑 --update」。
// 快捷键：块写一行 `<!-- stats:tasks -->` 就够，生成时会补表；不知道有哪些名字时 `--list`。
//
// 库：`--db <path>` 或 `$DIY2_DB`，缺省 `~/.diy2/diy2.db`。**只读**打开，不写库。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { statsBlocks } from './lib/doc-status.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 命名查询表。加条目只有一个要求：**这条查询能独立回答一个会被写进文档的数字**。
 * `columns` 是「指标名」；`sql` 返回的行数要与它一致（group by 那类自己拼）。
 */
export const QUERIES = {
    tasks: { label: '任务', sql: 'select count(*) as n from tasks', unit: '个任务' },
    projects: { label: '项目', sql: 'select count(*) as n from projects', unit: '个项目' },
    'entities-by-type': {
        label: '实体（按类型）',
        sql: 'select type, count(*) as n from entities group by type order by type',
        unit: '',
    },
    'rooms-v0': { label: '房间（rooms_v0）', sql: 'select count(*) as n from rooms_v0', unit: '个房间' },
    'rooms-with-entries': {
        label: '有聊天记录的房',
        sql: 'select count(distinct entity_id) as n from room_entries',
        unit: '个房',
    },
    'rooms-in-items': {
        label: '出现过消息的房',
        sql: 'select count(distinct entity_id) as n from entity_items',
        unit: '个房',
    },
    'session-state': {
        label: '会话快照（行 / 实体）',
        sql: 'select count(*) as rows, count(distinct entity_id) as entities from session_state',
        unit: '',
    },
    'bots-v0': { label: '旧 bot 表（bots_v0）', sql: 'select count(*) as n from bots_v0', unit: '条' },
    'bot-profiles': {
        label: 'bot 模板（bot_profiles）',
        sql: 'select count(*) as n from bot_profiles',
        unit: '个模板',
    },
    'room-members': { label: '房间成员（room_members）', sql: 'select count(*) as n from room_members', unit: '条' },
};

function dbPath(argv) {
    const index = argv.indexOf('--db');
    if (index !== -1 && argv[index + 1] !== undefined) return argv[index + 1];
    if (process.env['DIY2_DB'] !== undefined && process.env['DIY2_DB'] !== '') return process.env['DIY2_DB'];
    return join(homedir(), '.diy2', 'diy2.db');
}

/** 只读打开（node:sqlite 内置，Node ≥ 22.5；本仓锁 24.x） */
async function openDb(path) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path, { readOnly: true });
    // 生产库里有个跑着的实例在写：读也可能撞上写事务（默认 busy_timeout = 0 直接报
    // `database is locked`）。给 3 秒重试窗口 —— 这是**只读**打开，不会反过来卡住实例。
    db.exec('pragma busy_timeout = 3000');
    return db;
}

function stamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function prettyPath(path) {
    const home = homedir();
    return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** 一个块：指标表 + 出处（表名 / 查询 / 时刻 / 库） */
export function renderBlock(name, { db, path }) {
    const q = QUERIES[name];
    if (q === undefined) throw new Error(`未知的 stats 名：${name}（用 --list 看有哪些）`);
    const rows = db.prepare(q.sql).all();
    const lines = ['', '| 指标 | 值 |', '|---|---|'];
    for (const row of rows) {
        if ('type' in row) {
            lines.push(`| ${q.label.split('（')[0]}：${row['type']} | ${row['n']} |`);
        } else if ('rows' in row) {
            lines.push(`| 快照行数 | ${row['rows']} |`);
            lines.push(`| 涉及实体 | ${row['entities']} |`);
        } else {
            lines.push(`| ${q.label} | ${row['n']} |`);
        }
    }
    lines.push('');
    // 出处压成**一行**：块里嵌 ``` 会把外层 markdown 围栏截断（写文档时真踩了）
    lines.push(`采集：${stamp()} · 库 \`${prettyPath(path)}\` · 查询 \`${q.sql.replace(/\s+/g, ' ')}\``);
    lines.push('');
    return lines.join('\n');
}

function cmdList() {
    for (const [name, q] of Object.entries(QUERIES)) console.log(`${name.padEnd(20)} ${q.label}`);
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--list')) return cmdList();

    const path = dbPath(argv);
    if (!existsSync(path)) {
        console.error(`库不存在：${path}（--db / $DIY2_DB 指定）`);
        process.exitCode = 2;
        return;
    }
    const db = await openDb(path);

    const printIndex = argv.indexOf('--print');
    if (printIndex !== -1) {
        const name = argv[printIndex + 1];
        process.stdout.write(renderBlock(name, { db, path }));
        return;
    }

    const updateIndex = argv.indexOf('--update');
    if (updateIndex === -1) {
        console.error('用法：node scripts/doc-stats.mjs --list | --print <名> | --update <file>');
        process.exitCode = 2;
        return;
    }
    const file = argv[updateIndex + 1];
    const abs = file.startsWith('/') ? file : join(ROOT, file);
    const text = readFileSync(abs, 'utf8');
    const blocks = statsBlocks(text);
    if (blocks.length === 0) {
        console.error(`${file} 里没有 stats 块（写 <!-- stats:tasks --> … <!-- /stats:tasks -->）`);
        process.exitCode = 2;
        return;
    }
    // 先把所有块都渲染出来再落盘：中途一条查询失败就整份不写（否则文档会被改成半新半旧）
    const rendered = blocks.map((block) => ({ block, body: renderBlock(block.name, { db, path }) }));
    let next = text;
    for (const { block, body } of [...rendered].reverse()) {
        next = next.slice(0, block.start) + body + next.slice(block.end);
    }
    writeFileSync(abs, next);
    console.log(`已更新 ${file}：${blocks.length} 个块（${blocks.map((b) => b.name).join(' / ')}）`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}
