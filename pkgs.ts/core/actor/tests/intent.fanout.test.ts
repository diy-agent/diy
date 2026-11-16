// intent.fanout.test.ts — 多目标：**「读不到」必须在 data 里有它自己的一项**。
//
// 这两个断言是这条协议最容易被改坏的地方：
//   1. 有 target 掉线 → 仍是 `ok`（业务答案完整，只是其中一项是 unknown）；
//   2. 全部掉线     → `err E_UNAVAILABLE`（一条答案都没拿到，这才是执行失败）。

import { describe, expect, it } from 'vitest';

import { allFailed, createLocalActor, createLocalPort, mapEach, type ActorClient, type Kind } from '../src/index.js';
import { liveKind, roomKind } from './support/fixtures.js';

async function buildRoom() {
    const alice = await createLocalActor({ kind: liveKind, uri: 'diy://node-a/alice' });
    const bob = await createLocalActor({ kind: liveKind, uri: 'diy://node-b/bob' });
    await alice.client.cmd('set', { label: 'rg -n todo', running: true });
    await bob.client.cmd('set', { label: '', running: false });

    const clients = new Map<string, ActorClient<Kind>>([
        ['diy://node-a/alice', alice.client as ActorClient<Kind>],
        ['diy://node-b/bob', bob.client as ActorClient<Kind>],
    ]);

    const room = await createLocalActor({
        kind: roomKind,
        uri: 'diy://node-hub/task/t1',
        // 找不到的 target（掉线节点）由 port 抛 E_NOT_FOUND → 折成一项 answered:false
        port: createLocalPort((target) => clients.get(target)),
    });
    return { room, alice, bob };
}

describe('扇出：逐项状态 + 执行回执', () => {
    it('3 个成员、1 个节点掉线 → 仍 ok，掉线那位是 unknown（不是 idle）', async () => {
        const { room } = await buildRoom();
        await room.client.cmd('join', { memberId: 'alice', target: 'diy://node-a/alice' });
        await room.client.cmd('join', { memberId: 'bob', target: 'diy://node-b/bob' });
        await room.client.cmd('join', { memberId: 'carol', target: 'diy://node-c/carol' }); // 这个 target 没人接

        const roster = await room.client.query('roster', {});
        expect(roster.ok).toBe(true);
        if (!roster.ok) return;

        expect(roster.data.members).toEqual([
            { memberId: 'alice', state: 'running', label: 'rg -n todo' },
            { memberId: 'bob', state: 'idle', label: '' },
            { memberId: 'carol', state: 'unknown', reason: 'E_NOT_FOUND' },
        ]);

        // 执行回执：每个 target 一条，掉线那条带 code
        expect(roster.meta?.fanout).toHaveLength(3);
        expect(roster.meta?.fanout?.find((r) => r.target === 'diy://node-c/carol')).toMatchObject({
            ok: false,
            code: 'E_NOT_FOUND',
        });
        // 业务答案的水位仍然是这次查询读到的位置（回执不改业务语义）
        expect(roster.stale).toBe(false);
    });

    it('全部掉线 → err E_UNAVAILABLE（一条答案都没拿到）', async () => {
        const { room } = await buildRoom();
        await room.client.cmd('join', { memberId: 'dave', target: 'diy://node-d/dave' });
        await room.client.cmd('join', { memberId: 'erin', target: 'diy://node-e/erin' });

        const roster = await room.client.query('roster', {});
        expect(roster.ok).toBe(false);
        if (roster.ok) return;
        expect(roster.code).toBe('E_UNAVAILABLE');
        expect(roster.retryable).toBe(true);
    });

    it('成员表为空 → 合法的空答案（ok，不是 err）', async () => {
        const { room } = await buildRoom();
        const roster = await room.client.query('roster', {});
        expect(roster.ok && roster.data).toEqual({ members: [] });
    });
});

describe('扇出的类型级防护', () => {
    it('mapEach 两个分支都必给：不可能「读不到就当没有」', async () => {
        const results = [
            { target: { target: 'a', memberId: 'm1' }, answered: true as const, value: 1 },
            {
                target: { target: 'b', memberId: 'm2' },
                answered: false as const,
                code: 'E_TIMEOUT' as const,
                message: '超时',
            },
        ];
        const rows = mapEach(
            results,
            (value, target) => `${target.memberId}:${value}`,
            (code, _message, target) => `${target.memberId}:unknown(${code})`,
        );
        expect(rows).toEqual(['m1:1', 'm2:unknown(E_TIMEOUT)']);
        expect(allFailed(results)).toBe(false);
        expect(allFailed([results[1]!])).toBe(true);
    });
});
