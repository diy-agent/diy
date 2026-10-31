// http-binding.test.ts — 同一份 router（api.ts）挂到 **HttpServerBinding + HttpClientBinding**（h2c）。
//
// 这一份测试的存在理由：业务层不认识传输。浏览器走 ws（浏览器的 h2 必须 TLS，本轮不做 TLS）；
// Node 侧的调用方（CLI / 别的 diy 实例）走 http —— 两边界面的方法、错误码、zod 校验、授权状态
// 完全同一份，换 binding 不改业务。
//
// 顺带给出判据 4 里 **「401」的字面证据**：http 绑定把 UNAUTHENTICATED 映射成 HTTP 401
// （`transport/http/_codes.ts`），curl 直接看到状态码，不是「等价物」。

import { exec as execCallback } from 'node:child_process';
import * as http2 from 'node:http2';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createTypedClient } from '@diy-agent/rpc';
import { HttpClientBinding, HttpServerBinding } from '@diy-agent/rpc/http';
import { webApi } from '../api.js';
import { createAuth, emptyAuthState } from '../auth.js';
import { newWebRpcStats, registerWebApi } from '../handlers.js';
import { createPagesHost } from '../pages.js';
import { codeOf, makeFakeLlm, makeHome } from './helpers.js';

const exec = promisify(execCallback);

interface Rig {
    readonly base: string;
    readonly client: ReturnType<typeof createTypedClient<typeof webApi>>;
    readonly stats: ReturnType<typeof newWebRpcStats>;
    close(): Promise<void>;
}

const rigs: Rig[] = [];

afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.close();
});

/** 起一张 h2c 端口，把 webApi 挂上去；调用方再建一个 HttpClientBinding 当「一条连接」 */
async function startHttpRig(): Promise<Rig> {
    const home = makeHome();
    const fake = makeFakeLlm();
    const pages = await createPagesHost({ home, llmFor: () => fake.llm });
    const auth = createAuth(emptyAuthState(), {
        now: () => new Date(),
        newId: () => globalThis.crypto.randomUUID(),
        newToken: () => `diyweb_${globalThis.crypto.randomUUID().replace(/-/g, '')}`,
    });
    const stats = newWebRpcStats();
    const serverBinding = new HttpServerBinding();
    // h2c 端口只在本机可达 ⇒ 这条「连接」的来源算回环（副方自己的机器）
    registerWebApi(
        serverBinding,
        { address: '127.0.0.1', loopback: true },
        {
            auth,
            pages,
            address: 'alice@c-mac/diy-web.test',
            stats,
        },
    );

    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
        void serverBinding.handleStream(stream as http2.ServerHttp2Stream, headers);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    const clientBinding = new HttpClientBinding(base);
    await clientBinding.ready();

    const rig: Rig = {
        base,
        client: createTypedClient(clientBinding, webApi),
        stats,
        async close(): Promise<void> {
            clientBinding.dispose();
            serverBinding.destroy();
            await new Promise<void>((done) => server.close(() => done()));
        },
    };
    rigs.push(rig);
    return rig;
}

describe('同一份 router 走 HttpServerBinding（h2c）', () => {
    it('审批 → 登录 → 页面调用：与 ws 完全同一套方法', async () => {
        const rig = await startHttpRig();

        const created = await rig.client.web.auth.request({ subject: 'cli@c-mac/diy-chat.lab' });
        expect(created.status).toBe('pending');

        const approved = await rig.client.web.auth.approve({ requestId: created.requestId });
        expect(approved.token).toMatch(/^diyweb_/);

        const state = await rig.client.web.auth.status({ requestId: created.requestId });
        expect(state).toMatchObject({ status: 'approved', token: approved.token });

        await rig.client.web.auth.login({ token: approved.token });
        expect(await rig.client.web.page.list({})).toEqual([{ id: 'chat', title: '聊天' }]);
        const snapshot = await rig.client.web.page.invoke({ pageId: 'chat', method: 'snapshot', args: {} });
        expect(snapshot).toMatchObject({ sessions: [], activeId: null });
    });

    it('判据 4（401 的字面证据）：revoke 之后 curl 拿到 HTTP 401，且没有自动重试', async () => {
        const rig = await startHttpRig();
        const created = await rig.client.web.auth.request({ subject: 'cli@c-mac' });
        const approved = await rig.client.web.auth.approve({ requestId: created.requestId });
        await rig.client.web.auth.login({ token: approved.token });
        expect((await rig.client.web.page.list({})).length).toBe(1);

        const before = rig.stats.pageInvokes;
        expect(await rig.client.web.auth.revoke({ token: approved.token })).toEqual({ revoked: 1 });

        // 连接上再调一次：UNAUTHENTICATED
        let caught: unknown = null;
        await rig.client.web.page.list({}).catch((error: unknown) => {
            caught = error;
        });
        expect(codeOf(caught)).toBe('UNAUTHENTICATED');
        expect(rig.stats.pageInvokes).toBe(before);
        expect(rig.stats.pageRejects).toBe(1);

        // 同样的方法用 curl 打：HTTP 状态码就是 401（grpc UNAUTHENTICATED → 401 的映射）
        const { stdout } = await exec(
            `curl -s -o /dev/null -w '%{http_code}' --http2-prior-knowledge -m 8 -X POST ${rig.base}/web.page.list ` +
                `-H 'Content-Type: application/json' -d '{"input":{},"meta":{}}'`,
        );
        expect(stdout.trim()).toBe('401');
        // /ping 不受影响（纯 HTTP 面，无鉴权）
        const { stdout: pingCode } = await exec(
            `curl -s -o /dev/null -w '%{http_code}' --http2-prior-knowledge -m 8 ${rig.base}/web.auth.state -X POST ` +
                `-H 'Content-Type: application/json' -d '{"input":{},"meta":{}}'`,
        );
        expect(pingCode.trim()).toBe('200');
    });

    it('未登录时业务方法一律 401（错误码与 ws 一致）', async () => {
        const rig = await startHttpRig();
        let caught: unknown = null;
        await rig.client.web.page.list({}).catch((error: unknown) => {
            caught = error;
        });
        expect(codeOf(caught)).toBe('UNAUTHENTICATED');
        // ext.http.status 里带着映射后的状态（客户端可据此判断「这是 401，不是网络错」）
        const ext = (caught as { ext?: { http?: { status?: number } } }).ext;
        expect(ext?.http?.status).toBe(401);
    });
});
