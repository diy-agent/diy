// 活动流的「什么算数据」判据：服务端每条 server-stream 都先发 `{ kind: 'ready' }`，
// 活动流也照发 —— 放过去的话监听者按 `frame.rooms` 取值就炸，整条流被 pump 判死。
// 2026-11-25 实测：页面上「运行状态不更新、刷新才好」正是这条。

import { describe, expect, it } from 'vitest';

import { activityFrameOf } from '../src/hub';

describe('activityFrameOf', () => {
    it('ready 帧不是活动数据（它只说明「往后连续」）', () => {
        expect(activityFrameOf({ kind: 'ready' })).toBeUndefined();
    });

    it('快照帧原样返回', () => {
        const frame = { kind: 'activity', rooms: [{ id: 'task:t-001', botIds: ['a'] }], jobs: 2 };
        expect(activityFrameOf(frame)).toBe(frame);
    });

    it('空快照（谁都没跑）也算数据 —— 它的意思正是「全都停了」', () => {
        const frame = { kind: 'activity', rooms: [], jobs: 0 };
        expect(activityFrameOf(frame)).toBe(frame);
    });

    it('形状不对的帧不往下传：缺 rooms / jobs 类型错 / 根本不是对象', () => {
        expect(activityFrameOf({ kind: 'activity', jobs: 0 })).toBeUndefined();
        expect(activityFrameOf({ kind: 'activity', rooms: 'x', jobs: 0 })).toBeUndefined();
        expect(activityFrameOf({ kind: 'activity', rooms: [], jobs: '0' })).toBeUndefined();
        expect(activityFrameOf({ kind: 'other', rooms: [], jobs: 0 })).toBeUndefined();
        expect(activityFrameOf(null)).toBeUndefined();
        expect(activityFrameOf(undefined)).toBeUndefined();
        expect(activityFrameOf('ready')).toBeUndefined();
    });
});
