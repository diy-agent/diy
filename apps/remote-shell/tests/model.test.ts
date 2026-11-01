import { describe, expect, it } from 'vitest';
import {
    BAR_HEIGHT,
    buildTabs,
    displayNameOf,
    hostOf,
    mergeCandidates,
    normalizeEndpoint,
    originOf,
    parseCliArgs,
    parseEndpointList,
    pingUrl,
    rectsOverlap,
    shortAddress,
    sourceRank,
    tabDot,
    tabStatusLabel,
    withBadge,
    type CurrentInstance,
    type DiscoveredInstance,
    type TabSource,
} from '../index.js';

function instance(overrides: Partial<DiscoveredInstance> = {}): DiscoveredInstance {
    return { id: null, displayName: null, endpoint: 'http://127.0.0.1:9400', source: 'manual', ...overrides };
}

describe('endpoint 归一化', () => {
    it('补 http://、去末尾斜杠，但保留路径（手输的 /app 也是合法基址）', () => {
        expect(normalizeEndpoint('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
        expect(normalizeEndpoint('http://host:9400///')).toBe('http://host:9400');
        expect(normalizeEndpoint('  https://host:8443/app/ ')).toBe('https://host:8443/app');
        expect(normalizeEndpoint('')).toBe('');
    });

    it('探活只取 origin：手输带路径时不把 /ping 拼到路径后面', () => {
        expect(originOf('https://host:8443/app')).toBe('https://host:8443');
        expect(pingUrl('https://host:8443/app')).toBe('https://host:8443/ping');
    });
});

describe('显示名', () => {
    it('自报优先，其次 host，永远不空', () => {
        expect(displayNameOf({ displayName: 'c-mac 的 lab', endpoint: 'http://a:9400' })).toBe('c-mac 的 lab');
        expect(displayNameOf({ displayName: '   ', endpoint: 'http://a:9400' })).toBe('a:9400');
        expect(displayNameOf({ displayName: null, endpoint: '不是-url' })).toBe('不是-url');
    });
});

describe('多源合并', () => {
    it('同一 id 的两路发现合并成一行，sources 按优先级排序', () => {
        const merged = mergeCandidates([
            instance({ id: 'diy-1', displayName: 'c-mac', endpoint: 'http://10.0.0.5:9400', source: 'mdns' }),
            instance({ id: 'diy-1', displayName: null, endpoint: 'http://10.0.0.5:9400', source: 'local' }),
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0]?.sources).toEqual(['local', 'mdns']);
        expect(merged[0]?.displayName).toBe('c-mac');
    });

    it('manual 排最高：同一台手输的 endpoint 覆盖自动发现', () => {
        expect(sourceRank('manual')).toBeLessThan(sourceRank('mdns'));
        const merged = mergeCandidates([
            instance({ id: 'diy-1', endpoint: 'http://a.tailnet:9400', source: 'tailscale' }),
            instance({ id: 'diy-1', endpoint: 'http://127.0.0.1:9400', source: 'manual' }),
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0]?.endpoint).toBe('http://127.0.0.1:9400');
        expect(merged[0]?.source).toBe('manual');
    });

    it('没有 id 时按 endpoint 去重；空 endpoint 丢弃', () => {
        const merged = mergeCandidates([
            instance({ endpoint: 'http://a:9400/' }),
            instance({ endpoint: 'http://a:9400', source: 'local' }),
            instance({ endpoint: '   ' }),
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0]?.sources).toEqual(['manual', 'local']);
    });

    it('排序：来源优先级在前，显示名在后', () => {
        const merged = mergeCandidates([
            instance({ endpoint: 'http://z:9400', source: 'mdns', displayName: 'z' }),
            instance({ endpoint: 'http://a:9400', source: 'local', displayName: 'a' }),
            instance({ endpoint: 'http://m:9400', source: 'manual', displayName: 'm' }),
        ]);
        expect(merged.map((item) => item.source)).toEqual(['manual', 'local', 'mdns']);
    });
});

describe('CLI 参数', () => {
    it('认 --url / --width / --height（含 = 形式），其余开关忽略（Chromium 自己的不能当错）', () => {
        const args = parseCliArgs([
            '--url',
            '127.0.0.1:8080',
            '--remote-debugging-port=9222',
            '--width=1440',
            '--height',
            '900',
            '--no-sandbox',
        ]);
        expect(args).toEqual({ url: 'http://127.0.0.1:8080', width: 1440, height: 900 });
    });

    it('没有 --url 时 url 为 null（停在占位页）；坏数字不覆盖缺省', () => {
        expect(parseCliArgs(['--width', 'abc']).url).toBeNull();
        expect(parseCliArgs(['--width', 'abc']).width).toBeGreaterThan(0);
    });

    it('DIY_REMOTE_ENDPOINTS 这类逗号列表 → manual 候选，逐个归一化', () => {
        const items = parseEndpointList(' a:1, http://b:2 ,, ');
        expect(items.map((item) => item.endpoint)).toEqual(['http://a:1', 'http://b:2']);
        expect(items.every((item) => item.source === 'manual')).toBe(true);
        expect(parseEndpointList(undefined)).toEqual([]);
    });
});

describe('横条几何', () => {
    it('BAR_HEIGHT 是壳的常量（页面区从它开始）', () => {
        expect(BAR_HEIGHT).toBe(32);
    });

    it('贴边不算重叠；真重叠才算', () => {
        const bar = { x: 0, y: 0, width: 100, height: 32 };
        expect(rectsOverlap(bar, { x: 0, y: 32, width: 100, height: 100 })).toBe(false);
        expect(rectsOverlap(bar, { x: 0, y: 31, width: 100, height: 100 })).toBe(true);
        expect(rectsOverlap(bar, { x: 0, y: 0, width: 0, height: 0 })).toBe(false);
    });

    it('状态 → 圆点 / 文案（横条只显示，不判断）', () => {
        const current = (status: 'connected' | 'disconnected' | 'connecting'): CurrentInstance => ({
            endpoint: 'http://a',
            displayName: 'a',
            address: 'alice@a/diy.lab',
            status,
        });
        expect(withBadge(current('connected'))).toMatchObject({ dot: '●', label: '已连' });
        expect(withBadge(current('disconnected')).dot).toBe('⚠');
        expect(withBadge(current('connecting')).label).toBe('连接中');
    });
});

describe('横条 tab（##493）', () => {
    const tab = (overrides: Partial<TabSource> = {}): TabSource => ({
        endpoint: 'http://127.0.0.1:9400',
        displayName: 'c-mac',
        address: 'alice@c-mac/diy-web.lab',
        status: 'connected',
        ...overrides,
    });

    it('状态点三态：● 已连 / ⚠ 连接中或断线 / ○ 未连', () => {
        expect(tabDot('connected')).toBe('●');
        expect(tabDot('connecting')).toBe('⚠');
        expect(tabDot('disconnected')).toBe('⚠');
        expect(tabDot('idle')).toBe('○');
        expect(tabStatusLabel('idle')).toBe('未连');
        expect(tabStatusLabel('connecting')).toBe('连接中');
    });

    it('同 host ⇒ 只显示 app.variant（省略 user@host）', () => {
        const tabs = buildTabs(
            [
                tab({ endpoint: 'http://a:9400', address: 'alice@c-mac/diy-web.lab' }),
                tab({ endpoint: 'http://b:9400', address: 'alice@c-mac/diy.prod', status: 'idle' }),
            ],
            'http://a:9400',
        );
        expect(tabs.map((item) => item.label)).toEqual(['diy-web.lab', 'diy.prod']);
        // 悬停永远是全名
        expect(tabs[0]?.title.startsWith('alice@c-mac/diy-web.lab · http://a:9400')).toBe(true);
        // 当前只高亮一个
        expect(tabs.map((item) => item.active)).toEqual([true, false]);
        expect(tabs.map((item) => item.dot)).toEqual(['●', '○']);
    });

    it('不同 host ⇒ 整组回到全名（短名会分不清是哪台机器）', () => {
        const tabs = buildTabs(
            [
                tab({ endpoint: 'http://a:9400', address: 'alice@c-mac/diy-web.lab' }),
                tab({ endpoint: 'http://b:9400', address: 'bob@other/diy-web.lab', status: 'idle' }),
            ],
            'http://b:9400',
        );
        expect(tabs.map((item) => item.label)).toEqual(['alice@c-mac/diy-web.lab', 'bob@other/diy-web.lab']);
        expect(tabs.map((item) => item.active)).toEqual([false, true]);
    });

    it('同格多实例带的端口留在标签里（否则两个 tab 同名）', () => {
        const tabs = buildTabs(
            [
                tab({ endpoint: 'http://a:9401', address: 'alice@c-mac/diy-web.lab:9401' }),
                tab({ endpoint: 'http://b:9402', address: 'alice@c-mac/diy-web.lab:9402', status: 'idle' }),
            ],
            'http://a:9401',
        );
        expect(tabs.map((item) => item.label)).toEqual(['diy-web.lab:9401', 'diy-web.lab:9402']);
    });

    it('拿不到地址（身份还没 ping 到）⇒ 退回显示名，不编地址', () => {
        const tabs = buildTabs(
            [tab({ endpoint: 'http://127.0.0.1:9400', displayName: 'c-mac', address: null, status: 'connecting' })],
            null,
        );
        expect(tabs[0]?.label).toBe('c-mac');
        expect(tabs[0]?.title).toContain('http://127.0.0.1:9400');
        expect(tabs[0]?.active).toBe(false);
        expect(tabs[0]?.dot).toBe('⚠');
    });

    it('来源进悬停提示（排查「这行是哪发现的」）', () => {
        const tabs = buildTabs([tab({ sources: ['manual', 'local'] })], 'http://127.0.0.1:9400');
        expect(tabs[0]?.title).toContain('（manual + local）');
    });

    it('地址解析的两个小工具', () => {
        expect(hostOf('alice@c-mac/diy-web.lab')).toBe('c-mac');
        expect(hostOf(null)).toBeNull();
        expect(hostOf('不是地址')).toBeNull();
        expect(shortAddress('alice@c-mac/diy-web.lab:9401')).toBe('diy-web.lab:9401');
        expect(shortAddress('c-mac')).toBe('c-mac');
    });
});
