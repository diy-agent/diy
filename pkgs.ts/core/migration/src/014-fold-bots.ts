import type { Migration } from './types.js';

/**
 * 把老 `bots`（每个容器一个同名 bot，几十行人设重复）折成按类型 + 人设合并的机器人配置。
 *
 * 实现留在 store：它要改会话快照、交付记录、历史消息作者、提问归属 ——
 * 都是 store 的结构知识，不适合搬进迁移文件。迁移只负责触发与记账。
 *
 * 这一步在大库上要跑几秒（一次性扫 entity_items），所以带子进度。
 */
export const migration: Migration = {
    id: 'fold-bots',
    title: '把 bots 折成 bot_profiles（按类型 + 人设合并）',
    plan: {
        from: 'bots',
        to: 'bot_profiles',
        note: '按类型 + 人设折叠；旧表留档 bots_v0',
        rows: (rt) => (rt.hasTable('bots') ? (rt.db.prepare('SELECT COUNT(*) AS n FROM bots').get() as { n: number }).n : -1),
    },
    done: (rt) => !rt.hasTable('bots'),
    up: (rt) => rt.foldBots(),
};
