// manual 发现器：用户输入归一（补 scheme / 补端口），纯输入 → 纯候选。
import { describe, expect, it } from 'vitest';
import { manualCandidates, manualDiscoverer, normalizeManualInput } from '../src/discover/manual.js';

describe('normalizeManualInput', () => {
    it('host 补 scheme + 缺省端口', () => {
        expect(normalizeManualInput('192.168.1.5')).toBe('http://192.168.1.5:9400');
    });
    it('host:port 保留端口', () => {
        expect(normalizeManualInput('srv.tailnet:9500')).toBe('http://srv.tailnet:9500');
    });
    it('完整 URL 去尾部斜杠', () => {
        expect(normalizeManualInput('http://host.local:9400/')).toBe('http://host.local:9400');
    });
    it('空 / 非法 → null', () => {
        expect(normalizeManualInput('')).toBeNull();
        expect(normalizeManualInput('   ')).toBeNull();
        expect(normalizeManualInput('http://')).toBeNull();
    });
});

describe('manualDiscoverer', () => {
    it('每条输入给一条候选（id 未知，source=manual）', async () => {
        const items = await manualDiscoverer(['10.0.0.2', 'http://srv:9401']).discover();
        expect(items).toEqual([
            { id: null, displayName: null, endpoint: 'http://10.0.0.2:9400', source: 'manual' },
            { id: null, displayName: null, endpoint: 'http://srv:9401', source: 'manual' },
        ]);
    });
    it('非法的输入被跳过，不终止整批', () => {
        expect(manualCandidates(['', 'ok:9400'])).toHaveLength(1);
    });
});
