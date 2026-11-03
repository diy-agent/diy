// 判据 9：没有可信证书就明确报错，不静默降级成 http。
import { describe, expect, it } from 'vitest';
import { assertTransportSecurity, resolveTlsMaterial } from '../src/tls.js';
import { isHubError } from '../src/errors.js';

describe('传输安全', () => {
    it('没有证书 → tls/requires-trusted-cert', () => {
        expect(() => resolveTlsMaterial({ env: {} })).toThrow(/受信任的 HTTPS/);
        try {
            resolveTlsMaterial({ env: {} });
        } catch (e) {
            expect(isHubError(e, 'tls/requires-trusted-cert')).toBe(true);
        }
    });

    it('证书路径不存在也报错，不悄悄用明文', () => {
        expect(() => resolveTlsMaterial({ certPath: '/nope/cert.pem', keyPath: '/nope/key.pem', env: {} })).toThrow();
    });

    it('服务端守卫：无 tls 且未显式放行 → 拒绝启动', () => {
        expect(() => assertTransportSecurity(null, undefined)).toThrow(/受信任的 HTTPS/);
        expect(() => assertTransportSecurity(null, true)).not.toThrow();
    });
});
