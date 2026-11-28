import type { Migration } from './types.js';

/**
 * 条目 id 的表达式索引（2026-11-28）。
 *
 * 为什么要有：需求板 `units.list` / `units.get` 每次轮询都要把 `source`
 * （「这条需求来自哪句人话」）解回原话，靠的是
 *
 *     SELECT seq, item FROM entity_items WHERE json_extract(item, '$.id') IN (…)
 *
 * 而 `item` 的 id 只在 json 里、没有索引 —— SQLite 只能**全表扫**。真库实测
 * （43,933 行 / 150MB）：50 个 id 一次 0.86~1.18s；卡到事件循环时单次到过 1.9s，
 * 30 秒的 CPU profile 里有 9 秒在这条 SQL 上。加上表达式索引后同一条查询 **0.01s**。
 *
 * 只建索引、不动任何数据；索引约 1.5MB（部分索引只收有 id 的行）。
 * 查询**不能**加 `entity_id = ?`（来源可能跨房间，见 `itemsByIds` 的注释），
 * 所以索引也按全局 id 建，而不是 `(entity_id, id)`。
 */
const INDEX = 'items_item_id';
const DDL = `CREATE INDEX IF NOT EXISTS ${INDEX} ON entity_items(
    json_extract(item, '$.id')
) WHERE json_extract(item, '$.id') IS NOT NULL`;

function hasIndex(rt: { db: { prepare(sql: string): { get(...params: unknown[]): unknown } } }): boolean {
    return (
        rt.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name = ?").get(INDEX) !== undefined
    );
}

export const migration: Migration = {
    id: 'item-id-index',
    title: '条目 id 表达式索引（itemsByIds 不再全表扫）',
    plan: {
        from: "entity_items：`json_extract(item,'$.id')` 无索引",
        to: `表达式索引 ${INDEX}（50 个 id：0.9s → 0.01s）`,
        note: '只建索引、不动数据；约 1.5MB。需求板每次轮询都会问它',
    },
    done: (rt) => !rt.hasTable('entity_items') || hasIndex(rt),
    up: (rt) => {
        if (!rt.hasTable('entity_items')) return; // 新库：create-tables 已经建好
        rt.db.exec(DDL);
    },
};
