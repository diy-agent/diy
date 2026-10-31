// 「列给用户选」的文本（判据 4：不自动连接）。
import { describe, expect, it } from 'vitest';
import { displayWidth, formatDiscoveryList, labelOf } from '../src/format.js';
import type { MergedInstance } from '../src/types.js';

const row = (patch: Partial<MergedInstance>): MergedInstance => ({
    id: 'diy-0000aaaa',
    displayName: '实例',
    endpoint: 'http://127.0.0.1:9400',
    source: 'local',
    sources: ['local'],
    ...patch,
});

describe('formatDiscoveryList', () => {
    it('按序号列出行 + 来源 + 末尾手动输入项', () => {
        const text = formatDiscoveryList([
            row({ displayName: 'c-mac 的 lab 实例', endpoint: 'http://192.168.1.5:9400', sources: ['local', 'mdns'] }),
            row({
                displayName: '服务器 prod',
                endpoint: 'http://srv.tailnet:9400',
                source: 'tailscale',
                sources: ['tailscale'],
            }),
        ]);
        const lines = text.split('\n');
        expect(lines[0]).toBe('发现到的 diy 实例：');
        expect(lines[1]).toContain('[1]');
        expect(lines[1]).toContain('c-mac 的 lab 实例');
        expect(lines[1]).toContain('http://192.168.1.5:9400');
        expect(lines[1]).toContain('(local + mdns)');
        expect(lines[2]).toContain('(tailscale)');
        expect(lines[3]).toContain('[3] 手动输入 URL...');
    });

    it('空结果也给一行提示（不返回空串）', () => {
        expect(formatDiscoveryList([])).toContain('没有发现任何 diy 实例');
    });

    it('可以不列手动输入项', () => {
        const text = formatDiscoveryList([row({})], { manualOption: false });
        expect(text).not.toContain('手动输入');
    });

    it('label 依次退化 displayName → id → endpoint', () => {
        expect(labelOf(row({ displayName: '名字' }))).toBe('名字');
        expect(labelOf(row({ displayName: null }))).toBe('diy-0000aaaa');
        expect(labelOf(row({ displayName: null, id: null }))).toBe('http://127.0.0.1:9400');
    });

    it('CJK 宽度按 2 列算（对齐用）', () => {
        expect(displayWidth('ab')).toBe(2);
        expect(displayWidth('中文')).toBe(4);
    });
});
