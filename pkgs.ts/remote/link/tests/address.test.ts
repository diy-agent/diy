// 显示身份地址（##484）：`alice@c-mac/diy-chat.lab:9401?x=s&b=2`
//
// 判据（任务 body）：
//   2 `formatAddress` 单实例不带端口、多实例自动带
//   3 `parseAddress` 能反解（round-trip）
//   5 短名而非 `@diy-agent/app-chat`
import { describe, expect, it } from 'vitest';
import {
    addressGroupSize,
    addressOfPing,
    displayAddress,
    formatAddress,
    safeDisplayAddress,
    parseAddress,
    portOfEndpoint,
    shortAppName,
    tryFormatAddress,
    type InstanceAddress,
} from '../src/address.js';
import type { PingInfo } from '../src/types.js';

const base: InstanceAddress = { user: 'alice', host: 'c-mac', app: 'diy-chat', variant: 'lab' };

describe('formatAddress', () => {
    it('单实例形态（无端口、无属性）', () => {
        expect(formatAddress(base)).toBe('alice@c-mac/diy-chat.lab');
    });

    it('带端口与属性', () => {
        expect(formatAddress({ ...base, port: 9401, attrs: { x: 's', b: '2' } })).toBe(
            'alice@c-mac/diy-chat.lab:9401?x=s&b=2',
        );
    });

    it('属性值里的特殊字符转义（& = 空白 中文）', () => {
        expect(formatAddress({ ...base, attrs: { q: 'a&b=c d', 中文: '值' } })).toBe(
            `alice@c-mac/diy-chat.lab?q=${encodeURIComponent('a&b=c d')}&${encodeURIComponent('中文')}=${encodeURIComponent('值')}`,
        );
    });

    it('段里有保留字符 ⇒ 抛（宁可报错，也不排出反解不回来的地址）', () => {
        expect(() => formatAddress({ ...base, host: 'c/mac' })).toThrow(TypeError);
        expect(() => formatAddress({ ...base, app: 'diy.chat' })).toThrow(TypeError);
        expect(() => formatAddress({ ...base, user: '' })).toThrow(TypeError);
        expect(() => formatAddress({ ...base, port: 70000 })).toThrow(TypeError);
    });

    it('tryFormatAddress 不抛：拼不出来给 null（UI 退回显示名）', () => {
        expect(tryFormatAddress(base)).toBe('alice@c-mac/diy-chat.lab');
        expect(tryFormatAddress({ ...base, host: 'c mac' })).toBeNull();
    });

    it('机器名里的点属于 host（反解仍成立）', () => {
        const addr = { ...base, host: 'c-mac.local' };
        expect(formatAddress(addr)).toBe('alice@c-mac.local/diy-chat.lab');
        expect(parseAddress(formatAddress(addr))).toEqual(addr);
    });
});

describe('parseAddress（round-trip）', () => {
    it('反解任务 body 里的样例', () => {
        expect(parseAddress('alice@c-mac/diy-chat.lab:9401?x=s&b=2')).toEqual({
            user: 'alice',
            host: 'c-mac',
            app: 'diy-chat',
            variant: 'lab',
            port: 9401,
            attrs: { x: 's', b: '2' },
        });
    });

    it('format → parse → 与原对象逐字段相等', () => {
        const cases: InstanceAddress[] = [
            base,
            { ...base, port: 9402 },
            { ...base, attrs: { x: 's', b: '2' } },
            { ...base, host: 'c-mac.local', variant: 'test', port: 18888, attrs: { q: 'a&b=c d', 中文: '值' } },
        ];
        for (const addr of cases) expect(parseAddress(formatAddress(addr))).toEqual(addr);
    });

    it('不是地址 ⇒ null（宽松，不抛）', () => {
        for (const text of [
            '',
            'alice',
            'alice@c-mac',
            'alice@c-mac/diy-chat',
            'alice@c-mac/diy-chat.lab:0',
            'alice@c-mac/diy-chat.lab:99999',
            'alice@c-mac/diy-chat.lab?%=1',
            'http://127.0.0.1:9401',
        ]) {
            expect(parseAddress(text), text).toBeNull();
        }
    });

    it('两端空白无所谓', () => {
        expect(parseAddress('  alice@c-mac/diy-chat.lab  ')).toEqual(base);
    });
});

describe('shortAppName', () => {
    it('去 scope 与 app- 前缀（地址栏里 @diy-agent/app-chat 太长）', () => {
        expect(shortAppName('@diy-agent/app-chat')).toBe('diy-chat');
        expect(shortAppName('@diy-agent/app')).toBe('diy');
        expect(shortAppName('@diy-agent/app-minimal')).toBe('diy-minimal');
    });

    it('已经短的原样（video / quant / mini 这类独立 app）', () => {
        expect(shortAppName('video')).toBe('video');
        expect(shortAppName('@diy-agent/quant')).toBe('quant');
        expect(shortAppName('')).toBe('diy');
    });
});

describe('displayAddress（端口只在冲突时带）', () => {
    it('单实例：不带端口', () => {
        expect(displayAddress({ ...base, port: 9401 })).toBe('alice@c-mac/diy-chat.lab');
        expect(displayAddress({ ...base, port: 9401 }, [])).toBe('alice@c-mac/diy-chat.lab');
    });

    it('同 app+variant 有第二个实例 ⇒ 带端口（端口是连接的实际信息）', () => {
        const peer = { ...base, port: 9402 };
        expect(displayAddress({ ...base, port: 9401 }, [peer])).toBe('alice@c-mac/diy-chat.lab:9401');
        expect(displayAddress(peer, [{ ...base, port: 9401 }])).toBe('alice@c-mac/diy-chat.lab:9402');
    });

    it('不同 variant / 不同 app / 不同机器 / 不同用户都不算冲突', () => {
        const peers: InstanceAddress[] = [
            { ...base, variant: 'test', port: 9402 },
            { ...base, app: 'video', port: 9403 },
            { ...base, host: 'other-mac', port: 9404 },
            { ...base, user: 'bob', port: 9405 },
        ];
        expect(displayAddress({ ...base, port: 9401 }, peers)).toBe('alice@c-mac/diy-chat.lab');
        expect(addressGroupSize(base, peers)).toBe(1);
    });

    it('显示名含保留字符时不抛：退回 user@host（横条不能因为一个怪名字崩掉）', () => {
        expect(safeDisplayAddress({ ...base, host: 'c/mac' })).toBe('alice@c/mac');
        expect(safeDisplayAddress(base)).toBe('alice@c-mac/diy-chat.lab');
    });

    it('冲突但拿不到端口 ⇒ 只能不带（地址照样可读）', () => {
        expect(displayAddress(base, [{ ...base, port: 9402 }])).toBe('alice@c-mac/diy-chat.lab');
    });
});

describe('portOfEndpoint / addressOfPing', () => {
    it('从 endpoint 取端口', () => {
        expect(portOfEndpoint('http://127.0.0.1:9401')).toBe(9401);
        expect(portOfEndpoint('http://c-mac.local')).toBeNull();
        expect(portOfEndpoint('不是 URL')).toBeNull();
    });

    it('/ping 载荷 + endpoint → 地址', () => {
        const info: PingInfo = {
            id: 'diy-abcdef12',
            displayName: 'c-mac',
            app: 'diy-chat',
            variant: 'lab',
            version: '0.1.0',
            pid: 42,
            startedAt: '2026-10-31T00:00:00.000Z',
            uptimeMs: 1000,
        };
        expect(addressOfPing(info, 'http://127.0.0.1:9401', { user: 'alice' })).toEqual({ ...base, port: 9401 });
        expect(displayAddress(addressOfPing(info, 'http://127.0.0.1:9401', { user: 'alice' }))).toBe(
            'alice@c-mac/diy-chat.lab',
        );
    });
});
