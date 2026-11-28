import type { Migration } from './types.js';

/**
 * 投递状态值域迁移 + 删掉 `note` 列（##43，2026-11-28）。
 *
 * 旧模型：`state = pending | working | done` + `note = 'failed'` 这种两个字段打架的写法
 * （`done` 同时表示「读完了」和「没送到」）。用户原话：「done 应该是发送成功了……
 * 还有个 note，这不是就是在解决状态不足的临时方案吗」。
 *
 * 新模型（见 `protocol/delivery.ts` 的状态图）：`pending | working | delivered | failed | cancelled`，
 * 取消与失败是两个独立终态，没有第二维。
 *
 * 值域映射：
 *   pending   → pending
 *   working   → working
 *   done + note='failed' → failed
 *   done + 其它 / 空       → delivered
 *   其它老值（delivering / queued / skipped / failed 等历史脏值）按「有没有送到」归一到
 *   working / delivered / failed —— 宁可猜得保守一点，也不要留一个 UI 认不出来的值。
 *
 * 为什么连列一起删：留着 `note` 就会有人再往里写第二个维度；它现在的唯一用途就是那个
 * 已经被状态取代的 'failed'。
 *
 * 幂等判据用 `columns()`：`note` 列没了 = 这条已经做过。
 */
export const migration: Migration = {
    id: 'delivery-states',
    title: '投递状态值域迁移（done+note=failed → delivered/failed/cancelled）+ 删 note 列',
    plan: {
        from: 'state ∈ {pending, working, done} + note',
        to: 'state ∈ {pending, working, delivered, failed, cancelled}，无 note',
        note: '老库有历史行；值域与删列必须同一笔做，否则会出现「列没了但值还是 done」的中间态',
    },
    done: (rt) => rt.hasTable('deliveries') && !rt.columns('deliveries').has('note'),
    up: (rt) => {
        if (!rt.hasTable('deliveries')) return;
        rt.db.exec(`
            UPDATE deliveries SET state = CASE
                WHEN state = 'done' AND note = 'failed' THEN 'failed'
                WHEN state = 'done' THEN 'delivered'
                WHEN state = 'delivering' THEN 'working'
                WHEN state = 'queued' THEN 'pending'
                WHEN state = 'failed' THEN 'failed'
                WHEN state = 'skipped' THEN 'cancelled'
                ELSE state
            END;

            UPDATE deliveries SET state = 'delivered'
                WHERE state NOT IN ('pending', 'working', 'delivered', 'failed', 'cancelled');
        `);
        // SQLite 3.35+ 支持 DROP COLUMN；老引擎上失败就让迁移报出来，别静默留一个第二维
        if (rt.columns('deliveries').has('note')) {
            rt.db.exec('ALTER TABLE deliveries DROP COLUMN note;');
        }
    },
};
