// 显示身份地址（##484）：本壳的副本 vs `@diy-agent/remote` 的真源。
//
// 为什么有这份：横条要显示 `alice@c-mac/diy-chat.lab`，而本壳刻意不在**运行期**依赖
// `@diy-agent/remote`（见 discover.ts 头注：包不在也要能独立跑），于是纯函数抄了一份。
// 抄的代价是可能走样 —— 所以这里逐例对拍：改了一边没改另一边，这条测试就红。
import { describe, expect, it } from 'vitest';
import * as remote from '@diy-agent/remote';
import {
    addressOf,
    displayAddress,
    displayAddresses,
    formatAddress,
    parseAddress,
    portOfEndpoint,
    safeDisplayAddress,
    type AddressSource,
    type InstanceAddress,
} from '../index.js';

const base: InstanceAddress = { user: 'alice', host: 'c-mac', app: 'diy-chat', variant: 'lab' };

/** 对拍用的样例（含端口 / 属性 / 中文 / 需要转义的字符） */
const CASES: InstanceAddress[] = [
    base,
    { ...base, port: 9401 },
    { ...base, attrs: { x: 's', b: '2' } },
    { ...base, host: 'c-mac.local', variant: 'test', port: 18888, attrs: { q: 'a&b=c d', 中文: '值' } },
];

describe('与 @diy-agent/remote 的实现对拍', () => {
    it('formatAddress 逐例相同', () => {
        for (const addr of CASES) expect(formatAddress(addr)).toBe(remote.formatAddress(addr));
    });

    it('parseAddress 逐例相同（含非法输入）', () => {
        const texts = [
            ...CASES.map((addr) => remote.formatAddress(addr)),
            '',
            'alice',
            'alice@c-mac/diy-chat',
            'alice@c-mac/diy-chat.lab:0',
            'alice@c-mac/diy-chat.lab:99999',
            'alice@c-mac/diy-chat.lab?%=1',
            'http://127.0.0.1:9401',
        ];
        for (const text of texts) expect(parseAddress(text), text).toEqual(remote.parseAddress(text));
    });

    it('displayAddress / safeDisplayAddress 逐例相同（单实例 vs 同格多实例）', () => {
        const peers = [
            { ...base, port: 9402 },
            { ...base, variant: 'test' },
        ];
        for (const addr of CASES) {
            expect(displayAddress(addr, peers)).toBe(remote.displayAddress(addr, peers));
            expect(displayAddress(addr, [])).toBe(remote.displayAddress(addr, []));
            const odd = { ...addr, host: 'c/mac' };
            expect(safeDisplayAddress(odd, peers)).toBe(remote.safeDisplayAddress(odd, peers));
        }
    });

    it('portOfEndpoint 逐例相同', () => {
        for (const endpoint of ['http://127.0.0.1:9401', 'http://c-mac.local', '不是 URL', 'https://h:443']) {
            expect(portOfEndpoint(endpoint), endpoint).toBe(remote.portOfEndpoint(endpoint));
        }
    });
});

describe('地址组装（横条实际用的那条路）', () => {
    const source = (overrides: Partial<AddressSource> = {}): AddressSource => ({
        endpoint: 'http://127.0.0.1:9401',
        displayName: 'c-mac',
        app: 'diy-chat',
        variant: 'lab',
        ...overrides,
    });

    it('缺 app / variant / 显示名 ⇒ 不造地址（宁可只显示名字）', () => {
        expect(addressOf(source(), 'alice')).toEqual({ ...base, port: 9401 });
        expect(addressOf(source({ app: null }), 'alice')).toBeNull();
        expect(addressOf(source({ variant: null }), 'alice')).toBeNull();
        expect(addressOf(source({ displayName: null }), 'alice')).toBeNull();
    });

    it('一组实例：单实例不带端口，同格多实例带端口（判据 2）', () => {
        const single = displayAddresses([source()], 'alice');
        expect(single.get('http://127.0.0.1:9401')).toBe('alice@c-mac/diy-chat.lab');

        const both = displayAddresses([source(), source({ endpoint: 'http://127.0.0.1:9402' })], 'alice');
        expect(both.get('http://127.0.0.1:9401')).toBe('alice@c-mac/diy-chat.lab:9401');
        expect(both.get('http://127.0.0.1:9402')).toBe('alice@c-mac/diy-chat.lab:9402');
    });

    it('不同 variant 的两个实例互不冲突（各自不带端口）', () => {
        const map = displayAddresses(
            [source(), source({ endpoint: 'http://127.0.0.1:9402', variant: 'test' })],
            'alice',
        );
        expect(map.get('http://127.0.0.1:9401')).toBe('alice@c-mac/diy-chat.lab');
        expect(map.get('http://127.0.0.1:9402')).toBe('alice@c-mac/diy-chat.test');
    });

    it('身份还没 ping 到的那行给 null（横条退回显示名 / endpoint）', () => {
        const map = displayAddresses([source(), source({ endpoint: 'http://127.0.0.1:9500', app: null })], 'alice');
        expect(map.get('http://127.0.0.1:9500')).toBeNull();
        // 它不参与冲突判定（拿不到 app 就分不清是不是同格）
        expect(map.get('http://127.0.0.1:9401')).toBe('alice@c-mac/diy-chat.lab');
    });
});
