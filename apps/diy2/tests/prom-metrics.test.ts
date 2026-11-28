// prom-metrics.test.ts —— `/metrics` 的文本格式（外部监控读它，格式坏了等于没监控）。
//
// 盯住三件事：
//   · 名字 / 单位按约定：lag 用秒、counter 带 `_total`
//   · 同名 metric 的 HELP/TYPE 只出现一次、样本不重复
//   · 标签值转义（home 里可能有引号 / 反斜杠）

import { describe, expect, it } from 'vitest';

import { httpRouteOf, labelValue, recordHttpRequest, renderPrometheus } from '../server/prom-metrics';
import type { LoopLagMonitor } from '../server/loop-lag';

const monitor: LoopLagMonitor = {
    snapshot: () => ({
        max: 1500,
        p99: 1200,
        p50: 20,
        mean: 120,
        cpuRatio: 0.72,
        windowMs: 10_000,
        at: 1_800_000_000_000,
        system: { load1: 12.5, load5: 8, load15: 4, cpus: 8, rssMb: 320 },
    }),
    counters: () => ({
        blockedSeconds: { self: 12.5, starved: 40 },
        stalls: { self: 2, starved: 3 },
    }),
    stop: () => undefined,
};

describe('renderPrometheus', () => {
    it('lag 用秒、counter 带 _total、cpuRatio 原样', () => {
        const text = renderPrometheus(monitor, { home: '/tmp/lab "x"', launch: 'lab', env: 'development' });
        expect(text).toContain('diy2_event_loop_lag_max 1.5');
        expect(text).toContain('diy2_event_loop_cpu_ratio 0.72');
        expect(text).toContain('diy2_event_loop_blocked_total{verdict="self"} 12.5');
        expect(text).toContain('diy2_event_loop_stalls_total{verdict="starved"} 3');
        expect(text).toContain('process_cpu_seconds_total ');
        expect(text).toContain('diy2_up 1');
        expect(text).toContain('diy2_info{home="/tmp/lab \\"x\\"",launch="lab",env="development"} 1');
    });

    it('同名 metric 的 HELP/TYPE 只出现一次，样本不重复', () => {
        const text = renderPrometheus(monitor, { home: '/h', launch: 'lab', env: 'development' });
        const lines = text.split('\n');
        expect(lines.filter((line) => line === '# TYPE system_load_average gauge')).toHaveLength(1);
        expect(lines.filter((line) => line.startsWith('system_load_average{'))).toHaveLength(3);
        expect(lines.filter((line) => line === 'diy2_up 1')).toHaveLength(1);
    });

    it('没有快照时仍能输出存活 / 进程指标', () => {
        const text = renderPrometheus(undefined, { home: '/h', launch: 'lab', env: 'development' });
        expect(text).toContain('diy2_up 1');
        expect(text).not.toContain('diy2_event_loop_lag_max');
    });
});

describe('HTTP 请求耗时', () => {
    it('原始 path 收敛到白名单路由，roomId 之类的高基数不进指标', () => {
        expect(httpRouteOf('/api/info')).toBe('/api/info');
        expect(httpRouteOf('/api/rooms/abc/items')).toBe('/api/other');
        expect(httpRouteOf('/room/task-xxx')).toBe('/static');
    });

    it('histogram 输出 bucket / sum / count，状态按 2xx / 5xx 分档', () => {
        recordHttpRequest('/api/info', 200, 0.03);
        recordHttpRequest('/api/info', 503, 2);
        const text = renderPrometheus(monitor, { home: '/h', launch: 'lab', env: 'development' });
        expect(text).toContain('# TYPE diy2_http_request_duration_seconds histogram');
        expect(text).toContain('diy2_http_request_duration_seconds_count{http_route="/api/info",status="2xx"} 1');
        expect(text).toContain(
            'diy2_http_request_duration_seconds_bucket{http_route="/api/info",status="5xx",le="+Inf"} 1',
        );
        expect(text).toContain('diy2_http_request_duration_seconds_sum{http_route="/api/info",status="2xx"} 0.03');
    });
});

describe('labelValue', () => {
    it('转义反斜杠 / 换行 / 双引号', () => {
        expect(labelValue('a\\b\nc"d')).toBe('a\\\\b\\nc\\"d');
    });
});
