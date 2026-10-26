// tests/core/job-metrics-view.test.ts — 指标页（##408 v2 观察面）的判定
//
// 组件本身只做渲染；**会让人看错数**的判断全在 `renderer_solid/lib/job-metrics.ts`，
// 按本仓惯例（`chat-scroll.test.ts` / `run-view.test.ts` 同规格）钉在这里：
//   · 视角过滤错了 ⇒ 本任务看到别人的数（最坏的一种：把自己的活算到别人头上）
//   · 直方图合并错了 ⇒ 耗时分布整体失真
//   · 桶标签错了 ⇒ 用户照着读错量级
import { describe, expect, it } from "vitest";
import { DURATION_BUCKETS_MS } from "../../src/shared/metric-names";
import type { HistogramValue, MetricPointView, MetricView } from "../../src/shared/metric-names";
import {
    NO_TASK,
    bucketLabel,
    groupBy,
    histMerged,
    msText,
    num,
    pointsOf,
    taskRows,
} from "../../src/renderer_solid/lib/job-metrics";

const URI = "projects/4/tasks/408";
const OTHER = "projects/4/tasks/266";

function pt(attrs: Record<string, unknown>, value: number | HistogramValue): MetricPointView {
    return { attrs, value };
}

function hist(count: number, sum: number, counts: number[], min = 0, max = 0): HistogramValue {
    return { count, sum, min, max, boundaries: [...DURATION_BUCKETS_MS], counts };
}

function metric(name: string, type: MetricView["type"], points: MetricPointView[]): MetricView {
    return { name, description: "", unit: "", type, points };
}

describe("pointsOf：视角口径", () => {
    const m = metric("job.run.started_total", "counter", [
        pt({ task_uri: URI }, 3),
        pt({ task_uri: OTHER }, 5),
        pt({ task_uri: NO_TASK }, 1),
    ]);

    it("「本任务」只留自己的点（别人的 / 无来源的都不算）", () => {
        expect(pointsOf(m, URI, false)).toEqual([pt({ task_uri: URI }, 3)]);
    });

    it("「全部」拿全量点，一个不漏", () => {
        expect(pointsOf(m, URI, true)).toHaveLength(3);
    });

    it("指标缺席（进程刚起，还没记录过）⇒ 空数组，不是 null 崩渲染", () => {
        expect(pointsOf(null, URI, true)).toEqual([]);
    });
});

describe("num：一个点算几条", () => {
    it("标量原样；直方图取样本数（面板上「几条」永远指 count）", () => {
        expect(num(7)).toBe(7);
        expect(num(hist(4, 999, [4, 0, 0, 0, 0]))).toBe(4);
    });
});

describe("groupBy：终态 / 结局分布", () => {
    it("按维度求和并降序（条形图顺序不该随属性顺序跳）", () => {
        const pts = [pt({ state: "exited" }, 2), pt({ state: "killed" }, 5), pt({ state: "exited" }, 1)];
        expect(groupBy(pts, "state")).toEqual([
            { k: "killed", v: 5 },
            { k: "exited", v: 3 },
        ]);
    });

    it("同值按名字定序（稳定，刷新不跳位）", () => {
        const pts = [pt({ state: "killed" }, 2), pt({ state: "exited" }, 2)];
        expect(groupBy(pts, "state").map((g) => g.k)).toEqual(["exited", "killed"]);
    });

    it("维度缺失的落成 `—`，不静默丢（丢了下总数就对不上）", () => {
        expect(groupBy([pt({}, 3)], "state")).toEqual([{ k: "—", v: 3 }]);
    });
});

describe("histMerged：耗时分布合并", () => {
    it("两条（按任务拆的）合成一份：count / sum / 各桶都相加，min/max 取极值", () => {
        const a = hist(2, 3_000, [1, 1, 0, 0, 0], 500, 2_500);
        const b = hist(1, 90_000, [0, 0, 1, 0, 0], 90_000, 90_000);
        const out = histMerged([pt({ task_uri: URI }, a), pt({ task_uri: OTHER }, b)]);
        expect(out).not.toBeNull();
        expect(out!.count).toBe(3);
        expect(out!.sum).toBe(93_000);
        expect(out!.counts).toEqual([1, 1, 1, 0, 0]);
        expect(out!.min).toBe(500);
        expect(out!.max).toBe(90_000);
    });

    it("边界一律取**当前定义**的桶（老快照的旧边界不能混进同一格）", () => {
        const stale: HistogramValue = { count: 1, sum: 1, min: 1, max: 1, boundaries: [5, 10], counts: [1] };
        const out = histMerged([pt({}, stale)]);
        expect(out!.boundaries).toEqual([...DURATION_BUCKETS_MS]);
        expect(out!.counts).toHaveLength(DURATION_BUCKETS_MS.length);
        // 老快照只有 1 个格子 ⇒ 其余格补 0，不越界
        expect(out!.counts[0]).toBe(1);
        expect(out!.counts.slice(1).every((c) => c === 0)).toBe(true);
    });

    it("没有点 / 全是标量 / count 为 0 ⇒ null（UI 显示空态，不画零高度柱）", () => {
        expect(histMerged([])).toBeNull();
        expect(histMerged([pt({}, 3)])).toBeNull();
        expect(histMerged([pt({}, hist(0, 0, [0, 0, 0, 0, 0]))])).toBeNull();
    });
});

describe("bucketLabel：桶名就是用户读到的量级", () => {
    it("首档从 0 起算；中间档是 (下界, 上界]；末档是 > 上界", () => {
        expect(bucketLabel(0)).toBe("0–1.00s");
        expect(bucketLabel(2)).toBe("10.0s–1.0m");
        expect(bucketLabel(DURATION_BUCKETS_MS.length)).toBe("> 30.0m");
    });
});

describe("msText：人话时长", () => {
    it("秒 / 分 / 时各自一位小数；非有限值与负数给 `—`（不是 NaN 文本）", () => {
        expect(msText(0)).toBe("0ms");
        expect(msText(999)).toBe("999ms");
        expect(msText(1_500)).toBe("1.50s");
        expect(msText(45_000)).toBe("45.0s");
        expect(msText(90_000)).toBe("1.5m");
        expect(msText(7_200_000)).toBe("2.0h");
        expect(msText(Number.NaN)).toBe("—");
        expect(msText(-1)).toBe("—");
    });
});

describe("taskRows：按任务摊平（分诊台）", () => {
    it("在跑优先、再启动次数、最后名字定序", () => {
        const rows = taskRows({
            running: [pt({ task_uri: OTHER }, 1)],
            started: [pt({ task_uri: URI }, 9), pt({ task_uri: OTHER }, 1)],
            settled: [pt({ task_uri: URI }, 8)],
        });
        expect(rows.map((r) => r.task)).toEqual([OTHER, URI]);
        expect(rows[0]).toMatchObject({ running: 1, started: 1, settled: 0 });
        expect(rows[1]).toMatchObject({ running: 0, started: 9, settled: 8 });
    });

    it("没有 origin 的 run 保留为 `_none` 一行（藏起来会让总数对不上）", () => {
        const rows = taskRows({ running: [], started: [pt({ task_uri: NO_TASK }, 2)], settled: [] });
        expect(rows).toEqual([{ task: NO_TASK, running: 0, started: 2, settled: 0 }]);
    });

    it("三类都是空 ⇒ 空数组（UI 走空态）", () => {
        expect(taskRows({ running: [], started: [], settled: [] })).toEqual([]);
    });
});
