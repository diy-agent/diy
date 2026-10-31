// auth.test.ts — 授权内核的两条铁律，钉在纯函数上（不起服务、不碰网络）。
//
// ① token 由副方生成：`approve()` 是唯一的签发点 —— status 在确认前给不出 token，
//    确认后才给出，而且**不存在**任何「把主方给的值登记成 token」的入口。
// ② revoke 之后不认：verify 一律 null（客户端据此回未连接），且「记住」不等于绕过确认。

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authStorePath, createAuth, DEFAULT_TTL_HOURS, emptyAuthState, openAuthStore } from '../auth.js';
import { codeOf } from './helpers.js';

/** 确定性 deps：时间可推进、id / token 可预测 */
function makeDeps() {
    let clock = Date.parse('2026-10-31T00:00:00.000Z');
    let seq = 0;
    return {
        now: () => new Date(clock),
        newId: () => `id-${++seq}`,
        newToken: () => `tok-${++seq}`,
        advance(ms: number): void {
            clock += ms;
        },
    };
}

describe('单向授权内核', () => {
    it('①确认前拿不到 token，确认后拿到的 token 是副方生成的', () => {
        const auth = createAuth(emptyAuthState(), makeDeps());
        const { requestId } = auth.request({ subject: 'alice@c-mac/diy-chat.lab' });

        const before = auth.status(requestId);
        expect(before.status).toBe('pending');
        expect(before.token).toBeNull();

        const approved = auth.approve(requestId);
        expect(approved.token).toMatch(/^tok-/);
        expect(auth.status(requestId).token).toBe(approved.token);
        expect(auth.verify(approved.token)?.subject).toBe('alice@c-mac/diy-chat.lab');
    });

    it('①主方自签的 token 一律不认（内核里没有登记外部 token 的入口）', () => {
        const auth = createAuth(emptyAuthState(), makeDeps());
        auth.request({ subject: 'alice@c-mac/diy-chat.lab' });
        // 主方自己编一个：verify 必须拒
        expect(auth.verify('diyweb_我自己签的')).toBeNull();
        expect(auth.verify('')).toBeNull();
    });

    it('②revoke 之后 verify 一律 null，且同一 subject 必须重新确认才能拿新 token', () => {
        const deps = makeDeps();
        const auth = createAuth(emptyAuthState(), deps);
        const { requestId } = auth.request({ subject: 'alice@c-mac' });
        const { token } = auth.approve(requestId);
        expect(auth.verify(token)).not.toBeNull();

        expect(auth.revoke({ token })).toEqual({ revoked: 1 });
        expect(auth.verify(token)).toBeNull();

        // 「记住」≠「绕过确认」：重连还得走一遍 request + approve
        const again = auth.request({ subject: 'alice@c-mac' });
        expect(again.status).toBe('pending');
        expect(auth.status(again.requestId).token).toBeNull();
    });

    it('②过期即失效（缺省 8h），撤销是单向置位', () => {
        const deps = makeDeps();
        const auth = createAuth(emptyAuthState(), deps);
        const { requestId } = auth.request({ subject: 'alice@c-mac' });
        const { token } = auth.approve(requestId, DEFAULT_TTL_HOURS);

        deps.advance((DEFAULT_TTL_HOURS - 0.01) * 3600_000);
        expect(auth.verify(token)).not.toBeNull();
        deps.advance(0.02 * 3600_000);
        expect(auth.verify(token)).toBeNull();

        // 过期之后再 revoke：不重复计数（已撤销的不会再被算一次）
        expect(auth.revoke({ token })).toEqual({ revoked: 1 });
        expect(auth.revoke({ token })).toEqual({ revoked: 0 });
    });

    it('拒绝之后不能补确认（FAILED_PRECONDITION）', () => {
        const auth = createAuth(emptyAuthState(), makeDeps());
        const { requestId } = auth.request({ subject: 'alice@c-mac' });
        auth.deny(requestId);
        expect(auth.status(requestId).status).toBe('denied');
        expect(() => auth.approve(requestId)).toThrowError(/已经是 denied/);
        try {
            auth.approve(requestId);
        } catch (error) {
            expect(codeOf(error)).toBe('FAILED_PRECONDITION');
        }
    });

    it('同一 subject 连点两次只生成一条待确认请求（不会堆一串）', () => {
        const auth = createAuth(emptyAuthState(), makeDeps());
        const first = auth.request({ subject: 'alice@c-mac' });
        const second = auth.request({ subject: 'alice@c-mac' });
        expect(second.requestId).toBe(first.requestId);
        expect(auth.pending()).toHaveLength(1);
    });

    it('revoke all 只撤销未撤销的那些', () => {
        const auth = createAuth(emptyAuthState(), makeDeps());
        const a = auth.approve(auth.request({ subject: 'a@x' }).requestId);
        const b = auth.approve(auth.request({ subject: 'b@x' }).requestId);
        expect(auth.revoke({ token: a.token })).toEqual({ revoked: 1 });
        expect(auth.revoke({ all: true })).toEqual({ revoked: 1 });
        expect(auth.verify(a.token)).toBeNull();
        expect(auth.verify(b.token)).toBeNull();
    });
});

describe('授权 store 落盘（判据 7：token 在 store 里，重启仍在）', () => {
    it('写盘 → 重开 → token 仍有效；文件权限 0600', async () => {
        const home = mkdtempSync(join(tmpdir(), 'app-web-auth-'));
        const file = authStorePath(home);
        const deps = makeDeps();

        const first = await openAuthStore(file, deps);
        const { requestId } = first.request({ subject: 'alice@c-mac' });
        const { token } = first.approve(requestId);
        // 落盘是异步链：等它写完（同一个 tick 之后读得到）
        await new Promise((done) => setTimeout(done, 50));

        const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'));
        expect(JSON.stringify(raw)).toContain(token);
        expect(statSync(file).mode & 0o777).toBe(0o600);

        // 「重启」= 重新 open
        const second = await openAuthStore(file, deps);
        expect(second.verify(token)?.subject).toBe('alice@c-mac');

        // 撤销也要落盘：再开一次就没有了
        second.revoke({ token });
        await new Promise((done) => setTimeout(done, 50));
        const third = await openAuthStore(file, makeDeps());
        expect(third.verify(token)).toBeNull();
    });

    it('缺文件 / 坏 JSON 都按空态起（不因为一个坏文件起不来）', async () => {
        const home = mkdtempSync(join(tmpdir(), 'app-web-auth-'));
        chmodSync(home, 0o755);
        const file = authStorePath(home);

        // ① 缺文件
        const missing = await openAuthStore(file, makeDeps());
        expect(missing.tokens()).toEqual([]);
        expect(() => missing.status('nope')).toThrowError(/没有这条连接请求/);

        // ② 坏 JSON：不抛，按空态起
        mkdirSync(join(home, 'web'), { recursive: true });
        writeFileSync(file, '{ 这不是 JSON', 'utf-8');
        const broken = await openAuthStore(file, makeDeps());
        expect(broken.tokens()).toEqual([]);
    });
});
