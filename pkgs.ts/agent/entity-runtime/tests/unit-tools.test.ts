// unit-tools.test.ts —— 任务内部 DAG 的 agent 工具（`unit_*`）：图的生长、挡环、真删 + 留痕。
//
// 只测这一层自己的契约：id 分配、依赖边、状态推进、事件落点。
// board 的推导（ready / blocked / layers）在 `units.test.ts`，不在这里重复。

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openStore } from '../src/db';
import { buildRoomTools } from '../src/tools/index';

type Executable = { execute: (input: unknown) => Promise<unknown> };

function toolOf(tools: ReturnType<typeof buildRoomTools>, name: string): Executable {
    return tools[name] as unknown as Executable;
}

let dir = '';

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'diy2-units-'));
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

/** 一个挂在上面的任务房间工具集（taskId = 任务房间 id） */
function setup(taskId = 't1') {
    const store = openStore(':memory:');
    // events.subject 有外键到 entities：任务必须先是实体（生产里房间本来就有身份行）
    store.saveTask({
        id: taskId,
        title: '任务',
        summary: '',
        body: '',
        projectId: null,
        workspace: null,
        status: 'open',
        closedAt: null,
        modelKey: 'm',
    });
    const tools = buildRoomTools({ cwd: dir, shell: false, units: { store, taskId } });
    return { store, tools };
}

describe('unit 工具', () => {
    it('没有 units 落点就没有 unit_* 工具（非任务房间）', () => {
        const tools = buildRoomTools({ cwd: dir, shell: false });
        expect(tools['unit_add']).toBeUndefined();
        expect(tools['unit_list']).toBeUndefined();
    });

    it('unit_add 一次长一批：批内可用 key 引用前面的项（边建好）；ID 按 u1 / u2 走', async () => {
        const { tools } = setup();
        const added = (await toolOf(tools, 'unit_add').execute({
            items: [
                { key: 'read', title: '读现状' },
                { title: '写数据层', deps: ['read'] },
            ],
        })) as { added: Array<{ id: string; title: string }>; ready: string[] };

        expect(added.added).toEqual([
            { id: 'u1', title: '读现状' },
            { id: 'u2', title: '写数据层' },
        ]);
        // 只有 u1 可做：u2 被 u1 挡着
        expect(added.ready).toEqual(['u1']);
    });

    it('批内引用只能在前面：指向后面的 key 或不存在的前置都被拒', async () => {
        const { store, tools } = setup();
        await expect(
            toolOf(tools, 'unit_add').execute({
                items: [
                    { title: 'a', deps: ['later'] },
                    { key: 'later', title: 'b' },
                ],
            }),
        ).rejects.toThrow(/前面/);
        await expect(toolOf(tools, 'unit_add').execute({ items: [{ title: 'c', deps: ['u9'] }] })).rejects.toThrow(
            /不存在/,
        );
        // 两个错的第一项就坏 → 图上没有半截
        expect(store.listUnits('t1')).toEqual([]);
    });

    it('update 推状态：doing / done 会让后继变可做', async () => {
        const { tools } = setup();
        await toolOf(tools, 'unit_add').execute({ items: [{ title: 'a' }, { title: 'b', deps: ['u1'] }] });

        await toolOf(tools, 'unit_update').execute({ id: 'u1', status: 'doing' });
        const listing = (await toolOf(tools, 'unit_list').execute({})) as { doing: string[]; ready: string[] };
        expect(listing.doing).toEqual(['u1']);
        expect(listing.ready).toEqual([]);

        const done = (await toolOf(tools, 'unit_update').execute({ id: 'u1', status: 'done' })) as { ready: string[] };
        expect(done.ready).toEqual(['u2']);
    });

    it('unit_link 挡环；unit_unlink 幂等', async () => {
        const { tools } = setup();
        await toolOf(tools, 'unit_add').execute({ items: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] });
        await toolOf(tools, 'unit_link').execute({ from: 'u1', to: 'u2' });
        await toolOf(tools, 'unit_link').execute({ from: 'u2', to: 'u3' });
        await expect(toolOf(tools, 'unit_link').execute({ from: 'u3', to: 'u1' })).rejects.toThrow(/成环/);

        expect(((await toolOf(tools, 'unit_unlink').execute({ from: 'u2', to: 'u3' })) as { removed: boolean }).removed).toBe(
            true,
        );
        expect(((await toolOf(tools, 'unit_unlink').execute({ from: 'u2', to: 'u3' })) as { removed: boolean }).removed).toBe(
            false,
        );
    });

    it('unit_drop 真删图，但事件里留下 title + reason（取消可追溯）', async () => {
        const { store, tools } = setup();
        await toolOf(tools, 'unit_add').execute({ items: [{ title: 'a' }, { title: 'b', deps: ['u1'] }] });
        const dropped = (await toolOf(tools, 'unit_drop').execute({ id: 'u1', reason: '方案改了，这步不需要' })) as {
            ready: string[];
        };
        // 删前置 = 解锁后继
        expect(dropped.ready).toEqual(['u2']);
        expect(store.listUnits('t1').map((unit) => unit.id)).toEqual(['u2']);
        expect(store.unitDepsOf('t1')).toEqual([]);

        const events = store.eventsOf('t1', 'task.unit.');
        const removal = events.find((event) => event.event === 'task.unit.dropped');
        expect(removal?.data).toMatchObject({ id: 'u1', title: 'a', reason: '方案改了，这步不需要' });
    });

    it('unit_get 给全文；unit_history 按新→旧列事件', async () => {
        const { tools } = setup();
        await toolOf(tools, 'unit_add').execute({ items: [{ title: 'a', body: '验收：测试全绿' }] });
        await toolOf(tools, 'unit_update').execute({ id: 'u1', status: 'done' });

        const got = (await toolOf(tools, 'unit_get').execute({ id: 'u1' })) as { body: string; status: string };
        expect(got.body).toBe('验收：测试全绿');
        expect(got.status).toBe('done');

        const history = (await toolOf(tools, 'unit_history').execute({ limit: 10 })) as {
            events: Array<{ event: string }>;
        };
        expect(history.events.map((event) => event.event)).toEqual(['updated', 'added']);
    });

    it('不存在的 id 报错里带出路（先 unit_list）', async () => {
        const { tools } = setup();
        await expect(toolOf(tools, 'unit_get').execute({ id: 'u7' })).rejects.toThrow(/unit_list/);
    });
});
