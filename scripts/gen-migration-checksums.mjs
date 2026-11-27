#!/usr/bin/env node
// scripts/gen-migration-checksums.mjs —— 重新生成迁移指纹表。
//
// 什么时候跑：**改了 / 新增了 / 删了**任何 `pkgs.ts/core/migration/src/NNN-*.ts`。
// 不跑的话 `scripts/check-migration-checksums.mjs` 会红（`./sha.sh check` 里就会红）。
//
// 注意：改一条**已经发布过**的迁移，即使重新生成了指纹表，已迁的库也不会重放它 ——
// 运行时会比对「库里记的指纹」与这张表，对不上就告警。改历史迁移请先想清楚。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHECKSUMS_FILE, collectMigrationChecksums, renderChecksumsFile } from './lib/migration-checksums.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = collectMigrationChecksums(ROOT);
writeFileSync(path.join(ROOT, CHECKSUMS_FILE), renderChecksumsFile(entries));
console.log(`✓ 写入 ${CHECKSUMS_FILE}（${entries.length} 条迁移）`);
