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

    /**
     * 2026-11-05 用户裁：信任来自「门开在哪」，「放行参数」不算。
     * 这组用例就是那条判据的可执行版本。
     */
    it('可信网卡上允许明文（loopback / tailscale）', () => {
        for (const host of ['127.0.0.1', '::1', 'localhost', '127.0.0.5', '100.81.37.7', '100.64.0.1', 'fd7a:115c:a1e0::e438:2507']) {
            expect(() => assertTransportSecurity(null, host), host).not.toThrow();
        }
    });

    it('不可信网卡上必须 TLS（含 0.0.0.0 与局域网）', () => {
        for (const host of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.7', '8.8.8.8', 'example.com', '', undefined]) {
            expect(() => assertTransportSecurity(null, host), String(host)).toThrow(/受信任的 HTTPS/);
        }
    });

    it('有证书时任何地址都放行', () => {
        const tls = { cert: 'c', key: 'k' };
        expect(() => assertTransportSecurity(tls, '0.0.0.0')).not.toThrow();
    });

    it('100.64/10 的边界：100.63 与 100.128 不算 tailscale', () => {
        expect(() => assertTransportSecurity(null, '100.63.0.1')).toThrow();
        expect(() => assertTransportSecurity(null, '100.128.0.1')).toThrow();
        expect(() => assertTransportSecurity(null, '100.127.255.255')).not.toThrow();
    });
});
