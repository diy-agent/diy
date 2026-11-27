import { PLACEHOLDER_MODEL_KEY } from './model-key.js';
import type { Migration } from './types.js';

/**
 * 占位模型键不是「选了模型」：老库里还留着 `none@none/none`。
 *
 * 房间级 model_key 已退役（见 016），这里只清机器人配置上的存量：
 * 空串 / 占位都不该进模型列 —— 没选 = 继续继承。
 */
export const migration: Migration = {
    id: 'clear-placeholder-model',
    title: '清掉占位模型键 none@none/none',
    plan: {
        from: 'bot_profiles.model_key',
        to: 'NULL',
        note: '作废占位值 none@none/none',
        rows: (rt) =>
            rt.hasTable('bot_profiles')
                ? (rt.db.prepare('SELECT COUNT(*) AS n FROM bot_profiles').get() as { n: number }).n
                : -1,
    },
    // 数据归一 = 不变量：每次启动复查一次（一个带索引的 LIMIT 1 查询，几乎免费）
    converge: true,
    done: (rt) => {
        if (!rt.hasTable('bot_profiles')) return true;
        return (
            (
                rt.db
                    .prepare('SELECT 1 AS x FROM bot_profiles WHERE model_key = ? LIMIT 1')
                    .all(PLACEHOLDER_MODEL_KEY) as unknown[]
            ).length === 0
        );
    },
    up: (rt) => {
        rt.db.prepare('UPDATE bot_profiles SET model_key = NULL WHERE model_key = ?').run(PLACEHOLDER_MODEL_KEY);
    },
};
