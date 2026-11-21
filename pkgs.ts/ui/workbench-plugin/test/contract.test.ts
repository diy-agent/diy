import { describe, expect, it } from 'vitest';

import { PLUGIN_API_VERSION, PluginManifestSchema } from '../src/manifest.js';
import { PanelDescriptorSchema } from '../src/panel.js';
import { definePlugin } from '../src/spec.js';

describe('manifest', () => {
    it('最小清单：身份 = 包名，diy 段有缺省值', () => {
        const parsed = PluginManifestSchema.parse({ name: 'film-page' });
        expect(parsed.version).toBe('0.0.0');
        expect(parsed.diy.apiVersion).toBe(PLUGIN_API_VERSION);
        expect(parsed.diy.entityTypes).toEqual([]);
        expect(parsed.contributes).toBeUndefined();
    });

    it('接受 scoped 包名（插件身份就是 npm 包名）', () => {
        const parsed = PluginManifestSchema.parse({ name: '@acme/github', version: '1.2.3' });
        expect(parsed.name).toBe('@acme/github');
    });

    it('拒绝空包名 / 非法实体类型名', () => {
        expect(PluginManifestSchema.safeParse({ name: '' }).success).toBe(false);
        expect(
            PluginManifestSchema.safeParse({
                name: 'x',
                diy: { entityTypes: [{ name: 'Issue' }] },
            }).success,
        ).toBe(false);
        expect(
            PluginManifestSchema.safeParse({
                name: 'x',
                diy: { entityTypes: [{ name: 'a/b' }] },
            }).success,
        ).toBe(false);
    });

    it('contributes 是宿主自解释的：原样透传，不做形状校验', () => {
        const contributes = { pages: [{ type: 'film', title: '影片', skeleton: 'three-pane-bottom' }] };
        const parsed = PluginManifestSchema.parse({ name: 'film-page', diy: { apiVersion: 1 }, contributes });
        expect(parsed.contributes).toEqual(contributes);
    });

    it('实体类型的 schemaVersion 缺省为 1', () => {
        const parsed = PluginManifestSchema.parse({
            name: 'x',
            diy: { entityTypes: [{ name: 'issue' }] },
        });
        expect(parsed.diy.entityTypes[0]?.schemaVersion).toBe(1);
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
