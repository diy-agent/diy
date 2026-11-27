import type { Migration } from './types.js';

/**
 * 建表（`CREATE TABLE IF NOT EXISTS` 一整套）。
 *
 * 它其实不是「增量」，而是**当前 schema 的落地** —— 为什么排在迁移链第 3 位：
 * 两条表改名必须赶在它前面（见 001 的注释），否则会先建出新表、挡住老表改名。
 *
 * SQL 本体留在 store 里（`createSchema`）：它是「当前 schema」这一件事的完整表述，
 * 拆成一条条增量反而看不出全貌。
 */
export const migration: Migration = {
    id: 'create-tables',
    title: '建表（缺什么补什么）',
    plan: {
        from: '（库结构）',
        to: '缺什么补什么的新表 / 索引',
        note: '幂等：已存在不动',
    },
    done: (rt) => rt.hasTable('bot_profiles') && rt.hasTable('bot_profile_defaults') && rt.hasTable('events'),
    up: (rt) => rt.createSchema(),
};
