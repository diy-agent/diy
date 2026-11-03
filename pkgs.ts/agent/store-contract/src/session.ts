// session.ts — SessionStore 契约：**一份用例**，每个实现都跑同一批（##506）
//
// 为什么要有这个包：jsonl 与 memory 各自写了几百行意图测试，两份重合度为 0 ——
// 同一个接口的语义（追加连续 / 越界不返回 / 半批不写）在两边各写一次，改了一个
// 人忘了另一个，差异就靠人肉发现。契约测试把「接口语义」抽成共享用例：
//
//   // diy-agent-session-store-jsonl/tests/contract.test.ts
//   defineSessionStoreContract('jsonl', () => openJsonlSessionStore({ dir: mkdtemp() }));
//
// 边界：**只测接口语义**。实现特有的行为（jsonl 切桶 / memory 容量上限 / 零落盘）
// 不进契约，留在各包自己的 intent.store.test.ts 里 —— 那些不是「契约」，是「本实现的承诺」。
//
// 判据（##506 判据 4）：故意改坏任一实现的行为，**两边都该红**。
// 两边同时红才证明用例真的共享，否则只是两份长得像的测试。

import { describe, expect, it } from 'vitest';
import type { ChatMessage, SessionStore } from '@diy-agent/session';

/** 契约用固定时刻（毫秒）：不取真时间，readRange 的边界才可复算 */
const T0 = Date.UTC(2026, 9, 30, 0, 0, 0);

function message(seq: number, text: string, at = T0 + seq * 1000): ChatMessage {
    return { seq, role: 'user', type: 'human', text, at };
}

/**
 * 取「抛没抛 / 抛的 code」：同步抛（memory 实现）与异步拒（jsonl 实现）都归一成被拒的 Promise。
 * 不直接用 `expect(fn()).rejects`——内存实现的 append 是同步方法，同步 throw 会让断言拿不到 Promise。
 */
async function codeOf(run: () => unknown): Promise<unknown> {
    try {
        await run();
    } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error) {
            return (error as { code: unknown }).code;
        }
        return `not-a-coded-error: ${String(error)}`;
    }
    return undefined;
}

/**
 * 声明「这个实现满足 SessionStore 契约」。
 *
 * @param name      实现名（进 describe 标题，红了能一眼看出是哪个实现）
 * @param makeStore 每次调用都返回一个**全新的空 store**（每个用例独立，不共享状态）
 */
export function defineSessionStoreContract(name: string, makeStore: () => SessionStore | Promise<SessionStore>): void {
    describe(`${name} 满足 SessionStore 契约`, () => {
        it('空 store：latestSeq() = 0，readFrom(0) = []', async () => {
            const store = await makeStore();
            expect(await store.latestSeq()).toBe(0);
            expect(await store.readFrom(0)).toEqual([]);
        });

        it('append 后 readFrom(0) 逐条还原，字段原样（含 data 槽）', async () => {
            const store = await makeStore();
            const batch: ChatMessage[] = [
                message(1, '甲'),
                { seq: 2, role: 'assistant', type: 'agent-conclusion', text: '乙', at: T0 + 2000 },
                { seq: 3, role: 'tool', type: 'tool-result', data: { ok: true, items: [1, 2] }, at: T0 + 3000 },
            ];
            await store.append(batch);
            expect(await store.latestSeq()).toBe(3);
            expect(await store.readFrom(0)).toEqual(batch);
        });

        it('readFrom(k) 只返回 seq > k 的，且按 seq 升序', async () => {
            const store = await makeStore();
            await store.append([message(1, 'a'), message(2, 'b'), message(3, 'c')]);
            expect((await store.readFrom(1)).map((item) => item.seq)).toEqual([2, 3]);
            expect((await store.readFrom(2)).map((item) => item.seq)).toEqual([3]);
            expect(await store.readFrom(3)).toEqual([]);
        });

        // at 与 seq 同向递增是**接口前提**（`SessionStore.readRange` 头注：按桶的 fromAt/toAt 二分剪枝）。
        // 非单调的 at 不纳入契约：jsonl 的分桶剪枝会据此漏读（##506 实测：at 回退的写入在单点区间读不到）。
        it('readRange({from,to}) 按 at 闭区间（两端都含），结果按 at 升序', async () => {
            const store = await makeStore();
            await store.append([message(1, '甲', T0 + 500), message(2, '乙', T0 + 1000), message(3, '丙', T0 + 5000)]);
            expect((await store.readRange({ from: T0, to: T0 + 1000 })).map((item) => item.text)).toEqual(['甲', '乙']);
            // 单点闭区间：两端都含
            expect((await store.readRange({ from: T0 + 500, to: T0 + 500 })).map((item) => item.text)).toEqual(['甲']);
            expect(await store.readRange({ from: T0 + 6000, to: T0 + 7000 })).toEqual([]);
        });

        it('append([]) 是 no-op（不报错、不改进度）', async () => {
            const store = await makeStore();
            await store.append([]);
            expect(await store.latestSeq()).toBe(0);
            expect(await store.readFrom(0)).toEqual([]);
        });

        it('缺 seq ⇒ store/message-without-seq', async () => {
            const store = await makeStore();
            expect(await codeOf(() => store.append([{ role: 'user', text: '没有 seq' }]))).toBe(
                'store/message-without-seq',
            );
        });

        it('seq 不连续 / 重号 ⇒ store/gap，且**半批一条都不写**（先全量校验再写）', async () => {
            const store = await makeStore();
            await store.append([message(1, 'a')]);
            // 断号：2 缺失
            expect(await codeOf(() => store.append([message(2, 'b'), message(4, '跳号')]))).toBe('store/gap');
            // 重号
            expect(await codeOf(() => store.append([message(1, '重号')]))).toBe('store/gap');
            // 半批没写进去：进度仍是 1，读到的也只有 a
            expect(await store.latestSeq()).toBe(1);
            expect((await store.readFrom(0)).map((item) => item.text)).toEqual(['a']);
        });

        it('readFrom 入参非法（负数 / 非整数）⇒ store/invalid-options', async () => {
            const store = await makeStore();
            expect(await codeOf(() => store.readFrom(-1))).toBe('store/invalid-options');
            expect(await codeOf(() => store.readFrom(1.5))).toBe('store/invalid-options');
        });

        it('readRange 入参非法（反向 / 非有限数）⇒ store/invalid-options', async () => {
            const store = await makeStore();
            expect(await codeOf(() => store.readRange({ from: T0 + 1000, to: T0 }))).toBe('store/invalid-options');
            expect(await codeOf(() => store.readRange({ from: Number.NaN, to: T0 }))).toBe('store/invalid-options');
        });
    });
}
