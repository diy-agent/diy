// delivery 状态图 —— 穷举所有 (状态, 事件) 组合，把「不该走的路」钉死。
//
// 为什么值得写这么细：这套状态之前是散在 room.ts / session.ts 各处的 if，于是
// 「steer 失败被当成失败」「用户点停止被写成 done+failed」这类事没人能一眼看出来。
// 状态图的价值 90% 就在这里面 —— 转移是一张可穷举的表。

import { describe, expect, it } from 'vitest';

import {
    canTransition,
    DELIVERY_VIEW_TEXT,
    deliveryViewOf,
    isTerminal,
    transition,
    type DeliveryEvent,
    type DeliveryPhase,
} from '@diy-agent/protocol';

const PHASES: DeliveryPhase[] = ['pending', 'working', 'delivered', 'failed', 'cancelled'];
const EVENTS: DeliveryEvent[] = ['claim', 'complete', 'fail', 'cancel', 'requeue'];

/** 期望表：与 delivery.ts 的 TRANSITIONS 一一对应，有改动必须两边一起改（这是故意的冗余） */
const EXPECTED: Record<DeliveryPhase, Partial<Record<DeliveryEvent, DeliveryPhase>>> = {
    pending: { claim: 'working', cancel: 'cancelled', fail: 'failed' },
    working: { complete: 'delivered', cancel: 'cancelled', fail: 'failed', requeue: 'pending' },
    delivered: {},
    failed: {},
    cancelled: {},
};

describe('投递状态图', () => {
    it('合法转移：每条都走到期望的下一状态', () => {
        for (const phase of PHASES) {
            for (const event of EVENTS) {
                const want = EXPECTED[phase][event];
                if (want === undefined) continue;
                expect(transition(phase, event), `${phase} --${event}-->`).toBe(want);
            }
        }
    });

    it('非法转移一律抛错，不静默吞（终态没有出路）', () => {
        for (const phase of PHASES) {
            for (const event of EVENTS) {
                if (EXPECTED[phase][event] !== undefined) continue;
                expect(canTransition(phase, event)).toBe(false);
                expect(() => transition(phase, event)).toThrow(/非法转移/);
            }
        }
    });

    it('终态不可再变：delivered / failed / cancelled 都没有合法事件', () => {
        for (const phase of ['delivered', 'failed', 'cancelled'] as DeliveryPhase[]) {
            expect(isTerminal(phase)).toBe(true);
            expect(EVENTS.filter((event) => canTransition(phase, event))).toEqual([]);
        }
        expect(isTerminal('pending')).toBe(false);
        expect(isTerminal('working')).toBe(false);
    });

    it('steer 插不进本轮 → requeue 回 pending，不是失败（用户 2026-11-28 裁定）', () => {
        expect(transition('working', 'requeue')).toBe('pending');
        // 而且只有 working 能 requeue：pending 本来就在队列里，delivered/cancelled 不该复活
        expect(canTransition('pending', 'requeue')).toBe(false);
        expect(canTransition('delivered', 'requeue')).toBe(false);
    });

    it('用户看到只有四档：pending 与 working 都算「发送中」', () => {
        expect(deliveryViewOf('pending')).toBe('sending');
        expect(deliveryViewOf('working')).toBe('sending');
        expect(deliveryViewOf('delivered')).toBe('succeeded');
        expect(deliveryViewOf('failed')).toBe('failed');
        expect(deliveryViewOf('cancelled')).toBe('cancelled');
        expect(Object.keys(DELIVERY_VIEW_TEXT).sort()).toEqual(['cancelled', 'failed', 'sending', 'succeeded']);
    });

    it('用户「取消」与「失败」是两个不同的终态（取消不该报警）', () => {
        expect(transition('working', 'cancel')).toBe('cancelled');
        expect(transition('working', 'fail')).toBe('failed');
        expect(deliveryViewOf('cancelled')).not.toBe(deliveryViewOf('failed'));
    });
});
