// registry.test.ts —— 清单 → 内存注册表：身份、实体类型、冲突。
//
// 这一层不碰 IO（宿主决定从哪读）；这里只钉「读到的对不对」与查询形状。

import { describe, expect, it } from 'vitest';

import { createPluginRegistry } from '../src/registry.js';

const github = {
    name: '@acme/github',
    version: '1.0.0',
    diy: { apiVersion: 1, entityTypes: [{ name: 'issue' }, { name: 'repository', schemaVersion: 2 }] },
};

const bare = {
    name: 'x',
    diy: { entityTypes: [{ name: 'issue' }] },
};

describe('createPluginRegistry', () => {
    it('插件按 id 排序；实体类型全名带包名命名空间', () => {
        const registry = createPluginRegistry([bare, github]);
        expect(registry.plugins().map((plugin) => plugin.id)).toEqual(['@acme/github', 'x']);
        expect(registry.entityTypes().map((type) => type.type)).toEqual([
            '@acme/github/issue',
            '@acme/github/repository',
            'x/issue',
        ]);
        expect(registry.entityType('@acme/github/repository')).toMatchObject({
            pluginId: '@acme/github',
            local: 'repository',
            schemaVersion: 2,
        });
    });

    it('插件查询与「类型归谁」', () => {
        const registry = createPluginRegistry([github]);
        expect(registry.plugin('@acme/github')?.version).toBe('1.0.0');
        expect(registry.pluginOfType('@acme/github/issue')?.id).toBe('@acme/github');
        // core 类型不走注册表
        expect(registry.entityType('task')).toBeUndefined();
        expect(registry.pluginOfType('task')).toBeUndefined();
    });

    it('contributes 原样留在记录里（宿主自己解释）', () => {
        const contributes = { views: [{ id: 'live', title: '实时' }] };
        const registry = createPluginRegistry([{ ...github, contributes }]);
        expect(registry.plugin('@acme/github')?.manifest.contributes).toEqual(contributes);
    });

    it('清单不合法：报错带插件名与字段路径', () => {
        expect(() => createPluginRegistry([{ name: '@acme/github', diy: { entityTypes: [{ name: 'Bad' }] } }])).toThrow(
            /@acme\/github.*entityTypes/,
        );
    });

    it('apiVersion 不支持 → 整份拒绝', () => {
        expect(() => createPluginRegistry([{ name: 'x', diy: { apiVersion: 99 } }])).toThrow(/apiVersion 99/);
    });

    it('插件 id 重复 / 同一插件内实体类型重复 → 加载即失败', () => {
        expect(() => createPluginRegistry([bare, bare])).toThrow(/插件 id 重复/);
        expect(() =>
            createPluginRegistry([{ name: 'x', diy: { entityTypes: [{ name: 'issue' }, { name: 'issue' }] } }]),
        ).toThrow(/实体类型重复/);
    });

    it('空清单也是合法注册表（宿主还没装任何插件）', () => {
        const registry = createPluginRegistry([]);
        expect(registry.plugins()).toEqual([]);
        expect(registry.entityTypes()).toEqual([]);
    });
});
