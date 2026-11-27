#!/usr/bin/env node
// scripts/check-migration-checksums.mjs —— 迁移指纹表是否跟得上源文件（护栏）。
//
// 判据：现场重算一遍，与 `pkgs.ts/core/migration/src/checksums.generated.ts` 逐字比对。
// 不一致 = 有人改了迁移文件却没重新生成 → 红，并给出该怎么修。
//
// 为什么这条要进 check：运行时靠这张表判断「迁移文件事后被改过」，
// 表一旦过期，那个判断就是错的（改了却没更新表 = 检查不出来）。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHECKSUMS_FILE, collectMigrationChecksums, renderChecksumsFile } from './lib/migration-checksums.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expected = renderChecksumsFile(collectMigrationChecksums(ROOT));
const actual = readFileSync(path.join(ROOT, CHECKSUMS_FILE), 'utf8');

if (actual !== expected) {
    const want = new Set(expected.split('\n'));
    const have = new Set(actual.split('\n'));
    const added = [...want].filter((line) => !have.has(line) && line.trim().startsWith("'"));
    const removed = [...have].filter((line) => !want.has(line) && line.trim().startsWith("'"));
    console.error('✗ 迁移指纹表过期（checksums.generated.ts 与迁移文件不一致）');
    for (const line of removed) console.error(`  - 旧：${line.trim()}`);
    for (const line of added) console.error(`  + 新：${line.trim()}`);
    console.error('\n处置：node scripts/gen-migration-checksums.mjs');
    console.error('提醒：改一条已经在库上跑过的迁移，已迁的库不会重放它 —— 要生效请新开一条迁移。');
    process.exit(1);
}

console.log('✓ 迁移指纹表与源文件一致');
