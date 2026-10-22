import { describe, expect, it } from 'vitest';
import { PLUGIN_API_VERSION, PluginManifestSchema } from '../src/manifest.js';
import { PanelDescriptorSchema } from '../src/panel.js';
import { definePlugin } from '../src/spec.js';

describe('manifest', () => {
    it('接受一份最小清单', () => {
        const parsed = PluginManifestSchema.parse({ id: 'film', name: 'Film 生成器' });
        expect(parsed.apiVersion).toBe(PLUGIN_API_VERSION);
        expect(parsed.contributes.views).toEqual([]);
    });

    it('拒绝非法 id / 非法路由', () => {
        expect(PluginManifestSchema.safeParse({ id: 'Film', name: 'x' }).success).toBe(false);
        expect(
            PluginManifestSchema.safeParse({
                id: 'film',
                name: 'x',
                contributes: { views: [{ id: 'live', title: 't', route: 'a/b' }] },
            }).success,
        ).toBe(false);
    });

    it('view 的 kind 默认 iframe，url 缺失时由宿主报错', () => {
        const parsed = PluginManifestSchema.parse({
            id: 'film',
            name: 'x',
            contributes: { views: [{ id: 'live', title: '场景台' }] },
        });
        expect(parsed.contributes.views[0].kind).toBe('iframe');
    });
});

describe('panel', () => {
    it('接受描述符', () => {
        const parsed = PanelDescriptorSchema.parse({
            id: 'film.stage',
            title: '生成器',
            blocks: [
                { kind: 'info', label: '产物根', value: 'C:/tmp' },
                { kind: 'button', label: '导出', action: { method: 'export', stream: true } },
                { kind: 'progress', value: 0 },
                { kind: 'log', lines: [] },
            ],
        });
        expect(parsed.blocks).toHaveLength(4);
    });

    it('拒绝未知块类型', () => {
        expect(PanelDescriptorSchema.safeParse({ id: 'x', blocks: [{ kind: 'nope' }] }).success).toBe(false);
    });
});

describe('spec', () => {
    it('definePlugin 原样返回', () => {
        const spec = definePlugin({ id: 'film', rpc: { 'units.list': { handler: async () => [] } } });
        expect(spec.id).toBe('film');
        expect(Object.keys(spec.rpc ?? {})).toEqual(['units.list']);
    });
});
