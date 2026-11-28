import type { Migration } from './types.js';

/**
 * 补建每轮结算事实表 `turn_facts`。
 *
 * 为什么单独一条、而不是只放进 `003-create-tables` 的 `createSchema`：
 * `create-tables` 一旦已记账，`applyMigrations` 就 `continue` 跳过 `up()`，
 * `createSchema` 不会重跑。`turn_facts` 是在 `003` 之后（`feat(chat): 落盘每轮的结算事实`，
 * 6c1944b8）才加进 `createSchema` 的，**老库 `create-tables` 已 applied、表没建**，
 * 下次 `saveTurnFact` 写 / `turnFacts` 读就 `no such table: turn_facts`。
 * 版本表说「19/19 已迁」、`probeMigration` 判 pending=false，app 照常起、照常崩。
 * 不能改 `003`（已 applied + checksum drift + 改了不重放），故加本条，顺序在 `003` 之后。
 *
 * 建表语句与 `createSchema` 里 `turn_facts` 段保持一致；`IF NOT EXISTS` 幂等：
 * 新库 `003` 已建好则本条 no-op，老库本条补建。
 */
export const migration: Migration = {
    id: 'turn-facts',
    title: '补建每轮结算事实表 turn_facts',
    plan: {
        from: '（库结构）',
        to: '新表 turn_facts + 索引 turn_facts_entity',
        note: '幂等：已存在不动；老库 create-tables 记账后才加的表，这条补上',
    },
    done: (rt) => rt.hasTable('turn_facts'),
    up: (rt) => {
        rt.db.exec(`
            CREATE TABLE IF NOT EXISTS turn_facts (
                entity_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                bot_id TEXT NOT NULL,
                turn INTEGER NOT NULL,
                started_at INTEGER,
                ended_at INTEGER NOT NULL,
                usage TEXT,
                tool_calls INTEGER,
                reason TEXT,
                PRIMARY KEY (entity_id, turn_id, bot_id)
            );
            CREATE INDEX IF NOT EXISTS turn_facts_entity ON turn_facts(entity_id, turn);
        `);
    },
};
