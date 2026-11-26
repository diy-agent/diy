// tests/rpc.test.ts —— `/rpc`（WS）上的房间事件流 + 订阅观测。
//
// 只验接线：一条连接 → 订阅房间 → 首帧 ready → 房间事件（cancel 广播 done）能推回来，
// 以及 `streams` 能看见「谁在订什么」。LLM 不参与（发消息会真跑模型）。

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChannelClientBinding } from '@diy-agent/rpc';
import { WsTransport, connectWs } from '@diy-agent/rpc/ws/browser';
import { StreamHub } from '@diy-agent/chat-transport-rpc';
import { openStore, type UnitBoard } from '@diy-agent/entity-runtime';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDiy2App, type Diy2App } from '../server/app';
import { resolveConfig } from '../server/config';

const moduleDir = join(import.meta.dirname, '..');
let home = '';
let app: Diy2App;
let server: Server;
let rpcUrl = '';

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'diy2-rpc-'));
    app = await createDiy2App({
        config: await resolveConfig({ moduleDir, mode: 'development', overrides: { home } }),
        webDir: null,
    });
    server = createServer(app.handle);
    server.on('upgrade', (req, socket, head) => {
        app.handleUpgrade(req, socket, head);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('没有端口');
    rpcUrl = `ws://127.0.0.1:${address.port}/rpc`;
});

afterEach(async () => {
    app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
});

describe('/rpc 房间事件流', () => {
    it('订阅 → ready → 房间事件；streams 能看见订阅关系', async () => {
        const transport = new WsTransport(await connectWs(rpcUrl, { timeoutMs: 2_000 }));
        const binding = new ChannelClientBinding(transport);
        const controller = new AbortController();
        try {
            const handle = await binding.serverStream(
                'room',
                { input: { room: 'task:t-001' } },
                { signal: controller.signal },
            );
            const iterator = handle[Symbol.asyncIterator]();

            // 首帧 ready：客户端据此知道「从现在起事件连续」，补拉一次快照
            expect((await iterator.next()).value).toEqual({ kind: 'ready' });

            // 观测：这条连接正在订 task:t-001
            const streams = await binding.invoke<unknown, Array<{ conn: string; rooms: string[]; since: number }>>(
                'streams',
                { input: {} },
            );
            expect(streams).toEqual([
                { conn: expect.stringMatching(/^ws-\d+$/), rooms: ['task:t-001'], since: expect.any(Number) },
            ]);

            // 房间事件：删房间会广播 { kind: 'done' }（不跑模型）
            await binding.invoke('diy2.rooms.remove', { input: { id: 'task:t-001' } });
            const event = await Promise.race([
                iterator.next(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('等事件超时')), 2_000)),
            ]);
            expect(event).toEqual({ value: { kind: 'done' }, done: false });
        } finally {
            controller.abort();
            transport.close();
        }
    });

    it('命令面：rooms 列表 / 建任务 / 草稿读写都走 RPC', async () => {
        const transport = new WsTransport(await connectWs(rpcUrl, { timeoutMs: 2_000 }));
        const binding = new ChannelClientBinding(transport);
        try {
            const rooms = await binding.invoke<unknown, Array<{ id: string; type: string }>>('diy2.rooms.list', {
                input: {},
            });
            expect(rooms.some((room) => room.id === 'task:t-001')).toBe(true);

            const created = await binding.invoke<unknown, { id: string; data: { number?: number; taskDir?: string } }>(
                'diy2.rooms.create',
                { input: { type: 'task', name: 'RPC 任务', data: { projectId: 'proj:diy' } } },
            );
            expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
            expect(created.data.number).toBeGreaterThan(0);
            expect(created.data.taskDir).toMatch(/tasks\/\d{4}-\d{2}-\d{2}\//);

            // 侧栏的 #号 来自 `rooms.list`（内存 spec），不是 create 的回包：
            // 只验 create 会漏掉「本次运行内建的任务没有 number」这个 bug（用户报过）。
            // `taskDir` 同一根因（库侧派生、create 时手写的 spec 里没有），一并钉住。
            const listed = await binding.invoke<
                unknown,
                Array<{ id: string; data: { number?: number; taskDir?: string } }>
            >('diy2.rooms.list', { input: {} });
            const mine = listed.find((room) => room.id === created.id);
            expect(mine?.data.number).toBe(created.data.number);
            expect(mine?.data.taskDir).toBe(created.data.taskDir);

            await binding.invoke('diy2.drafts.put', {
                input: { owner: created.id, field: 'composer', value: { text: '半句话' } },
            });
            const drafts = await binding.invoke<unknown, { drafts: Array<{ field: string }> }>('diy2.drafts.list', {
                input: { owner: created.id },
            });
            expect(drafts.drafts).toEqual([
                { field: 'composer', value: { text: '半句话' }, updatedAt: expect.any(Number) },
            ]);

            const removed = await binding.invoke<unknown, { deleted: string[] }>('diy2.rooms.remove', {
                input: { id: created.id },
            });
            expect(removed.deleted).toEqual([created.id]);
        } finally {
            transport.close();
        }
    });

    it("空模型 key 进不了库：schema 层就拒（`??` 挡不住 `''`）", async () => {
        const transport = new WsTransport(await connectWs(rpcUrl, { timeoutMs: 2_000 }));
        const binding = new ChannelClientBinding(transport);
        try {
            const before = await binding.invoke<unknown, Array<{ id: string }>>('diy2.rooms.list', { input: {} });
            // 界面在模型目录为空时 `defaultModelKey` 就是 ''：以前原样发上来，落成一个"标识不合法"的实体
            await expect(
                binding.invoke('diy2.rooms.create', {
                    input: { type: 'project', name: '空模型', modelKey: '' },
                }),
            ).rejects.toThrow();
            const after = await binding.invoke<unknown, Array<{ id: string }>>('diy2.rooms.list', { input: {} });
            expect(after.length).toBe(before.length);
        } finally {
            transport.close();
        }
    });

    it('不存在的房间：流以错误结束，不是静默空流', async () => {
        const transport = new WsTransport(await connectWs(rpcUrl, { timeoutMs: 2_000 }));
        const binding = new ChannelClientBinding(transport);
        try {
            const handle = await binding.serverStream('room', { input: { room: 'nope' } });
            await expect(async () => {
                for await (const _ of handle) {
                    /* 不应该有值 */
                }
            }).rejects.toThrow(/房间不存在/);
        } finally {
            transport.close();
        }
    });

    it('links：RPC 增删，两端都带显示名', async () => {
        const transport = new WsTransport(await connectWs(rpcUrl, { timeoutMs: 2_000 }));
        const binding = new ChannelClientBinding(transport);
        try {
            const created = await binding.invoke<unknown, { id: string }>('diy2.rooms.create', {
                input: { type: 'task', name: 'B', data: { projectId: 'proj:diy' } },
            });
            await binding.invoke('diy2.links.add', {
                input: { id: 'task:t-001', to: created.id, kind: 'related' },
            });
            const mine = await binding.invoke<unknown, { out: Array<Record<string, unknown>> }>('diy2.links.list', {
                input: { id: 'task:t-001' },
            });
            expect(mine.out[0]).toMatchObject({ id: created.id, kind: 'related', label: '#2 B', type: 'task' });

            const removed = await binding.invoke<unknown, { removed: boolean }>('diy2.links.remove', {
                input: { id: 'task:t-001', to: created.id, kind: 'related' },
            });
            expect(removed.removed).toBe(true);
        } finally {
            transport.close();
        }
    });

    it('units.list：只读 board 的推导在服务端（空图也是同一形状）', async () => {
        const transport = new WsTransport(await connectWs(rpcUrl, { timeoutMs: 2_000 }));
        const binding = new ChannelClientBinding(transport);
        try {
            // 空树不能是 undefined / 404：界面直接画 `rows`，拿不到就会白屏
            const empty = await binding.invoke<unknown, UnitBoard>('diy2.units.list', {
                input: { id: 'task:t-001' },
            });
            expect(empty.rows).toEqual([]);
            expect(empty.ready).toEqual([]);
            expect(empty.groups).toEqual([]);

            // 种一棵两层树（写入口只有 agent 的工具，这里直接落库绕过模型）
            const seed = openStore(join(home, 'diy2.db'));
            let parent = '';
            let leaf = '';
            try {
                parent = seed.saveUnit({ taskId: 'task:t-001', title: '一条需求', body: '', status: 'open' }).id;
                leaf = seed.saveUnit({
                    taskId: 'task:t-001',
                    title: '它的第一步',
                    body: '',
                    status: 'done',
                    parent,
                }).id;
            } finally {
                seed.db.close();
            }

            // 服务端算的是 unitBoard（与 agent 工具 / 上下文注入同一份纯函数）：
            // 这里只验「存进库 → RPC 回来」的这条链真的通，且树形与 ready 划分对
            const board = await binding.invoke<unknown, UnitBoard>('diy2.units.list', {
                input: { id: 'task:t-001' },
            });
            expect(board.rows.map((row) => [row.id, row.depth, row.group])).toEqual([
                [parent, 0, true],
                [leaf, 1, false],
            ]);
            expect(board.groups).toEqual([parent]);
            expect(board.done).toEqual([parent, leaf]);
            // 母项不执行，done 之后也不进 ready
            expect(board.ready).toEqual([]);
        } finally {
            transport.close();
        }
    });

    it('客户端 StreamHub：subscribe 能收到 ready 与房间事件，close 后停', async () => {
        const hub = new StreamHub({ rpcUrl, timeoutMs: 2_000 });
        const events: Array<{ kind?: string }> = [];
        const off = hub.subscribe('room:task:t-001', (event) => events.push(event as { kind?: string }));
        try {
            await waitFor(() => events.some((event) => event.kind === 'ready'));
            // 用另一条连接删房间（广播 done）
            const admin = new ChannelClientBinding(new WsTransport(await connectWs(rpcUrl, { timeoutMs: 2_000 })));
            await admin.invoke('diy2.rooms.remove', { input: { id: 'task:t-001' } });
            await waitFor(() => events.some((event) => event.kind === 'done'));
        } finally {
            off();
            hub.close();
        }
    });
});

/** 等一个条件成立（最多 2s）；失败时给出当前观察值，便于排查 */
async function waitFor(assertion: () => boolean, at = Date.now()): Promise<void> {
    if (assertion()) return;
    if (Date.now() - at > 2_000) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
    return waitFor(assertion, at);
}
