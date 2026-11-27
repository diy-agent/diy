// checksums.generated.ts —— 迁移文件指纹表（**生成物，别手改**）。
//
// 生成：`node scripts/gen-migration-checksums.mjs`（改了任何迁移文件都要重跑；护栏会拦）
// 用途：迁移跑过之后，指纹记进 schema_migrations；启动时比对 —— 文件被改过就告警，
//       因为已跑过的迁移**不会被重放**，改它等于没改。判据见 scripts/lib/migration-checksums.mjs。

export const MIGRATION_CHECKSUMS: Readonly<Record<string, string>> = {
    'bot-profile-columns': 'f795fdea06086977', /* 008-bot-profile-columns.ts */
    'clear-placeholder-model': '598dbd66f5b15020', /* 009-clear-placeholder-model.ts */
    'create-tables': '3c5321fb86a9185e', /* 003-create-tables.ts */
    'deliveries-columns': '20fc1ee68ead9a32', /* 005-deliveries-columns.ts */
    'drop-legacy-room-model': 'ef9574bee9dfa08e', /* 016-drop-legacy-room-model.ts */
    'drop-unit-deps': 'a97cc4421d67ad3e', /* 012-drop-unit-deps.ts */
    'drop-unit-step': '383e1b26dabdd330', /* 019-drop-unit-step.ts */
    'entity-bots': 'a9227911adc43f70', /* 004-entity-bots.ts */
    'fold-bots': 'c2da4d530e84a40c', /* 014-fold-bots.ts */
    'legacy-journal': '7d3603fb5ed0f719', /* 015-legacy-journal.ts */
    'legacy-rooms': 'ee709fb164247179', /* 013-legacy-rooms.ts */
    'prune-room-members': '9437232aa7db0000', /* 017-prune-room-members.ts */
    'rename-bot-roles': '679c2b0890f189a3', /* 001-rename-bot-roles.ts */
    'rename-role-config': '47eff0e2027425ab', /* 002-rename-role-config.ts */
    'session-bot-column': 'b5dd28d2fef08c94', /* 007-session-bot-column.ts */
    'session-log-seq': '36b84280f5c2d270', /* 006-session-log-seq.ts */
    'task-units-kind': 'e697d0ea1d3cfc9d', /* 018-task-units-kind.ts */
    'task-units-parent': '81bbcde0e6a6c803', /* 011-task-units-parent.ts */
    'tasks-updated-at': 'e6175f278d22dfe8', /* 010-tasks-updated-at.ts */
    'turn-facts': '5698b3a26142b33c', /* 020-turn-facts.ts */
};
