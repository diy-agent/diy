import type { Migration } from './types.js';

/** 老库补列：deliveries 的 mode / turn / turn_id。 */
export const migration: Migration = {
    id: 'deliveries-columns',
    title: '补列：deliveries.mode / turn / turn_id',
    plan: {
        from: 'deliveries',
        to: '+ mode / turn / turn_id',
        note: '补三列（已有时不动）',
        rows: (rt) =>
            rt.hasTable('deliveries') ? (rt.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get() as { n: number }).n : -1,
    },
    done: (rt) => {
        const columns = rt.columns('deliveries');
        return ['mode', 'turn', 'turn_id'].every((column) => columns.has(column));
    },
    up: (rt) => {
        const columns = rt.columns('deliveries');
        for (const column of ['mode', 'turn', 'turn_id']) {
            if (!columns.has(column)) rt.db.exec(`ALTER TABLE deliveries ADD COLUMN ${column}`);
        }
    },
};
