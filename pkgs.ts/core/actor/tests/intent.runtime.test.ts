// intent.runtime.test.ts — 执行语义：串行、幂等、拒绝、事件、长活。
//
// 每条都在回答「如果没有这条不变量，会出什么事」。

import { describe, expect, it } from 'vitest';

import { COMMAND_FINISHED, COMMAND_STATUS, FAULT, createLocalActor, type CmdOutcome } from '../src/index.js';
import { counterKind } from './support/fixtures.js';

const data = <T>(outcome: CmdOutcome<T>): T => {
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.accepted) throw new Error('期望 done 回执');
    return outcome.data;
};

describe('串行队列：读—改—写 是一个原子', () => {
    it('20 个并发 add 全部生效（handler 中间让出了事件循环，没队列就会丢）', async () => {
        const { client } = await createLocalActor({ kind: counterKind, uri: 'diy://local/counter' });
        await Promise.all(Array.from({ length: 20 }, () => client.cmd('add', { by: 1 })));
        const got = await client.query('get', {});
        expect(got.ok && got.data).toEqual({ n: 20 });
    });

    it('读也排队：读不到「命令改了一半」的中间态', async () => {
        const { client } = await createLocalActor({ kind: counterKind, uri: 'diy://local/counter' });
        // 命令和查询同时发出：查询必须看到 0 或 1，绝不能看到「已经读了 base 还没提交」
        const [cmdOutcome, query] = await Promise.all([client.cmd('add', { by: 5 }), client.query('get', {})]);
        expect(data(cmdOutcome)).toEqual({ n: 5 });
        expect(query.ok && query.data).toEqual({ n: 5 });
    });
});

describe('幂等：同一个 commandId 只应用一次', () => {
    it('重发同一命令 → 同一条回执，状态只变一次', async () => {
        const { client } = await createLocalActor({ kind: counterKind, uri: 'diy://local/counter' });
        const first = await client.cmd('add', { by: 1 }, { commandId: 'c_fixed' as never });
        const second = await client.cmd('add', { by: 1 }, { commandId: 'c_fixed' as never });
        expect(data(first)).toEqual({ n: 1 });
        expect(second.ok && !second.accepted && second.seq).toBe(first.ok && !first.accepted ? first.seq : 'x');
        expect(await client.query('get', {})).toMatchObject({ ok: true, data: { n: 1 } });
    });

    it('新 commandId = 新命令（幂等不是“同名去重”）', async () => {
        const { client } = await createLocalActor({ kind: counterKind, uri: 'diy://local/counter' });
        await client.cmd('add', { by: 1 });
        await client.cmd('add', { by: 1 });
        expect(await client.query('get', {})).toMatchObject({ ok: true, data: { n: 2 } });
    });
});

describe('入参不成立 = rejected（没进 handler，状态不动）', () => {
    it('schema 不符回 E_INVALID_ARGUMENT，且带 issue 路径', async () => {
        const { actor, client } = await createLocalActor({ kind: counterKind, uri: 'diy://local/counter' });
        const outcome = await client.cmd('add', { by: 'ten' } as never);
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.code).toBe('E_INVALID_ARGUMENT');
        expect(actor.snapshot().state).toEqual({ n: 0 });
    });

    it('未声明的方法回 E_UNKNOWN_METHOD（不是崩，也不是静默成功）', async () => {
        const { client } = await createLocalActor({ kind: counterKind, uri: 'diy://local/counter' });
        const outcome = await client.rawQuery('nope', {});
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.code).toBe('E_UNKNOWN_METHOD');
    });
});

describe('事件 + watch', () => {
    it('事件 seq 单调，能按 after 补历史', async () => {
        const { client } = await createLocalActor({ kind: counterKind, uri: 'diy://local/counter' });
        await client.cmd('add', { by: 1 });
        await client.cmd('add', { by: 2 });

        const all = await client.rawQuery('$events', {});
        if (!all.ok) throw new Error(all.message);
        const events = (all.data as { events: { seq: string; name: string; data: { n: number } }[] }).events;
        expect(events.map((e) => e.name)).toEqual(['added', 'added']);
        expect(events.map((e) => e.data.n)).toEqual([1, 3]);

        const tail = await client.rawQuery('$events', { after: events[0]!.seq });
        if (!tail.ok) throw new Error(tail.message);
        expect((tail.data as { events: unknown[] }).events).toHaveLength(1);
    });

    it('watch 先补历史再接实时，同一条只出一次', async () => {
        const { client } = await createLocalActor({ kind: counterKind, uri: 'diy://local/counter' });
        await client.cmd('add', { by: 1 });

        const seen: unknown[] = [];
        const done = (async () => {
            for await (const event of client.watch({ include: ['added'] })) {
                seen.push(event.data);
                if (seen.length === 2) return;
            }
        })();
        await new Promise((r) => setTimeout(r, 5));
        await client.cmd('add', { by: 1 });
        await done;
        expect(seen).toEqual([
            { by: 1, n: 1 },
            { by: 1, n: 2 },
        ]);
    });
});

describe('长活：accepted + $command.finished', () => {
    it('deferred 命令立刻回 accepted，收尾发 $command.finished', async () => {
        const { client } = await createLocalActor({ kind: counterKind, uri: 'diy://local/counter' });
        const accepted = await client.cmd('slowAdd', { by: 4 });
        expect(accepted.ok && accepted.accepted).toBe(true);

        const finished = await waitFor(async () => {
            const page = await client.rawQuery('$events', { include: [COMMAND_FINISHED] });
            const events = (page as { data: { events: { data: { ok: boolean } }[] } }).data.events;
            return events.length > 0 ? events[0]!.data : null;
        });
        expect(finished).toMatchObject({ ok: true });
        expect(await client.query('get', {})).toMatchObject({ ok: true, data: { n: 4 } });
    });

    it('$command.status 能冷补：running 之后变 done', async () => {
        const { client } = await createLocalActor({ kind: counterKind, uri: 'diy://local/counter' });
        await client.cmd('slowAdd', { by: 1 }, { commandId: 'c_slow' as never });
        const done = await waitFor(async () => {
            const status = await client.rawQuery(COMMAND_STATUS, { commandId: 'c_slow' });
            const value = (status as { data: { status: string } }).data.status;
            return value === 'done' ? value : null;
        });
        expect(done).toBe('done');
    });

    it('后续单元失败不会被吞：落 $fault + $command.finished ok:false', async () => {
        const { client } = await createLocalActor({ kind: counterKind, uri: 'diy://local/counter' });
        const accepted = await client.cmd('slowFail', {});
        expect(accepted.ok && accepted.accepted).toBe(true);

        const fault = await waitFor(async () => {
            const page = await client.rawQuery('$events', { include: [FAULT] });
            const events = (page as { data: { events: { data: { code: string } }[] } }).data.events;
            return events.length > 0 ? events[0]!.data : null;
        });
        expect(fault).toMatchObject({ code: 'E_INTERNAL' });

        const finished = await waitFor(async () => {
            const page = await client.rawQuery('$events', { include: [COMMAND_FINISHED] });
            const events = (page as { data: { events: { data: { ok: boolean } }[] } }).data.events;
            return events.length > 0 ? events[0]!.data : null;
        });
        expect(finished).toMatchObject({ ok: false });
    });
});

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 500): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await probe();
        if (value !== null) return value;
        if (Date.now() > deadline) throw new Error('等待超时');
        await new Promise((r) => setTimeout(r, 5));
    }
}
