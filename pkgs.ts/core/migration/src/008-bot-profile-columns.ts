import type { Migration } from './types.js';

/**
 * 老库补列：机器人配置的 per-task 归属（2026-11-26）。
 * 老行 domain 全为 null = type 级配置（模板），向后兼容。
 */
export const migration: Migration = {
    id: 'bot-profile-columns',
    title: '补列：bot_profiles.domain_type / domain_id / persona_ref',
    plan: {
        from: 'bot_profiles',
        to: '+ domain_type / domain_id / persona_ref',
        note: '补归属与人设三列',
        rows: (rt) =>
            rt.hasTable('bot_profiles')
                ? (rt.db.prepare('SELECT COUNT(*) AS n FROM bot_profiles').get() as { n: number }).n
                : -1,
    },
    done: (rt) => {
        const columns = rt.columns('bot_profiles');
        return ['domain_type', 'domain_id', 'persona_ref'].every((column) => columns.has(column));
    },
    up: (rt) => {
        const columns = rt.columns('bot_profiles');
        for (const column of ['domain_type', 'domain_id', 'persona_ref']) {
            if (!columns.has(column)) rt.db.exec(`ALTER TABLE bot_profiles ADD COLUMN ${column}`);
        }
    },
};
