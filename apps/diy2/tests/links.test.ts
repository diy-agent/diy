// tests/links.test.ts —— `/api/rooms/:id/links`：实体关系的读写与拒绝。
//
// 这一层只验「路由 + 校验 + 显示名」，领域规则（成环、kind 命名空间）在
// entity-runtime 的 db.test 里钉。这里用真 socket，因为路由与编解码（id 里有 `:`）
// 正是最容易错的地方。

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDiy2App, type Diy2App } from '../server/app';
import { resolveConfig } from '../server/config';

const moduleDir = join(import.meta.dirname, '..');
let home = '';
let app: Diy2App;
let server: Server;
let base = '';

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'diy2-links-'));
    app = createDiy2App({
        config: resolveConfig({ moduleDir, env: { DIY2_ENV: 'development', DIY2_HOME: home } }),
        webDir: null,
    });
    server = createServer(app.handle);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('没有端口');
    base = `http://127.0.0.1:${address.port}/api`;
});

afterEach(async () => {
    app.close();
    closeServer();
    rmSync(home, { recursive: true, force: true });
});

function closeServer(): void {
    server.closeAllConnections();
    server.close();
}

function roomPath(id: string): string {
    return `/rooms/${encodeURIComponent(id)}`;
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const response = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
}

/** 新建一个任务，返回 id */
async function createTask(name: string): Promise<string> {
    const { status, body } = await call('POST', '/rooms', {
        type: 'task',
        name,
        data: { projectId: 'proj:diy' },
    });
    expect(status).toBe(200);
    return String(body.id);
}

describe('/api/rooms/:id/links', () => {
    it('建关系 → 两端都看得到，并带「#编号 标题」的显示名', async () => {
        const other = await createTask('B');
        const created = await call('POST', `${roomPath('task:t-001')}/links`, { to: other, kind: 'related' });
        expect(created.status).toBe(200);

        const mine = await call('GET', `${roomPath('task:t-001')}/links`);
        expect(mine.body.out).toEqual([{ id: other, kind: 'related', label: '#2 B', type: 'task' }]);
        expect(mine.body.in).toEqual([]);

        const theirs = await call('GET', `${roomPath(other)}/links`);
        expect(theirs.body.in).toEqual([
            { id: 'task:t-001', kind: 'related', label: '#1 任务树与多会话', type: 'task' },
        ]);
    });

    it('项目也能当另一头（显示名用项目名）', async () => {
        const created = await call('POST', `${roomPath('task:t-001')}/links`, { to: 'proj:diy', kind: 'related' });
        expect(created.status).toBe(200);
        const mine = await call('GET', `${roomPath('task:t-001')}/links`);
        expect(mine.body.out[0]).toMatchObject({ id: 'proj:diy', label: 'diy', type: 'project' });
    });

    it('kind 不合法 / 自连 / 目标不存在 → 400 或 404', async () => {
        expect((await call('POST', `${roomPath('task:t-001')}/links`, { to: 'proj:diy', kind: 'parent' })).status).toBe(
            400,
        );
        expect(
            (await call('POST', `${roomPath('task:t-001')}/links`, { to: 'task:t-001', kind: 'related' })).status,
        ).toBe(400);
        expect((await call('POST', `${roomPath('task:t-001')}/links`, { to: 'ghost', kind: 'related' })).status).toBe(
            404,
        );
    });

    it('DELETE 幂等：第一次 removed=true，第二次 false', async () => {
        const other = await createTask('B');
        await call('POST', `${roomPath('task:t-001')}/links`, { to: other, kind: 'blocks' });
        const query = `to=${encodeURIComponent(other)}&kind=blocks`;

        expect((await call('DELETE', `${roomPath('task:t-001')}/links?${query}`)).body).toEqual({ removed: true });
        expect((await call('DELETE', `${roomPath('task:t-001')}/links?${query}`)).body).toEqual({ removed: false });
    });

    it('不存在的房间 → 404', async () => {
        expect((await call('GET', `${roomPath('nope')}/links`)).status).toBe(404);
    });
});
