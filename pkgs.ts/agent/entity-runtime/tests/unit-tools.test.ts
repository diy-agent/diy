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

    it('unit_add：key 就是 id，批内任意项都能引用（含后面的项）', async () => {
        const { tools } = setup();
        const added = (await toolOf(tools, 'unit_add').execute({
            items: [
                { key: 'schema', title: '状态与原因落库', deps: ['board'] },
                { key: 'board', title: '派生量认取消' },
            ],
        })) as { added: Array<{ id: string; title: string; parent: string | null; deps: string[] }>; ready: string[] };

        expect(added.added).toEqual([
            { id: 'schema', title: '状态与原因落库', parent: null, deps: ['board'] },
            { id: 'board', title: '派生量认取消', parent: null, deps: [] },
        ]);
        // 边是 schema ← board：只有 board 可做
        expect(added.ready).toEqual(['board']);
    });

    it('悬空边：引用还没建的 key 先挂着，它一出现图就成立（并行调用也能连上）', async () => {
        const { store, tools } = setup();
        const first = (await toolOf(tools, 'unit_add').execute({
            items: [{ key: 'tool', title: 'unit_cancel 工具', deps: ['state'] }],
        })) as { ready: string[]; dangling?: string[] };
        // state 还不存在 → 边挂着，tool 没被挡（board 忽略悬空边）
        expect(first.dangling).toEqual(['state']);
        expect(first.ready).toEqual(['tool']);

        const second = (await toolOf(tools, 'unit_add').execute({
            items: [{ key: 'state', title: 'cancelled 进状态词表' }],
        })) as { ready: string[] };
        // state 到了，边立刻生效 → tool 被挡住；而 state 虽然后建（seq 更大），**不被兄弟序挡**：
        // tool 显式依赖它，兄弟序在显式边面前让步（否则两个互等，谁也做不了）
        expect(second.ready).toEqual(['state']);
        expect(store.unitDepsOf('t1')).toEqual([{ from: 'state', to: 'tool' }]);
    });

    it('一堆平铺的顶层（既无 parent 也无边）会提醒拆功能域', async () => {
        const { tools } = setup();
        const added = (await toolOf(tools, 'unit_add').execute({
            items: [
                { key: 'a', title: 'A' },
                { key: 'b', title: 'B' },
                { key: 'c', title: 'C' },
                { key: 'd', title: 'D' },
            ],
        })) as { warning?: string };
        expect(added.warning).toMatch(/平铺/);

        // 有功能域就不提醒
        const hosted = await toolOf(tools, 'unit_add').execute({
            items: [
                { key: 'dom2', title: '域' },
                { key: 'e', title: 'E', parent: 'dom2' },
            ],
        });
        expect((hosted as { warning?: string }).warning).toBeUndefined();
    });

    it('unit_add 带 parent：功能域不进 ready，子的顺序靠书写顺序', async () => {
        const { tools } = setup();
        const added = (await toolOf(tools, 'unit_add').execute({
            items: [
                { key: 'dom', title: '取消语义' },
                { key: 'a', title: 'A', parent: 'dom' },
                { key: 'b', title: 'B', parent: 'dom' },
            ],
        })) as { ready: string[] };
        expect(added.ready).toEqual(['a']);

        const listing = (await toolOf(tools, 'unit_list').execute({})) as { tree: string[] };
        expect(listing.tree).toEqual(['- [ ] 取消语义 (dom)', '  - [>] A (a)', '  - [.] B (b)  ← 等 a']);
    });

    it('功能域不能直接推状态（由子派生）', async () => {
        const { tools } = setup();
        await toolOf(tools, 'unit_add').execute({
            items: [
                { key: 'dom', title: '域' },
                { key: 'a', title: 'A', parent: 'dom' },
            ],
        });
        await expect(toolOf(tools, 'unit_update').execute({ id: 'dom', status: 'done' })).rejects.toThrow(/功能域/);
    });

    it('key 不合格 / 重名 / 撞已有 id：整批拒绝，不半截写入', async () => {
        const { store, tools } = setup();
        await expect(
            toolOf(tools, 'unit_add').execute({ items: [{ key: 'Bad Key', title: 'x' }] }),
        ).rejects.toThrow(/key 只能用/);
        await expect(
            toolOf(tools, 'unit_add').execute({
                items: [
                    { key: 'dup', title: 'x' },
                    { key: 'dup', title: 'y' },
                ],
            }),
        ).rejects.toThrow(/同批 key 重复/);

        await toolOf(tools, 'unit_add').execute({ items: [{ key: 'keep', title: 'x' }] });
        await expect(
            toolOf(tools, 'unit_add').execute({
                items: [
                    { key: 'fresh', title: 'y' },
                    { key: 'keep', title: 'z' },
                ],
            }),
        ).rejects.toThrow(/已被占用/);
        expect(store.listUnits('t1').map((unit) => unit.id)).toEqual(['keep']);
    });

    it('update 推状态：doing / done 会让后继变可做', async () => {
        const { tools } = setup();
        await toolOf(tools, 'unit_add').execute({ items: [{ key: 'a', title: 'a' }, { key: 'b', title: 'b', deps: ['a'] }] });

        await toolOf(tools, 'unit_update').execute({ id: 'a', status: 'doing' });
        const listing = (await toolOf(tools, 'unit_list').execute({})) as {
            doing: Array<{ id: string }>;
            ready: Array<{ id: string }>;
        };
        expect(listing.doing.map((item) => item.id)).toEqual(['a']);
        expect(listing.ready).toEqual([]);

        const done = (await toolOf(tools, 'unit_update').execute({ id: 'a', status: 'done' })) as { ready: string[] };
        expect(done.ready).toEqual(['b']);
    });

    it('unit_link 挡环；unit_unlink 幂等', async () => {
        const { tools } = setup();
        await toolOf(tools, 'unit_add').execute({
            items: [{ key: 'a', title: 'a' }, { key: 'b', title: 'b' }, { key: 'c', title: 'c' }],
        });
        await toolOf(tools, 'unit_link').execute({ from: 'a', to: 'b' });
        await toolOf(tools, 'unit_link').execute({ from: 'b', to: 'c' });
        await expect(toolOf(tools, 'unit_link').execute({ from: 'c', to: 'a' })).rejects.toThrow(/成环/);

        expect(((await toolOf(tools, 'unit_unlink').execute({ from: 'b', to: 'c' })) as { removed: boolean }).removed).toBe(
            true,
        );
        expect(((await toolOf(tools, 'unit_unlink').execute({ from: 'b', to: 'c' })) as { removed: boolean }).removed).toBe(
            false,
        );
    });

    it('unit_drop 真删图，但事件里留下 title + reason（取消可追溯）', async () => {
        const { store, tools } = setup();
        await toolOf(tools, 'unit_add').execute({ items: [{ key: 'a', title: 'a' }, { key: 'b', title: 'b', deps: ['a'] }] });
        const dropped = (await toolOf(tools, 'unit_drop').execute({ id: 'a', reason: '方案改了，这步不需要' })) as {
            ready: string[];
        };
        // 删前置 = 解锁后继
        expect(dropped.ready).toEqual(['b']);
        expect(store.listUnits('t1').map((unit) => unit.id)).toEqual(['b']);
        expect(store.unitDepsOf('t1')).toEqual([]);

        const events = store.eventsOf('t1', 'task.unit.');
        const removal = events.find((event) => event.event === 'task.unit.dropped');
        expect(removal?.data).toMatchObject({ id: 'a', title: 'a', reason: '方案改了，这步不需要' });
    });

    it('unit_get 给全文；unit_history 按新→旧列事件', async () => {
        const { tools } = setup();
        await toolOf(tools, 'unit_add').execute({ items: [{ key: 'a', title: 'a', body: '验收：测试全绿' }] });
        await toolOf(tools, 'unit_update').execute({ id: 'a', status: 'done' });

        const got = (await toolOf(tools, 'unit_get').execute({ id: 'a' })) as { body: string; status: string };
        expect(got.body).toBe('验收：测试全绿');
        expect(got.status).toBe('done');

        const history = (await toolOf(tools, 'unit_history').execute({ limit: 10 })) as {
            events: Array<{ event: string }>;
        };
        expect(history.events.map((event) => event.event)).toEqual(['updated', 'added']);
    });

    it('不存在的 id 报错里带出路（先 unit_list）', async () => {
        const { tools } = setup();
        await expect(toolOf(tools, 'unit_get').execute({ id: 'nope' })).rejects.toThrow(/unit_list/);
    });
});
