import type { Migration } from './types.js';

/**
 * 投递自带正文：`deliveries` 加 `text` 列（##43，2026-11-28）。
 *
 * 之前恢复投递要去 `entity_items` 找正文（`store.textOf`），于是有了一条伪失败路径：
 * 找不到正文 → 判「发送失败」。而「找不到」曾经只是「最近 200 条里没有」——
 * 一条好消息被记成失败（用户 2026-11-28 核出）。
 *
 * 现在正文跟着投递行走，投递日志自包含；`textOf` 只留给历史行（`text` 为 NULL）兜底，
 * 兜到就写回，下次不必再查。
 *
 * 历史行**不回填**：回填要 join `entity_items`（真库实测 11s，见 `failedByRoom` 的注释），
 * 而这只影响「迁移前就挂在那儿、又恰好重启」的极少数行 —— 它们走一次兜底即可。
 *
 * 幂等判据：`columns('deliveries')` 里有 `text`。
 */
export const migration: Migration = {
    id: 'delivery-text',
    title: '投递自带正文（deliveries.text）',
    plan: {
        from: 'deliveries 无正文列，恢复时回 items 查',
        to: 'deliveries.text（可空）；恢复优先用它，历史行回落一次并写回',
        note: '不回填历史行：回填要 join entity_items（真库 11s），只影响极少数的挂起投递',
    },
    done: (rt) => !rt.hasTable('deliveries') || rt.columns('deliveries').has('text'),
    up: (rt) => {
        if (!rt.hasTable('deliveries')) return;
        rt.db.exec('ALTER TABLE deliveries ADD COLUMN text TEXT;');
    },
};
