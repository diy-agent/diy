// tests/catalog.test.ts — 最小模型目录的形状约束。
//
// 判据：2~3 条、id 唯一、字段是元数据（不掺连接信息）、未知 id 查得到 undefined 而不是抛错。

import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID, DEFAULT_MODELS, findModel } from '../src/index.js';

describe('模型目录', () => {
    it('2~3 条，id 唯一且非空', () => {
        expect(DEFAULT_MODELS.length).toBeGreaterThanOrEqual(2);
        expect(DEFAULT_MODELS.length).toBeLessThanOrEqual(3);
        const ids = DEFAULT_MODELS.map((model) => model.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id.length).toBeGreaterThan(0);
    });

    it('缺省模型在目录里', () => {
        expect(findModel(DEFAULT_MODEL_ID)).toBeTruthy();
    });

    it('条目只带元数据（id / name / 窗口 / 价目），不含连接信息', () => {
        for (const model of DEFAULT_MODELS) {
            expect(Object.keys(model).sort()).toEqual(expect.arrayContaining(['id', 'name']));
            expect(model).not.toHaveProperty('baseURL');
            expect(model).not.toHaveProperty('apiKey');
            if (model.contextWindow !== undefined) expect(model.contextWindow).toBeGreaterThan(0);
            if (model.cost !== undefined) expect(model.cost.input).toBeGreaterThanOrEqual(0);
        }
    });

    it('未知 id 返回 undefined（交给上游判，不在本地抛）', () => {
        expect(findModel('no-such-model')).toBeUndefined();
    });
});
