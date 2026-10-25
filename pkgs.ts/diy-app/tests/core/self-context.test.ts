// tests/core/self-context.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 `runtime.self`（自量）：口算清楚 + **必须落在 runtime**。
//
// 守的两条契约（##404 / ##9 提案）：
//   ① 量不到就不给（缺席，不写 0 / 不写 "—"）—— 编出来的数会被当成事实。
//   ② 绝不进 system 段：这三个数每步都变，进 system 就是每步砸前缀缓存。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from "vitest";
import { buildSelfValue } from "../../src/shared/context/self";
import { buildDelivery, defaultSystemPlaces, PLACE_CANDIDATES } from "../../src/shared/context/delivery";
import { atomicUnitPaths, changelogUnitPaths } from "../../src/shared/context/changelog";
import { noteSelfStep, resetSelfUsage, selfOf } from "../../src/main/services/self-usage";

const buckets = (p: { total: number; output?: number; cacheRead?: number; input?: number }) => ({
    total: p.total,
    outputTotal: p.output ?? 0,
    cacheRead: p.cacheRead ?? 0,
    inputTotal: p.input ?? 0,
});

describe("buildSelfValue · 口算", () => {
    it("什么都不知道（新进程首轮首步）⇒ 整节缺席，不是 self: {}", () => {
        expect(buildSelfValue({ lastBuckets: null, lastCost: null, turnSteps: 0, turnCost: null })).toBeNull();
    });

    it("窗口占用按上一步总量 ÷ 上限，ratio 是百分数", () => {
        const v = buildSelfValue({
            lastBuckets: buckets({ total: 39_378, output: 695, input: 38_683, cacheRead: 35_000 }),
            lastCost: null,
            contextLimit: 1_000_000,
            turnSteps: 2,
            turnCost: null,
        })!;
        expect(v.window).toEqual({ used: 39_378, limit: 1_000_000, ratio: 3.9 });
        expect(v.last).toEqual({ output: 695, cacheHit: 90.5 });
    });

    it("窗口上限未知 ⇒ window 缺席（不编百分比）；缓存命中量不到 ⇒ cacheHit 缺席", () => {
        const v = buildSelfValue({
            lastBuckets: buckets({ total: 1000, output: 10, input: 0 }),
            lastCost: null,
            contextLimit: null,
            turnSteps: 1,
            turnCost: null,
        })!;
        expect(v.window).toBeUndefined();
        expect(v.last).toEqual({ output: 10 });
        expect(v.turn).toEqual({ steps: 1 });
    });

    it("无价目 ⇒ cost 缺席（**不是 0**）；有价目 ⇒ 6 位小数", () => {
        const none = buildSelfValue({
            lastBuckets: buckets({ total: 10, output: 1, input: 9, cacheRead: 9 }),
            lastCost: null,
            contextLimit: 100,
            turnSteps: 1,
            turnCost: null,
            turnUnpriced: 1,
        })!;
        expect(none.last?.cost).toBeUndefined();
        expect(none.turn).toEqual({ steps: 1, unpriced: 1 });

        const priced = buildSelfValue({
            lastBuckets: buckets({ total: 10, output: 1, input: 9, cacheRead: 9 }),
            lastCost: { noCache: 0, cacheRead: 0.00098, cacheWrite: null, text: 0, reasoning: 0, total: 0.00098 },
            contextLimit: 100,
            turnSteps: 3,
            turnCost: { noCache: 0.1, cacheRead: 0.0115, cacheWrite: null, text: 0, reasoning: 0, total: 0.1115 },
        })!;
        expect(priced.last?.cost).toBe(0.00098);
        expect(priced.turn).toEqual({ steps: 3, cost: 0.1115 });
    });

    it("本轮步数为 0 ⇒ turn 缺席（还没走过一步，别报 steps: 0）", () => {
        const v = buildSelfValue({
            lastBuckets: buckets({ total: 5, output: 1, input: 4, cacheRead: 4 }),
            lastCost: null,
            contextLimit: 100,
            turnSteps: 0,
            turnCost: null,
        })!;
        expect(v.turn).toBeUndefined();
        expect(v.window?.ratio).toBe(5);
    });
});

describe("selfOf · 内存账", () => {
    beforeEach(() => resetSelfUsage());

    it("记账后读得到上一步；没记账 ⇒ 只有本轮现场", () => {
        expect(selfOf("t1", { contextLimit: 100, steps: 0, cost: null })).toBeNull();
        noteSelfStep("t1", buckets({ total: 50, output: 5, input: 45, cacheRead: 40 }), null);
        const v = selfOf("t1", { contextLimit: 100, steps: 1, cost: null })!;
        expect(v.window?.ratio).toBe(50);
        expect(v.last?.cacheHit).toBe(88.9);
        expect(v.turn?.steps).toBe(1);
        // 别的任务不串账
        expect(selfOf("t2", { contextLimit: 100, steps: 0, cost: null })).toBeNull();
    });
});

describe("投递位置", () => {
    it("self 在候选表里且 system: false（每步都变，进 system = 砸缓存）", () => {
        const c = PLACE_CANDIDATES.find((x) => x.path === "self")!;
        expect(c).toBeTruthy();
        expect(c.system).toBe(false);
        expect(defaultSystemPlaces()).not.toContain("self");
    });

    it("真发时落在 runtime 段、system 段没有它", () => {
        const globals = {
            task: { uri: "projects/1/tasks/1", title: "t", state: "pending", dir: "/h/p/1/tasks/1", body: "b" },
            self: { window: { used: 39_378, limit: 1_000_000, ratio: 3.9 }, turn: { steps: 2, cost: 0.001 } },
        };
        const d = buildDelivery(globals, defaultSystemPlaces());
        expect(d.runtime.text).toContain("self:");
        expect(d.runtime.text).toContain("ratio: 3.9");
        // 比 `system.text`（含 help 段，那里本来就有结构说明）用 **systemData**：纯变量树
        expect(d.systemData.text).not.toContain("ratio:");
        expect(d.systemData.text).not.toContain("self");
        expect(d.runtime.places).toContain("self");
    });
});

describe("投递 vs 变更历史（两个消费者口径不同，别合并）", () => {
    it("self 进 runtimeDiff（模型要看最新数），但不进变更历史（每步必变 = 噪声）", () => {
        // 投递侧：`self` 在原子单元里（runtime diff 靠它算出 changedRun）
        expect(atomicUnitPaths()).toContain("self");
        // 变更历史侧：被 `changelog: false` 排除
        expect(changelogUnitPaths()).not.toContain("self");
        // 其余单元的差异一览无遗：只有 self 被排除（别顺手把别的东西也筛掉）
        expect(changelogUnitPaths()).toEqual(atomicUnitPaths().filter((p) => p !== "self"));
    });
});
