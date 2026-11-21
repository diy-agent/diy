// id.test.ts —— 实体身份：UUIDv7 形状与单调性、core / 插件类型的判定。
//
// 这些断言钉的是「跨进程可排序 + 跨边界能校验」这两件事，
// 而不是某个库的实现细节（v7 的字节布局是 RFC 9562 定的）。

import { describe, expect, it } from 'vitest';

import { isCoreType, isEntityId, isEntityType, isPluginType, newEntityId, splitPluginType } from '../src/id';

describe('newEntityId（UUIDv7）', () => {
    it('形状：小写 36 字符、版本 7、variant 10xx', () => {
        const id = newEntityId(1_700_000_000_000);
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(isEntityId(id)).toBe(true);
    });

    it('前 48 位是毫秒 → 字典序 ≈ 时间序', () => {
        const early = newEntityId(1_700_000_000_000);
        const late = newEntityId(1_700_000_001_000);
        expect(early < late).toBe(true);
    });

    it('同一毫秒内单调且不重复（顺序位）', () => {
        const ids = Array.from({ length: 8 }, () => newEntityId(1_700_000_000_000));
        expect([...ids].sort()).toEqual(ids);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('时钟回拨不倒退（仍按上一个毫秒往后排）', () => {
        const a = newEntityId(2_000);
        const b = newEntityId(1_000);
        expect(a < b).toBe(true);
    });

    it('isEntityId 拒绝 v4 / 历史 id / 非字符串', () => {
        expect(isEntityId('3f7a8b2c-7d41-4f4e-9a5e-123456789abc')).toBe(false);
        expect(isEntityId('proj:diy')).toBe(false);
        expect(isEntityId(42)).toBe(false);
    });
});

describe('实体类型', () => {
    it('core 是闭合集合：project / task / bot', () => {
        expect(isCoreType('project')).toBe(true);
        expect(isCoreType('task')).toBe(true);
        expect(isCoreType('bot')).toBe(true);
        expect(isCoreType('agent.run')).toBe(false);
        expect(isCoreType('@acme/github/issue')).toBe(false);
    });

    it('插件类型 = <包名>/<局部名>；scope 形与裸名都能反解', () => {
        expect(splitPluginType('@acme/github/issue')).toEqual({ pluginId: '@acme/github', local: 'issue' });
        expect(splitPluginType('x/issue')).toEqual({ pluginId: 'x', local: 'issue' });
    });

    it('不是插件类型的都返回 undefined（含插件 id 本身）', () => {
        expect(splitPluginType('project')).toBeUndefined();
        expect(splitPluginType('@acme/github')).toBeUndefined();
        expect(splitPluginType('@acme/github/Issue')).toBeUndefined();
        expect(splitPluginType('x/a/b')).toBeUndefined();
        expect(splitPluginType('x/issue.synced')).toBeUndefined();
    });

    it('isPluginType 与 core 互斥；isEntityType 是两者的并集', () => {
        expect(isPluginType('@acme/github/issue')).toBe(true);
        expect(isPluginType('task')).toBe(false);
        expect(isEntityType('task')).toBe(true);
        expect(isEntityType('@acme/github/issue')).toBe(true);
        expect(isEntityType('agent.turn')).toBe(false);
    });
});
