// errors.test.ts —— 网络 / 网关错误要变成人能读的一句话。

import { describe, expect, it } from 'vitest';

import { friendlyError } from '../src/errors';

describe('friendlyError', () => {
    it('连接超时：指出主机，提示检查网络', () => {
        const error = new Error(
            'Cannot connect to API: Connect Timeout Error (attempted address: opencode.ai:443, timeout: 10000ms)',
        );
        expect(friendlyError(error)).toContain('连不上 opencode.ai:443');
        expect(friendlyError(error)).toContain('检查网络');
    });

    it('DNS / 连接被拒', () => {
        expect(friendlyError(new Error('fetch failed'))).toContain('网络请求失败');
        expect(friendlyError(new Error('getaddrinfo ENOTFOUND api.example.com'))).toContain('网络请求失败');
    });

    it('key 无效与限流', () => {
        expect(friendlyError(new Error('401 Unauthorized'))).toContain('API key');
        expect(friendlyError(new Error('429 rate limit exceeded'))).toContain('限流');
        expect(friendlyError(new Error('502 Bad Gateway'))).toContain('502');
    });

    // 2026-11-25：一轮 turn 撞 OpenCode Go 月度额度，界面上只说「限流（429），稍后重试」——
    // 而网关明明给了 retry-after / reset 时长。额度满要认成「额度」并抄出重置时间。
    it('额度用尽：说出来，并把网关给的重置时间抄进话术', () => {
        const error = new Error(
            'OpenCode Go usage limit reached (monthly, resets in 2h 31m). To keep going now, turn on Extra Usage.',
        );
        const text = friendlyError(error);
        expect(text).toContain('额度已用尽');
        expect(text).toContain('2h 31m');
        expect(text).not.toContain('限流');
    });

    it('额度用尽但没有重置时间：不编造时长', () => {
        const text = friendlyError(new Error('insufficient_quota: quota exceeded'));
        expect(text).toContain('额度已用尽');
        expect(text).not.toContain('后重置');
    });

    it('认不出来就保留第一行原文（不丢诊断信息）', () => {
        expect(friendlyError(new Error('tool exploded\nstack line 1\nstack line 2'))).toBe('tool exploded');
    });
});
