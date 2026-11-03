// 判据 1：6 位 Base32。
import { describe, expect, it } from 'vitest';
import { formatInviteCode, generateInviteCode, isInviteCodeShape, normalizeInviteCode } from '../src/code.js';
import { isHubError } from '../src/errors.js';

describe('邀请码形态', () => {
    it('生成 6 位、只用 Crockford Base32（无 I/L/O/U）', () => {
        for (let i = 0; i < 200; i++) {
            const code = generateInviteCode();
            expect(code).toHaveLength(6);
            expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
            expect(isInviteCodeShape(code)).toBe(true);
        }
    });

    it('可复现（注入随机源）', () => {
        const code = generateInviteCode(() => Buffer.from([0, 1, 2, 3, 4, 5]));
        expect(code).toBe('012345');
    });

    it('归一：小写 / 分隔符 / 空格都认，非法形态明确报错', () => {
        expect(normalizeInviteCode(' 7k9m-q2 ')).toBe('7K9MQ2');
        expect(normalizeInviteCode('7K9M Q2')).toBe('7K9MQ2');
        expect(() => normalizeInviteCode('7K9M')).toThrow();
        expect(() => normalizeInviteCode('7K9M-QI')).toThrow(); // I 不在字母表
        try {
            normalizeInviteCode('bad');
        } catch (e) {
            expect(isHubError(e, 'hub/bad-input')).toBe(true);
        }
    });

    it('显示形态 7K9M-Q2', () => {
        expect(formatInviteCode('7k9mq2')).toBe('7K9M-Q2');
    });
});
