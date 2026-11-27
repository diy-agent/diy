#!/usr/bin/env node
// scripts/lib/migration-checksums.mjs —— 迁移文件指纹的**唯一算法**（生成器与护栏共用）。
//
// 为什么要指纹（Flyway 的 checksum）：迁移一旦在某个库上跑过，**它就被冻结了** ——
// 后来改它（改 SQL / 改判据）在已迁的库上不会重放，改了等于没改，只会让人以为生效了。
// 所以把「跑过的那一版」的指纹记进 schema_migrations，下次启动一比对就知道文件被改过。
//
// 为什么指纹打在**文件内容**上，而不是函数源码（`up.toString()`）上：
//   实测同一份迁移经 esbuild 打包后，函数源码的空白/变量名会变（`up.toString()` 哈希 dev≠产物），
//   而文件内容是**构建前后都一样**的字节 —— 只有它能跨 dev / 产物两种运行形态稳定。
//   代价：在文件里加注释也算「改过」。这是刻意的（Flyway 同样对文件哈希）：要改就新开一条迁移。
//
// 指纹口径：`sha256(CRLF→LF 后的文件内容)` 取前 16 位十六进制。
//   · CRLF→LF：Windows 检出不能算出另一个指纹；
//   · 只取文件本身，不掺入 id —— 文件名换了就是换了迁移，本来就该发现。
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** 迁移目录（相对仓根） */
export const MIGRATION_DIR = 'pkgs.ts/core/migration/src';
/** 生成物（相对仓根） */
export const CHECKSUMS_FILE = `${MIGRATION_DIR}/checksums.generated.ts`;

/** 文件名即迁移：`003-create-tables.ts` → id `create-tables` */
const FILE_RE = /^\d{3}-(.+)\.ts$/;

/** 指纹：内容按 LF 归一后 sha256 前 16 位 */
export function checksumOfText(text) {
    return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

/** 扫迁移目录，返回 [{ id, file, checksum }]（按 id 排序，稳定输出） */
export function collectMigrationChecksums(root) {
    const dir = path.join(root, MIGRATION_DIR);
    const out = [];
    for (const name of readdirSync(dir)) {
        const match = FILE_RE.exec(name);
        if (match === null) continue;
        const text = readFileSync(path.join(dir, name), 'utf8');
        out.push({ id: match[1], file: `${MIGRATION_DIR}/${name}`, checksum: checksumOfText(text) });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
}

/** 生成物的完整内容（生成器写它，护栏比它） */
export function renderChecksumsFile(entries) {
    const lines = entries.map((entry) => `    '${entry.id}': '${entry.checksum}', /* ${entry.file.split('/').pop()} */`);
    return `// checksums.generated.ts —— 迁移文件指纹表（**生成物，别手改**）。
//
// 生成：\`node scripts/gen-migration-checksums.mjs\`（改了任何迁移文件都要重跑；护栏会拦）
// 用途：迁移跑过之后，指纹记进 schema_migrations；启动时比对 —— 文件被改过就告警，
//       因为已跑过的迁移**不会被重放**，改它等于没改。判据见 scripts/lib/migration-checksums.mjs。

export const MIGRATION_CHECKSUMS: Readonly<Record<string, string>> = {
${lines.join('\n')}
};
`;
}
