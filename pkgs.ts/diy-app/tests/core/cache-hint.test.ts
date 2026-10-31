// tests/core/cache-hint.test.ts
// 🎯 ##477 冷缓存提示的**判据**（纯函数）+ 落盘 + 装配层 —— 无网络、无 Electron。
//
// 用户定稿的算法只有两个数（别改口径）：
//   · safePoint = 最近 100 次**首步成功**请求 gap 的 P90；无历史 = 60s
//   · failPoint = 首步命中率 ≈0 的那次 gap，**只降不升**；无历史 = +∞
//   提示条件 = `gap > 60s && gap > max(safePoint, failPoint)` —— max 是关键：
//   safePoint 更高时说明成功案例更多，那次失败更可能是异常 ⇒ 不提示。
//   另有一条闸门（用户 10-30 追加）：**落在安全区内的失败一律忽略** —— 那是上游抖动，
//   拿它收紧边界会让提示过多。
//
// 维度必须是 **provider × model**（同模型不同渠道实测差 12 倍）；本文件用两个 provider
// 的同名模型钉住这一点。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    CACHE_AGE_DOMAIN_MAX_MS,
    CACHE_AGE_DOMAIN_MIN_MS,
    SAFE_POINT_DEFAULT_MS,
    SAFE_POINT_WINDOW,
    cacheAgeZone,
    cacheHintText,
    effectiveFailLine,
    classifyFirstStep,
    decideHint,
    emptyChannelStats,
    formatGap,
    logScalePos,
    percentile90,
    recordFailureGap,
    safePointOf,
    tightenFailPoint,
    withSuccessGap,
    type CacheHint,
} from "../../src/shared/cache-hint";
import { cacheHint } from "../../src/main/services/cache-hint";
import { cacheHintFile, loadCacheHintStore, saveCacheHintStore } from "../../src/main/core/cache-hint-store";

const MIN = 60_000;
const HOUR = 60 * MIN;
const CH = "opencode-go/deepseek-v4.1-flash";
const T0 = 1_700_000_000_000;

/** 首步命中率：950/1000 = 0.95 → 真命中 */
const HIT = { inputTokens: 1000, cacheRead: 950 };
/** 首步命中率：0/1000 = 0 → 全未命中 */
const MISS = { inputTokens: 1000, cacheRead: 0 };

/** 一条提示的最小形状（文案断言用；id/taskUri 不参与判定） */
const hint = (over: Partial<CacheHint> = {}): CacheHint => ({
    id: "ch-1",
    ts: "2026-10-31T00:00:00.000Z",
    channel: CH,
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    gapMs: 42 * MIN,
    safePointMs: 5 * MIN,
    failPointMs: 15 * MIN,
    thresholdMs: 15 * MIN,
    thresholdKind: "fail",
    todayCount: 3,
    taskUri: "projects/4/tasks/477",
    ...over,
});

/** 造一个渠道：N 次 gap=5min 的真命中（safePoint=5min、failPoint=+∞） */
function seedHits(n = 100, gapMs = 5 * MIN, channel = CH): void {
    cacheHint.noteRequest({ provider: "opencode-go", model: "deepseek-v4.1-flash", taskUri: "t", now: T0 });
    for (let i = 1; i <= n; i++) {
        const r = cacheHint.noteRequest({
            provider: "opencode-go",
            model: "deepseek-v4.1-flash",
            taskUri: "t",
            now: T0 + gapMs * i,
        });
        cacheHint.noteFirstStepResult({ channel, gapMs: r.gapMs, now: T0 + gapMs * i, ...HIT });
    }
}

describe("safePoint：最近 100 次首步成功的 P90", () => {
    it("无历史 → 60s（保护值）", () => {
        expect(safePointOf([])).toBe(SAFE_POINT_DEFAULT_MS);
        expect(SAFE_POINT_DEFAULT_MS).toBe(60_000);
    });

    it("100 次 gap=5min 成功 → safePoint = 5min", () => {
        let samples: number[] = [];
        for (let i = 0; i < 100; i++) samples = withSuccessGap(samples, 5 * MIN);
        expect(samples).toHaveLength(100);
        expect(safePointOf(samples)).toBe(5 * MIN);
    });

    it("窗口只留最近 100 个（老的丢掉，不是一直长）", () => {
        let samples: number[] = [];
        for (let i = 0; i < 130; i++) samples = withSuccessGap(samples, (i + 1) * MIN);
        expect(samples).toHaveLength(SAFE_POINT_WINDOW);
        expect(samples[0]).toBe(31 * MIN);
        expect(samples[samples.length - 1]).toBe(130 * MIN);
    });

    it("P90 是最近秩（n=10 → 第 9 个；n=1 → 唯一那个）", () => {
        expect(percentile90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
        expect(percentile90([7])).toBe(7);
        expect(percentile90([])).toBeNull();
    });

    it("gap<=0 不记（同一次请求 / 时间倒挂）", () => {
        expect(withSuccessGap([], 0)).toEqual([]);
        expect(withSuccessGap([], -5)).toEqual([]);
    });
});

describe("failPoint：只降不升，且安全区内的失败一律忽略", () => {
    it("收紧取更小的那个", () => {
        expect(tightenFailPoint(null, 10 * MIN)).toBe(10 * MIN);
        expect(tightenFailPoint(10 * MIN, 20 * MIN)).toBe(10 * MIN);
        expect(tightenFailPoint(10 * MIN, 5 * MIN)).toBe(5 * MIN);
    });

    it("落在安全区内（4min 失败 / safePoint=5min）→ 原值不动", () => {
        expect(recordFailureGap(5 * MIN, null, 4 * MIN)).toBeNull();
        expect(recordFailureGap(5 * MIN, 10 * MIN, 4 * MIN)).toBe(10 * MIN);
        // 越过安全区才记
        expect(recordFailureGap(5 * MIN, null, 10 * MIN)).toBe(10 * MIN);
        expect(recordFailureGap(5 * MIN, 10 * MIN, 8 * MIN)).toBe(8 * MIN);
    });
});

describe("首步命中率分类：>0.9 成功 / <0.05 失败 / 其余不记", () => {
    it("真命中才算成功（0.9 整不算）", () => {
        expect(classifyFirstStep(0.95)).toBe("success");
        expect(classifyFirstStep(0.9)).toBeNull();
        expect(classifyFirstStep(0.04)).toBe("miss");
        expect(classifyFirstStep(0.5)).toBeNull();
        expect(classifyFirstStep(null)).toBeNull();
    });
});

describe("提示判据：gap > max(safePoint, failPoint)", () => {
    it("无历史（failPoint=+∞）→ 永不提示（没有失败证据不猜）", () => {
        expect(decideHint({ gapMs: 5 * HOUR, safePointMs: SAFE_POINT_DEFAULT_MS, failPointMs: null })).toBeNull();
    });

    it("间隔 ≤ 60s 不提示（短间隔本来就不可能冷）", () => {
        expect(decideHint({ gapMs: 30_000, safePointMs: MIN, failPointMs: 10 * MIN })).toBeNull();
        expect(decideHint({ gapMs: null, safePointMs: MIN, failPointMs: 10 * MIN })).toBeNull();
    });

    it("越过失效点 → 提示，并说清是「记录过的失效点」", () => {
        const d = decideHint({ gapMs: 11 * MIN, safePointMs: 5 * MIN, failPointMs: 10 * MIN });
        expect(d).toEqual({ thresholdMs: 10 * MIN, thresholdKind: "fail" });
    });

    it("safePoint 更高时不提示（单次失败可能是异常）", () => {
        expect(decideHint({ gapMs: 15 * MIN, safePointMs: 20 * MIN, failPointMs: 10 * MIN })).toBeNull();
        // 但真越过了更高的 safePoint 仍要提示
        expect(decideHint({ gapMs: 25 * MIN, safePointMs: 20 * MIN, failPointMs: 10 * MIN })).toEqual({
            thresholdMs: 20 * MIN,
            thresholdKind: "safe",
        });
    });
});

describe("文案：一行说清「多久 / 越过什么 / 今日几次 / 怎么办」", () => {
    it("按失效点触发", () => {
        expect(cacheHintText(hint())).toBe(
            "⚠ 缓存可能已冷 · 距上次 42min（超过记录的 15min 失效点） · 今日第 3 次 · 建议换个模型或先压缩",
        );
    });

    it("按安全期触发", () => {
        const t = cacheHintText(hint({ thresholdKind: "safe", thresholdMs: 20 * MIN, todayCount: 1 }));
        expect(t).toContain("超过 20min 安全期");
        expect(t).toContain("今日第 1 次");
    });

    it("间隔格式", () => {
        expect(formatGap(35_000)).toBe("35s");
        expect(formatGap(42 * MIN)).toBe("42min");
        expect(formatGap(HOUR)).toBe("1h");
        expect(formatGap(HOUR + 5 * MIN)).toBe("1h05min");
    });
});

describe("缓存时效柱：对数刻度 + 三区", () => {
    it("刻度单调递增且夹在 0~1（5min 与 10min 必须分得开）", () => {
        const p5 = logScalePos(5 * MIN);
        const p10 = logScalePos(10 * MIN);
        expect(p5).toBeGreaterThan(0);
        expect(p10).toBeGreaterThan(p5);
        expect(p10 - p5).toBeGreaterThan(0.05);
        expect(logScalePos(1)).toBe(0);
        expect(logScalePos(7 * 24 * HOUR)).toBe(1);
        expect(logScalePos(CACHE_AGE_DOMAIN_MIN_MS)).toBe(0);
        expect(logScalePos(CACHE_AGE_DOMAIN_MAX_MS)).toBe(1);
    });

    it("分区：safePoint 左安全 / 之间警告 / failPoint 右危险；failPoint=+∞ 时右半段不标红", () => {
        expect(cacheAgeZone(5 * MIN, 10 * MIN, 20 * MIN)).toBe("safe");
        expect(cacheAgeZone(15 * MIN, 10 * MIN, 20 * MIN)).toBe("warn");
        expect(cacheAgeZone(30 * MIN, 10 * MIN, 20 * MIN)).toBe("danger");
        expect(cacheAgeZone(30 * HOUR, 10 * MIN, null)).toBe("warn");
        // 失效点低于安全点 ⇒ 安全点优先，右半段只算警告（与提示判据同一个口径）
        expect(cacheAgeZone(22 * MIN, 20 * MIN, 10 * MIN)).toBe("warn");
        expect(cacheAgeZone(30 * MIN, 20 * MIN, 10 * MIN)).toBe("warn"); // 失效线被安全点盖过 → 永不标红
        expect(effectiveFailLine(20 * MIN, 10 * MIN)).toBe(20 * MIN);
        expect(effectiveFailLine(20 * MIN, null)).toBeNull();
    });
});

describe("落盘 store（判据 1：能查到 <provider>/<model> → {safePoint, failPoint, updatedAt}）", () => {
    const dirs: string[] = [];
    const newHome = (): string => {
        const d = mkdtempSync(join(tmpdir(), "diy-cache-hint-"));
        dirs.push(d);
        return d;
    };
    afterEach(() => {
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    it("写-读往返：samples 是事实、safePoint 是投影", () => {
        const home = newHome();
        let samples: number[] = [];
        for (let i = 0; i < 100; i++) samples = withSuccessGap(samples, 5 * MIN);
        saveCacheHintStore(home, {
            version: 1,
            channels: {
                [CH]: {
                    ...emptyChannelStats("2026-10-31T00:00:00.000Z"),
                    samples,
                    safePoint: 123, // 故意写错：读回要按 samples 重算
                    failPoint: 10 * MIN,
                    lastRequestAt: 1_700_000_000_000,
                },
                "direct/deepseek-v4.1-flash": {
                    ...emptyChannelStats("2026-10-31T00:00:00.000Z"),
                    samples: [30 * MIN],
                    failPoint: null,
                },
            },
        });
        expect(readFileSync(cacheHintFile(home), "utf-8")).toContain(CH);

        const back = loadCacheHintStore(home);
        const a = back.channels[CH]!;
        expect(a.safePoint).toBe(5 * MIN);
        expect(a.failPoint).toBe(10 * MIN);
        expect(a.lastRequestAt).toBe(1_700_000_000_000);
        // 维度是 provider × model：同名模型的另一个渠道是**另一条**
        expect(back.channels["direct/deepseek-v4.1-flash"]!.safePoint).toBe(30 * MIN);
        expect(back.channels["direct/deepseek-v4.1-flash"]!.failPoint).toBeNull();
    });

    it("版本不符 → 空 store（不抛：边界缺失等于不提示）", () => {
        const home = newHome();
        saveCacheHintStore(home, { version: 99, channels: {} });
        expect(loadCacheHintStore(home).channels).toEqual({});
    });
});

describe("装配层：首步事实 → 边界 → 那一行提示", () => {
    // 每个用例从**空 store** 起：边界是落盘的（这是判据 1 的要求），用例之间不能串味
    const wipe = (): void => {
        rmSync(cacheHintFile(process.env["DIY_HOME"]!), { force: true });
        cacheHint.reset();
    };
    beforeEach(wipe);
    afterEach(wipe);

    it("100 次 5min 成功 → safePoint=5min；一次 10min 失败 → failPoint=10min 且收紧那一刻亮一次", () => {
        seedHits(100);
        expect(cacheHint.stats(CH).safePoint).toBe(5 * MIN);
        expect(cacheHint.stats(CH).failPoint).toBeNull();

        // 发出前：failPoint 还是 +∞ ⇒ 按定稿规则不提示
        const miss = cacheHint.noteRequest({
            provider: "opencode-go",
            model: "deepseek-v4.1-flash",
            taskUri: "t",
            now: T0 + 5 * MIN * 100 + 10 * MIN,
        });
        expect(miss.gapMs).toBe(10 * MIN);
        expect(miss.hint).toBeNull();

        // 结果回来是"几乎全未命中"⇒ 收紧 failPoint，并立刻亮一次（用户刚付完全价）
        cacheHint.noteFirstStepResult({
            channel: miss.channel,
            gapMs: miss.gapMs,
            taskUri: "t",
            now: T0 + 5 * MIN * 100 + 10 * MIN,
            ...MISS,
        });
        expect(cacheHint.stats(CH).failPoint).toBe(10 * MIN);
        expect(cacheHint.currentOf()?.thresholdMs).toBe(10 * MIN);
        expect(cacheHint.currentOf()?.thresholdKind).toBe("fail");
        expect(cacheHintText(cacheHint.currentOf()!)).toContain("超过记录的 10min 失效点");

        // 判据 1：**盘上**也能查到这两个数（重启后直接用）
        const onDisk = loadCacheHintStore(process.env["DIY_HOME"]!).channels[CH]!;
        expect(onDisk.safePoint).toBe(5 * MIN);
        expect(onDisk.failPoint).toBe(10 * MIN);
        expect(typeof onDisk.updatedAt).toBe("string");
    });

    it("安全区内的失败（4min < safePoint 5min）→ failPoint 不动、也不提示", () => {
        seedHits(100);
        cacheHint.dismiss();
        const miss = cacheHint.noteRequest({
            provider: "opencode-go",
            model: "deepseek-v4.1-flash",
            taskUri: "t",
            now: T0 + 5 * MIN * 100 + 4 * MIN,
        });
        expect(miss.hint).toBeNull();
        cacheHint.noteFirstStepResult({
            channel: miss.channel,
            gapMs: miss.gapMs,
            taskUri: "t",
            now: T0 + 5 * MIN * 100 + 4 * MIN,
            ...MISS,
        });
        expect(cacheHint.stats(CH).failPoint).toBeNull();
        expect(cacheHint.currentOf()).toBeNull();
    });

    it("safePoint(11min) > failPoint(10min) 时，10.5min 的请求不提示（安全点优先）", () => {
        cacheHint.reset();
        // 先造 failPoint=10min（安全区还低）
        cacheHint.noteRequest({ provider: "opencode-go", model: "deepseek-v4.1-flash", taskUri: "t", now: T0 });
        const firstMiss = cacheHint.noteRequest({
            provider: "opencode-go",
            model: "deepseek-v4.1-flash",
            taskUri: "t",
            now: T0 + 10 * MIN,
        });
        cacheHint.noteFirstStepResult({ channel: firstMiss.channel, gapMs: firstMiss.gapMs, now: T0 + 10 * MIN, ...MISS });
        expect(cacheHint.stats(CH).failPoint).toBe(10 * MIN);

        // 再用 100 次 11min 的成功把 safePoint 撑到 11min
        for (let i = 1; i <= 100; i++) {
            const r = cacheHint.noteRequest({
                provider: "opencode-go",
                model: "deepseek-v4.1-flash",
                taskUri: "t",
                now: T0 + 10 * MIN + 11 * MIN * i,
            });
            cacheHint.noteFirstStepResult({ channel: r.channel, gapMs: r.gapMs, now: T0 + 10 * MIN + 11 * MIN * i, ...HIT });
        }
        expect(cacheHint.stats(CH).safePoint).toBe(11 * MIN);
        cacheHint.dismiss();

        // 10.5min 越过 failPoint(10min) 但没越过 safePoint(11min) → 不提示
        const quiet = cacheHint.noteRequest({
            provider: "opencode-go",
            model: "deepseek-v4.1-flash",
            taskUri: "t",
            now: T0 + 10 * MIN + 11 * MIN * 100 + Math.round(10.5 * MIN),
        });
        expect(quiet.gapMs).toBe(Math.round(10.5 * MIN));
        expect(quiet.hint).toBeNull();
        // 越过 11min 才提示，且说"安全期"
        const loud = cacheHint.noteRequest({
            provider: "opencode-go",
            model: "deepseek-v4.1-flash",
            taskUri: "t",
            now: T0 + 10 * MIN + 11 * MIN * 100 + Math.round(10.5 * MIN) + Math.round(12 * MIN),
        });
        expect(loud.hint?.thresholdKind).toBe("safe");
        expect(loud.hint?.thresholdMs).toBe(11 * MIN);
    });

    it("今日计数跨 turn 累计；✕ 关掉当前那一条", () => {
        cacheHint.reset();
        cacheHint.noteRequest({ provider: "opencode-go", model: "deepseek-v4.1-flash", taskUri: "t", now: T0 });
        const miss = cacheHint.noteRequest({
            provider: "opencode-go",
            model: "deepseek-v4.1-flash",
            taskUri: "t",
            now: T0 + 20 * MIN,
        });
        cacheHint.noteFirstStepResult({
            channel: miss.channel,
            gapMs: miss.gapMs,
            taskUri: "t",
            now: T0 + 20 * MIN,
            ...MISS,
        });
        expect(cacheHint.currentOf()?.todayCount).toBe(1);
        cacheHint.dismiss();
        expect(cacheHint.currentOf()).toBeNull();

        const again = cacheHint.noteRequest({
            provider: "opencode-go",
            model: "deepseek-v4.1-flash",
            taskUri: "t",
            now: T0 + 41 * MIN, // 21min > max(60s, failPoint 20min)
        });
        expect(again.hint?.todayCount).toBe(2);
    });

    it("维度 = provider × model：同模型换渠道是另一条统计", () => {
        cacheHint.reset();
        const a = cacheHint.noteRequest({
            provider: "opencode-go",
            model: "deepseek-v4.1-flash",
            taskUri: "t",
            now: T0,
        });
        cacheHint.noteRequest({
            provider: "direct",
            model: "deepseek-v4.1-flash",
            taskUri: "t",
            now: T0 + MIN,
        });
        cacheHint.noteFirstStepResult({ channel: a.channel, gapMs: null, ...HIT });
        expect(cacheHint.stats(CH).lastRequestAt).toBe(T0);
        expect(cacheHint.stats("direct/deepseek-v4.1-flash").lastRequestAt).toBe(T0 + MIN);
    });

    it("用量面板的 stats 视图：按模型 ref 解析出渠道 + 两个边界 + 上次请求时刻", () => {
        cacheHint.reset();
        cacheHint.noteRequest({
            provider: "opencode-go",
            model: "deepseek-v4.1-flash",
            taskUri: "t",
            now: 1_700_000_000_000,
        });
        const v = cacheHint.viewOf("0@opencode-go/deepseek-v4.1-flash")!;
        expect(v.channel).toBe(CH);
        expect(v.safePointMs).toBe(SAFE_POINT_DEFAULT_MS);
        expect(v.failPointMs).toBeNull();
        expect(v.lastRequestAt).toBe(1_700_000_000_000);
        expect(v.samples).toBe(0);
        // 未知模型 → null（不编一个渠道）
        expect(cacheHint.viewOf("不存在@no/where")).toBeNull();
        expect(cacheHint.viewOf(null)).toBeNull();
    });
});
