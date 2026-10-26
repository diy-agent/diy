/**
 * metrics 单测 —— 钉住四件事：
 *   ① 记录与拉取是**分离**的（没人 collect 就没有任何计算）
 *   ② 拉取**不注册任何定时器**（PullMetricReader 的全部意义）
 *   ③ counter / up-down counter / 直方图三种形状都能从快照里读出预期值
 *   ④ 维度（task_uri / state / outcome）真的分得开，不是糊成一个数
 *
 * 不真等任何东西：`collect()` 是即时聚合，没有 flush 窗口。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    DURATION_BUCKETS_MS,
    METRIC_NAMES,
    __resetMetricsForTest,
    recordRunSettled,
    recordRunStarted,
    snapshotMetrics,
    type MetricsSnapshot,
} from "../../src/shared/metrics";

/** 从快照里取一条指标（缺了就报清楚，别用 `!` 蒙混）。 */
function metric(snap: MetricsSnapshot, name: string) {
    const m = snap.metrics.find((x) => x.name === name);
    if (!m) throw new Error(`快照里没有指标 ${name}：${snap.metrics.map((x) => x.name).join(", ")}`);
    return m;
}

/** 标量指标按维度求和（counter 在没记录过时整条缺席 —— 那时返回 0）。 */
function scalarTotal(snap: MetricsSnapshot, name: string): number {
    const m = snap.metrics.find((x) => x.name === name);
    if (!m) return 0;
    return m.points.reduce((s, p) => s + (typeof p.value === "number" ? p.value : 0), 0);
}

describe("metrics 快照", () => {
    beforeEach(() => {
        __resetMetricsForTest();
    });

    it("没记录过任何东西时：快照是空的，且不抛", async () => {
        const snap = await snapshotMetrics();
        expect(snap.metrics).toEqual([]);
        expect(new Date(snap.at).toString()).not.toBe("Invalid Date");
    });

    it("启动即 +1，收口 -1：running 成对维护，不漂", async () => {
        recordRunStarted({ taskUri: "projects/1/tasks/5" });
        recordRunStarted({ taskUri: "projects/1/tasks/5" });
        let snap = await snapshotMetrics();
        expect(scalarTotal(snap, METRIC_NAMES.runStarted)).toBe(2);
        expect(scalarTotal(snap, METRIC_NAMES.runRunning)).toBe(2);

        recordRunSettled({ taskUri: "projects/1/tasks/5", state: "exited", outcome: "ok", durationMs: 1_500 });
        snap = await snapshotMetrics();
        expect(scalarTotal(snap, METRIC_NAMES.runSettled)).toBe(1);
        expect(scalarTotal(snap, METRIC_NAMES.runRunning)).toBe(1);
    });

    it("维度分得开：两个任务的计数互不吞并", async () => {
        recordRunStarted({ taskUri: "projects/1/tasks/5" });
        recordRunStarted({ taskUri: "projects/4/tasks/408" });
        recordRunStarted({ taskUri: "projects/4/tasks/408" });
        const m = metric(await snapshotMetrics(), METRIC_NAMES.runStarted);
        const byTask = Object.fromEntries(m.points.map((p) => [p.attrs.task_uri, p.value]));
        expect(byTask).toEqual({ "projects/1/tasks/5": 1, "projects/4/tasks/408": 2 });
    });

    it("缺任务归属落到 _none，不许缺席（否则按任务聚合会静默漏数）", async () => {
        recordRunStarted({});
        const m = metric(await snapshotMetrics(), METRIC_NAMES.runStarted);
        expect(m.points[0].attrs.task_uri).toBe("_none");
    });

    it("终态与结局是两维：killed/settled 不会混进 exited/ok", async () => {
        recordRunStarted({ taskUri: "t" });
        recordRunSettled({ taskUri: "t", state: "exited", outcome: "ok", durationMs: 10 });
        recordRunStarted({ taskUri: "t" });
        recordRunSettled({ taskUri: "t", state: "killed", outcome: "canceled", durationMs: 10 });
        const m = metric(await snapshotMetrics(), METRIC_NAMES.runSettled);
        const pairs = m.points.map((p) => `${String(p.attrs.state)}/${String(p.attrs.outcome)}`).sort();
        expect(pairs).toEqual(["exited/ok", "killed/canceled"]);
    });

    it("直方图用自定义桶：2 分钟的命令不会和 30 秒的落进同一格", async () => {
        recordRunStarted({ taskUri: "t" });
        recordRunSettled({ taskUri: "t", state: "exited", outcome: "ok", durationMs: 1_500 }); // 1s~10s
        recordRunStarted({ taskUri: "t" });
        recordRunSettled({ taskUri: "t", state: "exited", outcome: "ok", durationMs: 120_000 }); // 1m~5m
        recordRunStarted({ taskUri: "t" });
        recordRunSettled({ taskUri: "t", state: "exited", outcome: "ok", durationMs: 30_000 }); // 10s~1m

        const m = metric(await snapshotMetrics(), METRIC_NAMES.runDuration);
        expect(m.type).toBe("histogram");
        const v = m.points[0].value as { count: number; sum: number; boundaries: number[]; counts: number[] };
        expect(v.count).toBe(3);
        expect(v.sum).toBe(151_500);
        expect(v.boundaries).toEqual([...DURATION_BUCKETS_MS]);
        // counts[i] = 落在 (boundaries[i-1], boundaries[i]] 的条数（首桶含 0）
        expect(v.counts).toEqual([0, 1, 1, 1, 0, 0]);
    });

    it("非法时长（NaN / 负数）不进直方图，但 counter 照记", async () => {
        recordRunStarted({ taskUri: "t" });
        recordRunSettled({ taskUri: "t", state: "exited", outcome: "ok", durationMs: Number.NaN });
        const snap = await snapshotMetrics();
        expect(scalarTotal(snap, METRIC_NAMES.runSettled)).toBe(1);
        expect(snap.metrics.find((x) => x.name === METRIC_NAMES.runDuration)).toBeUndefined();
    });

    it("拉取不注册任何定时器（PullMetricReader 的全部意义）", async () => {
        const real = globalThis.setInterval;
        let installed = 0;
        // @ts-expect-error 只在本用例内替换，finally 恢复
        globalThis.setInterval = (...args: unknown[]) => {
            installed += 1;
            return (real as (...a: unknown[]) => unknown)(...args);
        };
        try {
            __resetMetricsForTest();
            recordRunStarted({ taskUri: "t" });
            await snapshotMetrics();
            await snapshotMetrics();
        } finally {
            globalThis.setInterval = real;
        }
        expect(installed).toBe(0);
    });

    it("两次快照可直接 diff：指标按名字排序", async () => {
        recordRunStarted({ taskUri: "t" });
        recordRunSettled({ taskUri: "t", state: "exited", outcome: "ok", durationMs: 5 });
        const names = (await snapshotMetrics()).metrics.map((m) => m.name);
        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });
});

afterEach(() => {
    __resetMetricsForTest();
});
