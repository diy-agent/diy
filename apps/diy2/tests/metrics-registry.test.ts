// metrics-registry.test.ts —— op / RPC histogram 的累加与 Prometheus 文本。
//
// 盯三件事：方法名不带参数（无高基数）、status 分档、bucket 的 le 单调且 +Inf = count。

import { describe, expect, it } from 'vitest';

import { recordDuration, renderMetricsRegistry, wrapHandlers } from '../server/metrics-registry';

describe('recordDuration / renderMetricsRegistry', () => {
    it('同名不同 label 分成两条 series，带 HELP/TYPE', () => {
        recordDuration('diy2_op_duration_seconds', ['rooms.list.unreadByRoom'], 0.03);
        recordDuration('diy2_op_duration_seconds', ['turnLookup'], 1.2);
        const text = renderMetricsRegistry();
        expect(text).toContain('# HELP diy2_op_duration_seconds');
        expect(text).toContain('# TYPE diy2_op_duration_seconds histogram');
        expect(text).toContain('diy2_op_duration_seconds_count{op="turnLookup"} 1');
        expect(text).toContain('diy2_op_duration_seconds_count{op="rooms.list.unreadByRoom"} 1');
        expect(text).toContain('diy2_op_duration_seconds_bucket{op="turnLookup",le="+Inf"} 1');
        expect(text).toContain('diy2_op_duration_seconds_sum{op="turnLookup"} 1.2');
    });

    it('bucket 单调：1.2s 落进 le=2.5 及更高，不落进 le=1', () => {
        recordDuration('diy2_rpc_server_duration_seconds', ['rooms.list', 'ok'], 1.2);
        const text = renderMetricsRegistry();
        const has = (fragment: string): boolean => text.includes(fragment);
        expect(has('rpc_method="rooms.list",rpc_status="ok",le="1"} 0')).toBe(true);
        expect(has('rpc_method="rooms.list",rpc_status="ok",le="2.5"} 1')).toBe(true);
        expect(has('rpc_method="rooms.list",rpc_status="ok",le="+Inf"} 1')).toBe(true);
    });
});

describe('wrapHandlers', () => {
    it('嵌套 handler 的方法名 = 路径，不含入参里的 id', async () => {
        const handlers = {
            rooms: {
                list: async (_x: unknown) => 'ok',
            },
        };
        const wrapped = wrapHandlers(handlers);
        expect(await wrapped.rooms.list({ room: 'task-SECRET-ID' })).toBe('ok');

        const text = renderMetricsRegistry();
        expect(text).toContain('rpc_method="rooms.list"');
        // 入参里的 id 绝不能进标签（高基数 + 用户数据）
        expect(text).not.toContain('SECRET-ID');
        expect(text).toContain('rpc_status="ok"');
    });

    it('抛错记 error 且原样抛出', async () => {
        const wrapped = wrapHandlers({ x: async () => Promise.reject(new Error('boom')) });
        await expect(wrapped.x()).rejects.toThrow('boom');
        expect(renderMetricsRegistry()).toContain('rpc_method="x",rpc_status="error"');
    });
});
