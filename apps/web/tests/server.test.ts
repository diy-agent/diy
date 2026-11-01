// server.test.ts — 真起服务（http + ws），把 ##485 的判据 1/2/3/4/5/7 走一遍。
//
// 客户端用的是**浏览器那套**（WsTransport + ChannelClientBinding + createTypedClient），
// 只差一层浏览器 WebSocket 适配（gateway.ts 里那 20 行）—— 协议一字不差，所以这里过了就是页面过了。
//
// 判据 4 的证据分两层：
//   · 行为层：revoke 之后主方下一次调用拿到 UNAUTHENTICATED（HTTP 绑定下 = 401，见 http-binding.test.ts）；
//   · 结构层：服务端计数器 `pageInvokes` 一次都不增、`pageRejects` 恰好等于客户端调用次数
//     ——「恰好等于」就是「没有自动重试」的硬证据（有重试就会翻倍）。

import { afterEach, describe, expect, it } from 'vitest';
import { ChannelClientBinding, ChannelServerBinding, createMemTransportPair, createTypedClient } from '@diy-agent/rpc';
import { webApi } from '../api.js';
import { emptyAuthState, createAuth } from '../auth.js';
import { newWebRpcStats, registerWebApi } from '../handlers.js';
import { startWebServer, type WebServerHandle } from '../server.js';
import { codeOf, connectWs, makeFakeLlm, makeHome, makeStaticDir } from './helpers.js';

const handles: WebServerHandle[] = [];

afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.close();
});

async function start(): Promise<{ handle: WebServerHandle; home: string; llmCalls: () => number }> {
    const home = makeHome();
    const fake = makeFakeLlm();
    const handle = await startWebServer({
        port: 0,
        host: '127.0.0.1',
        home,
        staticDir: makeStaticDir(),
        variant: 'test',
        llmFor: () => fake.llm,
    });
    handles.push(handle);
    return { handle, home, llmCalls: fake.calls };
}

/** 副方（本机操作者）确认一次：request → approve，返回 token */
async function pairAndApprove(baseUrl: string, subject: string): Promise<string> {
    const operator = await connectWs(baseUrl);
    try {
        const pending = await operator.client.web.auth.pending({});
        // 副方看得到主方的请求（主方那边先 request 之后）
        expect(Array.isArray(pending.requests)).toBe(true);
        const requestId = (await operator.client.web.auth.request({ subject })).requestId;
        const approved = await operator.client.web.auth.approve({ requestId });
        return approved.token;
    } finally {
        operator.close();
    }
}

describe('apps/web 服务端', () => {
    it('/ping 是纯 HTTP GET（curl 能验），POST 405', async () => {
        const { handle } = await start();
        const response = await fetch(`${handle.url}/ping`);
        expect(response.status).toBe(200);
        const ping = (await response.json()) as Record<string, unknown>;
        expect(ping['app']).toBe('diy-web');
        expect(ping['auth']).toBe('required');
        expect(String(ping['address'])).toMatch(/^.+@.+\/diy-web\.test$/);
        expect(typeof ping['id']).toBe('string');
        expect(typeof ping['uptimeMs']).toBe('number');

        const post = await fetch(`${handle.url}/ping`, { method: 'POST' });
        expect(post.status).toBe(405);
    });

    it('静态托管：/ → index.html；越界路径 404', async () => {
        const { handle } = await start();
        const index = await fetch(`${handle.url}/`);
        expect(index.status).toBe(200);
        expect(await index.text()).toContain('diy web');
        expect((await fetch(`${handle.url}/index.js`)).status).toBe(200);
        expect((await fetch(`${handle.url}/../../etc/passwd`)).status).toBe(404);
        expect((await fetch(`${handle.url}/nope.js`)).status).toBe(404);
    });

    it('未授权：页面调用一律 UNAUTHENTICATED（401 的等价物）', async () => {
        const { handle } = await start();
        const client = await connectWs(handle.url);
        try {
            await expect(client.client.web.page.list({})).rejects.toThrowError(/未连接/);
            try {
                await client.client.web.page.list({});
            } catch (error) {
                expect(codeOf(error)).toBe('UNAUTHENTICATED');
            }
            // 授权通道本身是开放的：能发请求、能查状态
            const created = await client.client.web.auth.request({ subject: 'guest@c-mac/diy-chat.lab' });
            expect(created.status).toBe('pending');
            expect((await client.client.web.auth.status({ requestId: created.requestId })).token).toBeNull();
        } finally {
            client.close();
        }
    });

    it('判据 3：请求 → 副方确认 → 拿到 token → 进页面（chat-page 原样）', async () => {
        const { handle } = await start();
        const main = await connectWs(handle.url);
        try {
            const created = await main.client.web.auth.request({ subject: 'guest@c-mac/diy-chat.lab' });
            expect(created.address).toMatch(/^.+@.+\/diy-web\.test$/);

            const token = await pairAndApprove(handle.url, 'guest@c-mac/diy-chat.lab');
            const state = await main.client.web.auth.status({ requestId: created.requestId });
            expect(state.status).toBe('approved');
            // 副方生成的 token 是主方唯一能拿到的凭据（主方没有自签入口）
            expect(state.token).toBe(token);

            await main.client.web.auth.login({ token });
            const pages = await main.client.web.page.list({});
            expect(pages).toEqual([{ id: 'chat', title: '聊天' }]);
            const snapshot = await main.client.web.page.invoke({
                pageId: 'chat',
                method: 'snapshot',
                args: {},
            });
            expect(snapshot).toMatchObject({ sessions: [], activeId: null });
        } finally {
            main.close();
        }
    });

    it('判据 5：授权之后能真的发消息（假模型回显；真模型由 --home 的 model.yaml 决定）', async () => {
        const { handle, llmCalls } = await start();
        const main = await connectWs(handle.url);
        try {
            const operator = await connectWs(handle.url);
            const created = await main.client.web.auth.request({ subject: 'guest@c-mac' });
            const approved = await operator.client.web.auth.approve({ requestId: created.requestId });
            operator.close();
            await main.client.web.auth.login({ token: approved.token });

            const snapshot = (await main.client.web.page.invoke({
                pageId: 'chat',
                method: 'createSession',
                args: {},
            })) as { activeId: string };
            const sent = (await main.client.web.page.invoke({
                pageId: 'chat',
                method: 'send',
                args: { sessionId: snapshot.activeId, text: '你好呀' },
            })) as { messages: Array<{ role: string; text: string }> };
            expect(sent.messages).toEqual([
                { role: 'user', text: '你好呀' },
                { role: 'assistant', text: '收到：你好呀' },
            ]);
            expect(llmCalls()).toBe(1);
        } finally {
            main.close();
        }
    });

    it('判据 4：副方 revoke ⇒ 主方下一次调用 UNAUTHENTICATED，且服务端只被调用一次（没有自动重试）', async () => {
        const { handle } = await start();
        const main = await connectWs(handle.url);
        const operator = await connectWs(handle.url);
        try {
            const created = await main.client.web.auth.request({ subject: 'guest@c-mac' });
            const approved = await operator.client.web.auth.approve({ requestId: created.requestId });
            await main.client.web.auth.login({ token: approved.token });

            expect((await main.client.web.page.list({})).length).toBe(1);
            const before = handle.stats.pageInvokes;

            // ⑤ 副方「断开本次连接」
            expect(await operator.client.web.auth.revoke({ token: approved.token })).toEqual({ revoked: 1 });

            // 主方下一次请求：401（UNAUTHENTICATED），一次就够
            let caught: unknown = null;
            await main.client.web.page.list({}).catch((error: unknown) => {
                caught = error;
            });
            expect(codeOf(caught)).toBe('UNAUTHENTICATED');
            expect(handle.stats.pageInvokes).toBe(before); // 业务方法没被真正调用
            expect(handle.stats.pageRejects).toBe(1); // 客户端调了一次 ⇒ 服务端拒了一次

            // 主方**不自动重试**；即便再点一次，也仍然是 UNAUTHENTICATED（等副方重新授权）
            await expect(main.client.web.page.list({})).rejects.toThrowError(/未连接/);
            expect(handle.stats.pageRejects).toBe(2);

            // 重新授权后恢复（「记住」≠「绕过确认」：又走了一遍 request + approve）
            const again = await main.client.web.auth.request({ subject: 'guest@c-mac' });
            expect(again.status).toBe('pending');
            const reApproved = await operator.client.web.auth.approve({ requestId: again.requestId });
            await main.client.web.auth.login({ token: reApproved.token });
            expect((await main.client.web.page.list({})).length).toBe(1);
        } finally {
            main.close();
            operator.close();
        }
    });

    it('判据 7：token 在副方 store 里，服务重启后仍然有效（不是 localStorage）', async () => {
        const { handle, home } = await start();
        const main = await connectWs(handle.url);
        const created = await main.client.web.auth.request({ subject: 'guest@c-mac' });
        const token = await pairAndApprove(handle.url, 'guest@c-mac');
        expect((await main.client.web.auth.status({ requestId: created.requestId })).token).toBe(token);
        main.close();

        // 「重启」：同一个 home 再起一个服务（端口变了也无所谓）
        const again = await startWebServer({
            port: 0,
            host: '127.0.0.1',
            home,
            staticDir: makeStaticDir(),
            variant: 'test',
            llmFor: () => makeFakeLlm().llm,
        });
        handles.push(again);
        const client = await connectWs(again.url);
        try {
            await client.client.web.auth.login({ token });
            expect((await client.client.web.page.list({})).length).toBe(1);
        } finally {
            client.close();
        }
    });
});

describe('跨机主方拿不到副方管理面（铁律① 的拓扑落地）', () => {
    it('非回环来源调 approve ⇒ PERMISSION_DENIED；连待确认列表都看不到', async () => {
        const auth = createAuth(emptyAuthState(), {
            now: () => new Date('2026-10-31T00:00:00.000Z'),
            newId: () => `id-${Math.random().toString(36).slice(2)}`,
            newToken: () => `tok-${Math.random().toString(36).slice(2)}`,
        });
        const pages = { list: () => [], invoke: async () => null };
        const { serverTx, clientTx } = createMemTransportPair();
        const binding = new ChannelServerBinding(serverTx);
        registerWebApi(
            binding,
            { address: '10.0.0.9', loopback: false },
            {
                auth,
                pages,
                address: 'alice@c-mac/diy-web.test',
                stats: newWebRpcStats(),
            },
        );
        const client = createTypedClient(new ChannelClientBinding(clientTx), webApi);

        const created = await client.web.auth.request({ subject: 'mallory@remote/diy-chat.lab' });
        expect(created.status).toBe('pending');
        await expect(client.web.auth.approve({ requestId: created.requestId })).rejects.toThrowError(/只对回环开放/);
        try {
            await client.web.auth.pending({});
        } catch (error) {
            expect(codeOf(error)).toBe('PERMISSION_DENIED');
        }
        // 主方没法自己批 ⇒ 永远拿不到 token
        expect((await client.web.auth.status({ requestId: created.requestId })).token).toBeNull();
        binding.destroy();
    });
});
