// checksums.ts —— 「迁移文件跑过之后被改过吗」
//
// 指纹表的真源在 `./checksums.generated.ts`（生成物，脚本 `scripts/gen-migration-checksums.mjs`）；
// 这里只做**比对**：库里记的指纹 vs 当前代码的指纹。
//
// 为什么这件事要报出来：迁移一旦记账，`run()` 就跳过它（converge 除外）—— 事后改文件
// 在已迁的库上**不会重放**。不报的话，人以为改了生效了，其实一行都没跑。

import type { DatabaseSync } from 'node:sqlite';

import { MIGRATION_CHECKSUMS } from './checksums.generated.js';

const TABLE = 'schema_migrations';

/** 一条「跑过之后又被改了」的迁移 */
export interface ChecksumDrift {
    id: string;
    /** 库里记的（跑过的那一版） */
    recorded: string;
    /** 现在代码里的（文件当前内容） */
    current: string;
}

/** 当前代码里这条迁移的指纹（认不出的 id 返回 undefined） */
export function checksumOf(id: string): string | undefined {
    return MIGRATION_CHECKSUMS[id];
}

/**
 * 比对：库里有指纹记录、且与当前代码不一致的迁移。
 *
 * 没有这张表 / 没有 checksum 列（老库）→ 空数组，不报错：
 * 老库的指纹会在下次 `applyMigrations()` 里静默补上（那之前本来就无从比对）。
 */
export function checksumDrift(db: DatabaseSync): ChecksumDrift[] {
    let rows: Array<{ id: string; checksum: string | null }>;
    try {
        rows = db.prepare(`SELECT id, checksum FROM ${TABLE}`).all() as Array<{ id: string; checksum: string | null }>;
    } catch {
        return [];
    }
    const out: ChecksumDrift[] = [];
    for (const row of rows) {
        const current = MIGRATION_CHECKSUMS[row.id];
        if (current === undefined || row.checksum === null) continue;
        if (row.checksum !== current) out.push({ id: row.id, recorded: row.checksum, current });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
}
