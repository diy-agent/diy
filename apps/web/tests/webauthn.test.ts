// webauthn.test.ts — ##496 的判据：注册 → 登录 → counter 更新 → 重复注册被拒。
//
// 两层：
//   · 内核层（createWebAuthn）：确定性时钟，直接喂虚拟 authenticator 造的响应 ——
//     challenge 一次性 / TTL、counter 更新、会话有效期、落盘只有公钥，都在这里钉死；
//   · HTTP 层（真起服务）：/webauthn/* 的路由、Set-Cookie 的属性、以及**用 cookie 连 WS 进业务面**
//     （Passkey 会话与旧式 token 并存的那条接缝）。

import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { ChannelClientBinding, createTypedClient } from '@diy-agent/rpc';
import { WsTransport } from '@diy-agent/rpc/ws';
import { webApi } from '../api.js';
import { startWebServer, type WebServerHandle } from '../server.js';
import {
    CHALLENGE_TTL_MS,
    createWebAuthn,
    contextFromRequest,
    defaultUsername,
    emptyWebAuthnStore,
    openWebAuthnStore,
    parseCookies,
    sessionCookie,
    SESSION_COOKIE,
    SESSION_TTL_MS,
    webauthnStorePath,
    type WebAuthnContext,
} from '../webauthn.js';
import { makeFakeLlm, makeHome, makeStaticDir } from './helpers.js';
import { createVirtualAuthenticator } from './virtual-authenticator.js';

const CTX: WebAuthnContext = { rpID: 'c-mac.gute-fish.ts.net', origin: 'https://c-mac.gute-fish.ts.net' };

/** 确定性时钟 + 确定性 id（判据要能「拨表」） */
function makeCore(startAt = Date.parse('2026-11-01T00:00:00.000Z')) {
    let now = startAt;
    const core = createWebAuthn(emptyWebAuthnStore(), {
        now: () => now,
        newId: () => randomUUID(),
    });
    return { core, advance: (ms: number) => (now += ms) };
}

async function register(core: ReturnType<typeof makeCore>['core']) {
    const device = createVirtualAuthenticator();
    const { options } = await core.registrationOptions({ context: CTX, displayName: '大王' });
    const created = await core.verifyRegistration({
        context: CTX,
        response: device.register({ options, origin: CTX.origin, rpID: CTX.rpID }),
    });
    return { device, created };
}

describe('Passkey 内核（判据 1/2/3/5/6/7）', () => {
    it('注册 → 登录 → counter 递增 → 重复注册被拒', async () => {
        const { core } = makeCore();
        expect(core.hasUser()).toBe(false);

        const { device, created } = await register(core);
        // 用户名不写死 'owner'（会原样显示在系统钥匙串里）：缺省 = 系统用户名
        expect(created.user.username).toBe(defaultUsername());
        expect(created.user.username).not.toBe('owner');
        expect(created.user.displayName).toBe('大王');
        expect(created.user.id.startsWith('usr_')).toBe(true);
        // 判据 7 的一半：落盘只有公钥（这里先看内存态里存的是什么）
        const stored = core.store();
        expect(stored.credentials).toHaveLength(1);
        expect(stored.credentials[0]?.publicKey.length).toBeGreaterThan(0);
        expect(stored.credentials[0]?.counter).toBe(0);

        // 判据 3：已有主用户 ⇒ 再要注册参数就被拒
        await expect(core.registrationOptions({ context: CTX })).rejects.toThrow(/已存在主用户/);

        // 登录（发现式：allowCredentials 必须留空）
        const { options } = await core.authenticationOptions({ context: CTX });
        expect(options.allowCredentials).toEqual([]);
        expect(options.userVerification).toBe('required');
        const login = await core.verifyAuthentication({
            context: CTX,
            response: device.authenticate({ options, origin: CTX.origin, rpID: CTX.rpID }),
        });
        expect(login.user.id).toBe(created.user.id);
        // 判据 5/6：会话立刻可用
        expect(core.userOfSession(login.sessionId)?.id).toBe(created.user.id);

        // 关键点 7：counter 必须更新（设备自己说 1，服务端要记成 1）
        expect(core.store().credentials[0]?.counter).toBe(1);

        // 再登一次 → 2（不是一直停在第一次的值）
        const again = await core.authenticationOptions({ context: CTX });
        await core.verifyAuthentication({
            context: CTX,
            response: device.authenticate({ options: again.options, origin: CTX.origin, rpID: CTX.rpID }),
        });
        expect(core.store().credentials[0]?.counter).toBe(2);
    });

    it('challenge 一次性：同一个登录响应重放 ⇒ 被拒', async () => {
        const { core } = makeCore();
        const { device } = await register(core);
        const { options } = await core.authenticationOptions({ context: CTX });
        const response = device.authenticate({ options, origin: CTX.origin, rpID: CTX.rpID });

        await core.verifyAuthentication({ context: CTX, response });
        await expect(core.verifyAuthentication({ context: CTX, response })).rejects.toThrow(/已被用过|不认识/);
    });

    it('challenge 5 分钟后失效（TTL 是硬线，不是「大概」）', async () => {
        const { core, advance } = makeCore();
        const { device } = await register(core);
        const { options } = await core.authenticationOptions({ context: CTX });
        // 设备先把响应造出来（签名是即时的），只是「交回服务端」拖过了 TTL
        const response = device.authenticate({ options, origin: CTX.origin, rpID: CTX.rpID });
        advance(CHALLENGE_TTL_MS + 1);
        await expect(core.verifyAuthentication({ context: CTX, response })).rejects.toThrow(/过期/);
    });

    it('会话 7 天后失效；登出立即失效', async () => {
        const { core, advance } = makeCore();
        const { device } = await register(core);
        const { options } = await core.authenticationOptions({ context: CTX });
        const login = await core.verifyAuthentication({
            context: CTX,
            response: device.authenticate({ options, origin: CTX.origin, rpID: CTX.rpID }),
        });

        advance(SESSION_TTL_MS - 1000);
        expect(core.userOfSession(login.sessionId)).not.toBeNull();
        advance(2000);
        expect(core.userOfSession(login.sessionId)).toBeNull();

        const second = await core.authenticationOptions({ context: CTX });
        const again = await core.verifyAuthentication({
            context: CTX,
            response: device.authenticate({ options: second.options, origin: CTX.origin, rpID: CTX.rpID }),
        });
        expect(core.logout(again.sessionId)).toBe(true);
        expect(core.userOfSession(again.sessionId)).toBeNull();
    });

    it('落盘：users.json 有公钥、无私钥；重启后读得回来（判据 7）', async () => {
        const home = makeHome();
        const deps = { now: () => Date.now(), newId: () => randomUUID() };
        const file = webauthnStorePath(home);
        const core = await openWebAuthnStore(file, deps);
        const device = createVirtualAuthenticator();
        const { options } = await core.registrationOptions({ context: CTX, displayName: '大王' });
        const created = await core.verifyRegistration({
            context: CTX,
            response: device.register({ options, origin: CTX.origin, rpID: CTX.rpID }),
        });
        await core.flush();

        const raw = readFileSync(file, 'utf-8');
        const parsed = JSON.parse(raw) as {
            users: { id: string }[];
            credentials: { publicKey: string; counter: number }[];
        };
        expect(parsed.users[0]?.id).toBe(created.user.id);
        expect(parsed.credentials[0]?.publicKey.length).toBeGreaterThan(0);
        // 整份文件里不许出现私钥字段（私钥在系统钥匙串）
        expect(raw).not.toMatch(/privateKey|"d"|"p"|"q"/);

        // 重开一次 store（模拟重启）：用户还在，能继续登
        const reopened = await openWebAuthnStore(file, deps);
        expect(reopened.hasUser()).toBe(true);
        expect(reopened.store().credentials[0]?.id).toBe(created.credential.id);
    });

    it('contextFromRequest：只从 Host 推，不硬编码', () => {
        expect(contextFromRequest({ host: 'c-mac.gute-fish.ts.net' })).toEqual({
            rpID: 'c-mac.gute-fish.ts.net',
            origin: 'https://c-mac.gute-fish.ts.net',
        });
        // 回环默认 http；带端口时 rpID 去端口、origin 保留端口
        expect(contextFromRequest({ host: '127.0.0.1:8123' })).toEqual({
            rpID: '127.0.0.1',
            origin: 'http://127.0.0.1:8123',
        });
        // 反代给了 x-forwarded-proto 就以它为准
        expect(contextFromRequest({ host: 'c-mac.gute-fish.ts.net', forwardedProto: 'https' })).toEqual({
            rpID: 'c-mac.gute-fish.ts.net',
            origin: 'https://c-mac.gute-fish.ts.net',
        });
        expect(() => contextFromRequest({})).toThrow(/Host/);
    });

    it('cookie：HttpOnly + SameSite=Lax + Secure + 7 天', () => {
        const value = sessionCookie('sess-1', { secure: true });
        expect(value).toContain(`${SESSION_COOKIE}=sess-1`);
        expect(value).toContain('HttpOnly');
        expect(value).toContain('SameSite=Lax');
        expect(value).toContain('Secure');
        expect(value).toContain('Max-Age=604800');
        // 回环 http 下不下发 Secure（否则浏览器直接丢弃）
        expect(sessionCookie('sess-1', { secure: false })).not.toContain('Secure');
        expect(parseCookies(`a=1; ${SESSION_COOKIE}=sess-1; b=2`)[SESSION_COOKIE]).toBe('sess-1');
    });
});

describe('Passkey HTTP 面（/webauthn/*）', () => {
    const handles: WebServerHandle[] = [];

    afterEach(async () => {
        for (const handle of handles.splice(0)) await handle.close();
    });

    async function start(): Promise<WebServerHandle> {
        const fake = makeFakeLlm();
        const handle = await startWebServer({
            port: 0,
            host: '127.0.0.1',
            home: makeHome(),
            staticDir: makeStaticDir(),
            variant: 'test',
            llmFor: () => fake.llm,
        });
        handles.push(handle);
        return handle;
    }

    type Me = {
        hasUser: boolean;
        user: { id: string; displayName: string } | null;
        rpID: string;
        suggestedUsername: string | null;
    };

    async function me(base: string, cookie?: string): Promise<Me> {
        const response = await fetch(`${base}/webauthn/me`, {
            headers: cookie === undefined ? {} : { cookie },
        });
        expect(response.status).toBe(200);
        return (await response.json()) as Me;
    }

    async function post<T>(
        base: string,
        path: string,
        body: unknown,
        cookie?: string,
    ): Promise<{ status: number; body: T; cookie: string }> {
        const response = await fetch(`${base}${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(cookie === undefined ? {} : { cookie }),
            },
            body: JSON.stringify(body),
        });
        const raw = await response.text();
        const cookies = response.headers.getSetCookie();
        return {
            status: response.status,
            body: (raw === '' ? null : JSON.parse(raw)) as T,
            cookie: cookies[0] ?? '',
        };
    }

    it('判据 1/2/3/4：没有用户 → 创建 → 再创建被拒 → 刷新仍是登录页', async () => {
        const handle = await start();
        const base = handle.url;

        const before = await me(base);
        expect(before.hasUser).toBe(false);
        expect(before.user).toBeNull();
        // 澄清 3：默认用户名 = 系统用户名（页面拿它做默认值），不是写死的 'owner'
        expect(before.suggestedUsername).toBe(defaultUsername());

        const device = createVirtualAuthenticator();
        const options = await post<{ options: never }>(base, '/webauthn/register/options', {
            displayName: '大王',
        });
        expect(options.status).toBe(200);
        const registration = device.register({
            options: options.body.options,
            origin: base,
            rpID: before.rpID,
        });
        const verified = await post<{ user: { id: string } }>(base, '/webauthn/register/verify', {
            response: registration,
        });
        expect(verified.status).toBe(200);
        expect(verified.body.user.id.startsWith('usr_')).toBe(true);
        // 判据 2/4：创建成功**不发会话** —— 刷新（= 再问 me）仍是未登录
        expect(verified.cookie).toBe('');
        expect((await me(base)).user).toBeNull();

        // 判据 3：再点一次创建 → 被拒
        const again = await post<{ error: string }>(base, '/webauthn/register/options', {});
        expect(again.status).toBe(400);
        expect(again.body.error).toBe('FAILED_PRECONDITION');

        // 判据 4：有用户没会话 ⇒ 页面该显示「用 Passkey 登录」
        const after = await me(base);
        expect(after.hasUser).toBe(true);
        expect(after.user).toBeNull();
        // 已经有主用户了：建议值不再有意义
        expect(after.suggestedUsername).toBeNull();
    });

    it('判据 5/6：登录 → HttpOnly cookie → me 认 cookie → 连 WS 直接进业务面 → 登出', async () => {
        const handle = await start();
        const base = handle.url;
        const info = await me(base);
        const device = createVirtualAuthenticator();
        const options = await post<{ options: never }>(base, '/webauthn/register/options', {});
        await post(base, '/webauthn/register/verify', {
            response: device.register({ options: options.body.options, origin: base, rpID: info.rpID }),
        });

        const loginOptions = await post<{ options: never }>(base, '/webauthn/login/options', {});
        expect(loginOptions.status).toBe(200);
        const verified = await post<{ user: { id: string } }>(base, '/webauthn/login/verify', {
            response: device.authenticate({ options: loginOptions.body.options, origin: base, rpID: info.rpID }),
        });
        expect(verified.status).toBe(200);
        // HttpOnly / SameSite / 7 天都在；回环 http 下不带 Secure（否则浏览器丢弃）
        expect(verified.cookie).toContain('HttpOnly');
        expect(verified.cookie).toContain('SameSite=Lax');
        expect(verified.cookie).toContain('Max-Age=604800');
        expect(verified.cookie).not.toContain('Secure');
        const cookie = verified.cookie.split(';')[0] ?? '';

        // 判据 6：me 认 cookie
        const logged = await me(base, cookie);
        expect(logged.user?.id).toBe(verified.body.user.id);

        // 判据 5 的接缝：cookie 随 WS 升级请求发过去 ⇒ web.page.* 不需要旧式 token
        const socket = new WebSocket(`${base.replace('http://', 'ws://')}/rpc`, { headers: { cookie } });
        await new Promise<void>((done, fail) => {
            socket.once('open', () => done());
            socket.once('error', fail);
        });
        const client = createTypedClient(new ChannelClientBinding(new WsTransport(socket)), webApi);
        const pages = await client.web.page.list({});
        expect(Array.isArray(pages)).toBe(true);
        expect(handle.stats.pageInvokes).toBe(0); // list 不计入 invoke，只是业务面通了
        socket.close();

        // 登出：清 cookie，之后的 me 不再认（登出必须带 cookie —— 反过来说：没带 cookie 就不知道登出谁）
        const logout = await post(base, '/webauthn/logout', {}, cookie);
        expect(logout.status).toBe(200);
        expect(logout.cookie).toContain('Max-Age=0');
        expect((await me(base, cookie)).user).toBeNull();
    });

    it('跨源写请求被拒（CSRF 兜底）', async () => {
        const handle = await start();
        const response = await fetch(`${handle.url}/webauthn/login/options`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
            body: '{}',
        });
        expect(response.status).toBe(403);
    });

    it('没有用户时登录参数被拒（FAILED_PRECONDITION）', async () => {
        const handle = await start();
        const response = await post<{ error: string }>(handle.url, '/webauthn/login/options', {});
        expect(response.status).toBe(400);
        expect(response.body.error).toBe('FAILED_PRECONDITION');
    });

    it('RPC 面（web.webauthn.*）：注册 / 登录 / me 都在同一条连接上跑通', async () => {
        const handle = await start();
        const socket = new WebSocket(`${handle.url.replace('http://', 'ws://')}/rpc`);
        await new Promise<void>((done, fail) => {
            socket.once('open', () => done());
            socket.once('error', fail);
        });
        const client = createTypedClient(new ChannelClientBinding(new WsTransport(socket)), webApi);
        try {
            const before = await client.web.webauthn.me({});
            expect(before.hasUser).toBe(false);
            expect(before.user).toBeNull();
            expect(before.suggestedUsername).toBe(defaultUsername());

            const device = createVirtualAuthenticator();
            const { options } = await client.web.webauthn.register.options({
                username: undefined,
                displayName: '大王',
            });
            const created = await client.web.webauthn.register.verify({
                response: device.register({
                    options: options as never,
                    origin: handle.url,
                    rpID: '127.0.0.1',
                }),
                credentialName: 'Mac Touch ID',
            });
            expect(created.user.displayName).toBe('大王');

            const loginOptions = await client.web.webauthn.login.options({});
            const login = await client.web.webauthn.login.verify({
                response: device.authenticate({
                    options: loginOptions.options as never,
                    origin: handle.url,
                    rpID: '127.0.0.1',
                }),
            });
            expect(login.sessionId.length).toBeGreaterThan(0);
            // 本连接立刻可用：passkey 会话与旧式 token 是同一道门（requireClient）
            expect(Array.isArray(await client.web.page.list({}))).toBe(true);
            expect((await client.web.webauthn.me({})).user?.id).toBe(created.user.id);
            await client.web.webauthn.logout({});
            expect((await client.web.webauthn.me({})).user).toBeNull();
        } finally {
            socket.close();
        }
    });

    it('部署前缀 /diy：所有路由与静态都在前缀之下，前缀外一律 404', async () => {
        const fake = makeFakeLlm();
        const handle = await startWebServer({
            port: 0,
            host: '127.0.0.1',
            home: makeHome(),
            staticDir: makeStaticDir(),
            variant: 'test',
            llmFor: () => fake.llm,
            basePath: '/diy/',
        });
        handles.push(handle);
        expect(handle.basePath).toBe('/diy');

        expect((await me(`${handle.url}/diy`)).hasUser).toBe(false);
        expect((await fetch(`${handle.url}/diy/ping`)).status).toBe(200);
        expect((await fetch(`${handle.url}/diy/`)).status).toBe(200); // index.html
        // 前缀外不是本服务的地盘
        expect((await fetch(`${handle.url}/ping`)).status).toBe(404);
        expect((await fetch(`${handle.url}/webauthn/me`)).status).toBe(404);
    });
});
