// unit-tools.test.ts —— 任务「需求账本树」的 agent 工具（`unit_*`）：长树、改条目、真删 + 留痕。
//
// 只测这一层自己的契约：id 分配、树形（parent）、状态推进、事件落点。
// board 的推导（ready / 母项派生）在 `units.test.ts`，不在这里重复。
//
// 2026-11-25 裁：账本不记执行规划 —— 依赖边（`unit_link`）与交付批次（`batch_*`）整体删掉，
// 所以这里也不再有用例去钉「挡环」「批次阶段」那些行为；工具面从 12 个降到 6 个。

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
function setup(taskId = 't1', extra: { sourceOf?: () => string | undefined } = {}) {
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
    const tools = buildRoomTools({ cwd: dir, shell: false, units: { store, taskId, ...extra } });
    return { store, tools };
}

describe('unit 工具', () => {
    it('没有 units 落点就没有 unit_* 工具（非任务房间）', () => {
        const tools = buildRoomTools({ cwd: dir, shell: false });
        expect(tools['unit_add']).toBeUndefined();
        expect(tools['unit_list']).toBeUndefined();
    });

    it('工具面只剩账本读写：没有 link / batch 这类排期工具', () => {
        const { tools } = setup();
        const names = Object.keys(tools).filter((name) => name.startsWith('unit_') || name.startsWith('batch_'));
        expect(names.sort()).toEqual(['unit_add', 'unit_drop', 'unit_get', 'unit_history', 'unit_list', 'unit_update']);
    });

    it('unit_add：key 就是 id，同批任意项都能当 parent（含后面的项）', async () => {
        const { tools } = setup();
        const added = (await toolOf(tools, 'unit_add').execute({
            items: [
                { key: 'leaf', title: '先写出来的那条', parent: 'dom' },
                { key: 'dom', title: '母项' },
            ],
        })) as { added: Array<{ id: string; title: string; parent: string | null }>; ready: string[] };

        expect(added.added).toEqual([
            { id: 'leaf', title: '先写出来的那条', parent: 'dom' },
            { id: 'dom', title: '母项', parent: null },
        ]);
        // 母项不执行 → 只有叶子能挑
        expect(added.ready).toEqual(['leaf']);
    });

    it('一堆平铺的顶层（没有 parent）会提醒拆母项', async () => {
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

        // 有母项就不提醒
        const hosted = await toolOf(tools, 'unit_add').execute({
            items: [
                { key: 'dom2', title: '母项' },
                { key: 'e', title: 'E', parent: 'dom2' },
            ],
        });
        expect((hosted as { warning?: string }).warning).toBeUndefined();
    });

    it('树形：母项不进 ready，缩进就是层级；树里没有「等谁」这种排期信息', async () => {
        const { tools } = setup();
        const added = (await toolOf(tools, 'unit_add').execute({
            items: [
                { key: 'dom', title: '取消语义' },
                { key: 'a', title: 'A', parent: 'dom', accept: '有单测' },
                { key: 'b', title: 'B', parent: 'dom', accept: '有单测' },
            ],
        })) as { ready: string[] };
        // 两条叶子都能挑：账本不定先后
        expect(added.ready).toEqual(['a', 'b']);

        const listing = (await toolOf(tools, 'unit_list').execute({})) as { tree: string[] };
        expect(listing.tree).toEqual(['- [ ] 取消语义 (dom)', '  - [>] A (a)', '  - [>] B (b)']);
    });

    it('工具面没有「追加进展」的入口：update 只认需求字段（进展归 journal）', async () => {
        // 用户 2026-11-26：账本被当成 log 的嫌疑，一半来自「什么都能往里写」。
        // 这里钉住入口本身：unit_update 的入参里**没有** note / comment / progress / log 这类字段，
        // 想记进展只能写 journal（那不是账本）。加字段的人会被这条测试拦住。
        const { tools } = setup();
        const update = toolOf(tools, 'unit_update') as unknown as { inputSchema: { shape: Record<string, unknown> } };
        expect(Object.keys(update.inputSchema.shape).sort()).toEqual([
            'accept',
            'body',
            'id',
            // kind：need ↔ step 的显式转换（2026-11-27 分层后加的）—— 它不是「进展」字段，
            // 改的是这条条目的**种类**，所以不违反上面那条约束
            'kind',
            'parent',
            'status',
            'title',
        ]);
        for (const forbidden of ['note', 'comment', 'progress', 'log', 'update', 'latest', 'changes']) {
            expect(Object.keys(update.inputSchema.shape)).not.toContain(forbidden);
        }
    });

    it('unit_add 自动盖「来自哪句话」（宿主给的触发消息），模型不用也不能填', async () => {
        const { tools } = setup('t1', { sourceOf: () => 'u-mwwtvgiy-7' });
        const added = (await toolOf(tools, 'unit_add').execute({
            items: [{ key: 'a', title: '导出可用', accept: '点一下真落文件' }],
        })) as { added: Array<{ id: string }> };
        const got = (await toolOf(tools, 'unit_get').execute({ id: added.added[0]!.id })) as { source: string };
        expect(got.source).toBe('u-mwwtvgiy-7');
    });

    it('母项不能直接推状态（由子派生）', async () => {
        const { tools } = setup();
        await toolOf(tools, 'unit_add').execute({
            items: [
                { key: 'dom', title: '母项' },
                { key: 'a', title: 'A', parent: 'dom' },
            ],
        });
        await expect(toolOf(tools, 'unit_update').execute({ id: 'dom', status: 'done' })).rejects.toThrow(/母项/);
    });

    it('key 不合格 / 重名 / 撞已有 id：整批拒绝，不半截写入', async () => {
        const { store, tools } = setup();
        await expect(toolOf(tools, 'unit_add').execute({ items: [{ key: 'Bad Key', title: 'x' }] })).rejects.toThrow(
            /key 只能用/,
        );
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

    it('update 推状态：doing / done 只影响自己那一格（不再牵动别的条目）', async () => {
        const { tools } = setup();
        await toolOf(tools, 'unit_add').execute({
            items: [
                { key: 'a', title: 'a' },
                { key: 'b', title: 'b' },
            ],
        });

        await toolOf(tools, 'unit_update').execute({ id: 'a', status: 'doing' });
        const listing = (await toolOf(tools, 'unit_list').execute({})) as {
            doing: Array<{ id: string }>;
            ready: Array<{ id: string }>;
        };
        expect(listing.doing.map((item) => item.id)).toEqual(['a']);
        // b 一直都能挑：账本里没有「a 没做完所以 b 不能做」
        expect(listing.ready.map((item) => item.id)).toEqual(['b']);

        const done = (await toolOf(tools, 'unit_update').execute({ id: 'a', status: 'done' })) as { ready: string[] };
        expect(done.ready).toEqual(['b']);
    });

    it('unit_drop 真删，母项的子提升到它的位置；事件里留下 title + reason', async () => {
        const { store, tools } = setup();
        await toolOf(tools, 'unit_add').execute({
            items: [
                { key: 'dom', title: '母项' },
                { key: 'a', title: 'A', parent: 'dom' },
            ],
        });
        const dropped = (await toolOf(tools, 'unit_drop').execute({
            id: 'dom',
            reason: '这层分得太细，不需要母项了',
        })) as { promoted: string[] };
        expect(dropped.promoted).toEqual(['a']);
        expect(store.listUnits('t1').map((unit) => unit.id)).toEqual(['a']);
        // 子还在，并且升成顶层（不连带删除）
        expect(store.unitOf('t1', 'a')?.parent).toBeNull();

        const removal = store.eventsOf('t1', 'task.unit.').find((event) => event.event === 'task.unit.dropped');
        expect(removal?.data).toMatchObject({ id: 'dom', title: '母项', reason: '这层分得太细，不需要母项了' });
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
        expect(history.events.map((event) => event.event)).toEqual(['unit.updated', 'unit.added']);
    });

    it('不存在的 id 报错里带出路（先 unit_list）', async () => {
        const { tools } = setup();
        await expect(toolOf(tools, 'unit_get').execute({ id: 'nope' })).rejects.toThrow(/unit_list/);
    });
});
