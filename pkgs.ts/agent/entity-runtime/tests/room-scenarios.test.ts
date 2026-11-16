// room-scenarios.test.ts —— 锁住「房间级停法」：每轮判得对、时间线不串、不凭空多条目。
//
// 这些场景手测几乎复现不了（要两只 bot 恰好同时跑到不同结局、还要卡在同一个水位上），
// 所以样本就是事件流：判据一改这里先红，重放逻辑一改（忘了全局重排 seq、把一轮重放
// 两次）这里也先红。
//
// **页脚位置**不在这里断 —— 那是前端的事（`chat-core`）：它自己有「多段只挂一次 /
// completed 不挂 / 没说话退到 notice」的单测，这里只锁运行侧的事实。

import { describe, expect, it } from 'vitest';

import { ROOM_SCENARIOS, replayRoom } from '../src/room-scenarios';

describe('房间级停法', () => {
    it('样本不为空，且每条都有明确的期望', () => {
        expect(ROOM_SCENARIOS.length).toBeGreaterThanOrEqual(5);
        for (const scenario of ROOM_SCENARIOS) {
            expect(scenario.turns.length).toBeGreaterThan(0);
            expect(scenario.expect.map((row) => row.turnId)).toEqual(scenario.turns.map((turn) => turn.turnId));
            expect(scenario.expectFooters.map((row) => row.turnId)).toEqual(scenario.turns.map((turn) => turn.turnId));
        }
    });

    it.each(ROOM_SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
        '%s：每一轮的判据与样本声明一致',
        (_id, scenario) => {
            const result = replayRoom(scenario);
            for (const expected of scenario.expect) {
                const turn = result.turns.find((candidate) => candidate.turn.turnId === expected.turnId);
                expect(turn, `${expected.turnId} 不在重放结果里`).toBeDefined();
                expect(turn?.reason.type).toBe(expected.reason);
                if (expected.note !== undefined) expect(turn?.reason.note).toBe(expected.note);
            }
        },
    );

    it.each(ROOM_SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
        '%s：全房间时间线的 seq 严格递增、条目 id 不重复',
        (_id, scenario) => {
            const result = replayRoom(scenario);
            const seqs = result.items.map((item) => item.seq);
            // 多轮事件各自从 1 起 seq —— 不全局重排就会撞号，排序靠 id 兜底（看上去"能用"）
            expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
            expect(new Set(seqs).size, 'seq 有重复').toBe(seqs.length);
            const ids = result.items.map((item) => item.id);
            expect(new Set(ids).size, `条目 id 重复：${ids.join(',')}`).toBe(ids.length);
        },
    );

    it('每一轮最多补一条解释条目（重放两次会凭空多一条 notice）', () => {
        for (const scenario of ROOM_SCENARIOS) {
            for (const turn of replayRoom(scenario).turns) {
                const extra = turn.items.filter((item) => item.type === 'notice' || item.type === 'error');
                expect(
                    extra.length,
                    `${scenario.id}/${turn.turn.turnId} 补了 ${extra.length} 条解释`,
                ).toBeLessThanOrEqual(1);
            }
        }
    });

    it('广播丢了的轮：前端没有结局，但时间线上仍有解释条目', () => {
        const scenario = ROOM_SCENARIOS.find((candidate) => candidate.id === 'broadcast-lost');
        expect(scenario).toBeDefined();
        const result = replayRoom(scenario!);
        expect(result.endReasons['t-lost']).toBeUndefined();
        const notices = result.items.filter((item) => item.turnId === 't-lost' && item.type === 'notice');
        expect(notices.length, '结局不知道，但「被截断」这条解释不能一起丢').toBe(1);
    });

    it('广播了的轮：前端每一轮都拿得到结局，且只有该有的轮', () => {
        for (const scenario of ROOM_SCENARIOS) {
            const result = replayRoom(scenario);
            const broadcast = scenario.turns.filter((turn) => turn.broadcast !== false).map((turn) => turn.turnId);
            expect(Object.keys(result.endReasons).sort()).toEqual([...broadcast].sort());
        }
    });

    it('修复前：没有解释条目，被切断的流也没人收尾', () => {
        for (const scenario of ROOM_SCENARIOS) {
            const result = replayRoom(scenario);
            // 修复前没有任何 notice（截断 / 悬空 / 断流一个解释都没有）；
            // 错误条目只有 `run.failed` 那条（Projector 一直会落），其余停法一概沉默。
            expect(
                result.legacy.items.some((item) => item.type === 'notice'),
                scenario.id,
            ).toBe(false);
            const hasRunFailed = scenario.turns.some((turn) =>
                turn.events.some((event) => event.type === 'run.failed'),
            );
            if (!hasRunFailed) {
                expect(
                    result.legacy.items.some((item) => item.type === 'error'),
                    scenario.id,
                ).toBe(false);
            }
            // 只有「流被切断」的轮才会留下没被收尾的条目（正常收尾的轮有 message.completed）
            const cut = scenario.turns.some(
                (turn) =>
                    !turn.events.some((event) => event.type === 'message.completed' || event.type === 'run.failed'),
            );
            if (cut) {
                expect(
                    result.legacy.items.some((item) => item.status === 'streaming'),
                    `${scenario.id} 的断流条目在修复前应该一直转圈`,
                ).toBe(true);
            }
        }
    });
});
