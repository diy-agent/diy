import type { Migration } from './types.js';

/**
 * 2026-11-25：依赖边与交付批次整体退役（只留需求账本树）。
 *
 * 旧库里的两张表直接删 —— 它们是纯派生侧的记录，删掉不丢「要做什么」。
 * （`task_units.batch_id` 是老库的死列：SQLite 不能删列，代码也再不读写它。）
 */
export const migration: Migration = {
    id: 'drop-unit-deps',
    title: '删掉退役表 unit_deps / unit_batches',
    plan: {
        from: 'unit_deps / unit_batches',
        to: '（删除）',
        note: '依赖边与交付批次已退役',
        rows: (rt) => {
            const count = (table: string): number =>
                rt.hasTable(table) ? (rt.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n : 0;
            return count('unit_deps') + count('unit_batches');
        },
    },
    done: (rt) => !rt.hasTable('unit_deps') && !rt.hasTable('unit_batches'),
    up: (rt) => {
        rt.db.exec('DROP TABLE IF EXISTS unit_deps');
        rt.db.exec('DROP TABLE IF EXISTS unit_batches');
    },
};
