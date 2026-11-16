// api.test.ts — 函数层（`useKind`）：契约 → 静态类型的方法，调用即得值。
//
// 两条主轴：
//   1. **运行时**：得值 / 失败抛 `ActorError` / 长活回受理回执 / `$on` 不补历史；
//   2. **编译期**：名字拼错、字段写错、只读结果 —— 这些用 `@ts-expect-error` 钉住，
//      由 `tsc --noEmit`（本包 tsconfig 含 tests/）验，不靠运行时断言。

import { describe, expect, it } from 'vitest';

import {
    ActorError,
    createLocalActor,
    useKind,
    type CmdValue,
    type Cursor,
    type EventOf,
    type QueryOutput,
} from '../src/index.js';

import { counterKind } from './support/fixtures.js';

async function connect() {
    const { client, actor } = await createLocalActor({ kind: counterKind, uri: 'test://counter' });
    return { counter: useKind(counterKind, client), client, actor };
}

describe('函数层 useKind', () => {
    it('命令与查询直接得值，不用再拆 Outcome', async () => {
        const { counter, actor } = await connect();
        expect(await counter.add({ by: 2 })).toEqual({ n: 2 });
        expect(await counter.get({})).toEqual({ n: 2 });
        await actor.close();
    });

    it('入参没有字段时可以不带实参（`z.object({})` / `z.void()`）', async () => {
        const { counter, actor } = await connect();
        await counter.add({ by: 3 });
        expect(await counter.reset()).toBeUndefined(); // output 是 z.void()
        expect(await counter.get({})).toEqual({ n: 0 });
        await actor.close();
    });

    it('失败抛 ActorError，code 与 retryable 原样带上来', async () => {
        const { counter, actor } = await connect();
        // 1.5 过不了 `z.number().int()` —— 拒绝发生在 actor 里（E_INVALID_ARGUMENT）
        const err = await counter.add({ by: 1.5 }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ActorError);
        expect((err as ActorError).code).toBe('E_INVALID_ARGUMENT');
        expect((err as ActorError).retryable).toBe(false);
        await actor.close();
    });

    it('长活命令回受理回执，真结果从事件流里来', async () => {
        const { counter, actor } = await connect();

        const seen: number[] = [];
        const off = counter.$on('added', (e) => seen.push(e.n)); // 先订阅：$on 不补历史

        const accepted = await counter.slowAdd({ by: 5 });
        expect(accepted.accepted).toBe(true);
        expect(accepted.at).toBe('e0'); // 受理位置：这时还没提交

        await waitFor(() => seen.length === 1); // 长活排到队列尾，稍后才落
        expect(seen).toEqual([5]);
        expect(await counter.get({})).toEqual({ n: 5 });

        off();
        await actor.close();
    });

    it('$on 只收订阅之后的，$watch 会补历史', async () => {
        const { counter, actor } = await connect();
        await counter.add({ by: 1 }); // 订阅之前就发生的

        const live: string[] = [];
        const off = counter.$on('added', (e) => live.push(`${e.by}→${e.n}`));
        await counter.add({ by: 2 });
        await waitFor(() => live.length === 1);
        expect(live).toEqual(['2→3']); // 只有订阅之后那一条

        const replayed: string[] = [];
        for await (const event of counter.$watch({ include: ['added'] })) {
            replayed.push(`${event.data.by}→${event.data.n}`);
            if (replayed.length === 2) break;
        }
        expect(replayed).toEqual(['1→1', '2→3']); // 历史两条都在

        off();
        await actor.close();
    });

    it('$client 是同一个 raw 层实例（要 Outcome 时不必重新接线）', async () => {
        const { counter, client, actor } = await connect();
        expect(counter.$client).toBe(client);
        // raw 层的不抛异常语义还在：同一个失败，这里是返回值
        const outcome = await counter.$client.cmd('add', { by: 1.5 });
        expect(outcome.ok).toBe(false);
        await actor.close();
    });
});

// ── 编译期断言：这些不该通过类型检查（tsc 会验，运行时不会跑到）──────────────
// 用一个从不调用的函数装着：`tsc --noEmit` 会检查函数体，vitest 永远不会执行它。
async function typeChecks(): Promise<void> {
    // 声明层那几道锁在 `tests/types.lock.ts`（名字封闭 / 入参精确 / raw 层同样校验），
    // 这里只锁函数层自己：契约里的方法一个不多一个不少。

    const { counter } = await connect();

    // @ts-expect-error 没有这个命令
    await counter.nope({});
    // @ts-expect-error 入参字段写错
    await counter.add({ byN: 1 });
    // @ts-expect-error 入参缺字段
    await counter.add({});
    // @ts-expect-error 查询的入参也校验
    await counter.get({ n: 1 });

    // 得值就是得值：`n` 是 number，不是 unknown
    const { n } = await counter.add({ by: 1 });
    const doubled: number = n * 2;
    void doubled;

    // 长活：类型上就没有 `n`，只有受理位置
    const slow = await counter.slowAdd({ by: 1 });
    // @ts-expect-error 长活没有输出值
    void slow.n;

    // 事件载荷有类型（按 name 判别）
    counter.$on('added', (e) => {
        const by: number = e.by;
        void by;
        // @ts-expect-error 事件里没有这个字段
        void e.nope;
    });

    // 导出类型能单独用
    type N = QueryOutput<typeof counterKind, 'get'>['n'];
    const _n: N = 1;
    void _n;
    type Slow = CmdValue<typeof counterKind, 'slowAdd'>;
    const _s: Slow = { accepted: true, at: 'e0' as Cursor };
    void _s;
    type Added = EventOf<typeof counterKind, 'added'>['data'];
    const _a: Added = { by: 1, n: 1 };
    void _a;
}
void typeChecks;

/** 等一个条件成立（长活的提交排在队列尾，不能立刻断言） */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('waitFor 超时');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
