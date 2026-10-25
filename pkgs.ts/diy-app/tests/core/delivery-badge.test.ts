// tests/core/delivery-badge.test.ts
// 🎯 「历史」徽章的文案真源（##423）：徽章文本 / hover 是**契约**，这里逐条钉住。
//
// 用户 2026-10-23：「Q3 需要写清楚，不然我也搞不清触发条件」——
// 旧文案 `投递·全量` 的「全量」在 runtime 语境里读作「runtime 全量投递」，
// 实际含义只是「这一步一条历史消息都没丢」（历史裁剪维度）。

import { describe, it, expect } from "vitest";
import {
    deliveryBadgeText,
    deliveryBadgeTitle,
    fmtBudgetBytes,
    mustStagesOf,
    stageSummary,
    TRIGGER_LABEL,
    type DeliveryBadgeInput,
} from "../../src/shared/context/delivery-badge";
import { DEFAULT_KEEP } from "../../src/shared/context/compact-keep";

const sel = (over: Partial<DeliveryBadgeInput["selection"]> = {}): DeliveryBadgeInput["selection"] => ({
    budgetBytes: 61440,
    keptBytes: 2048,
    keptRuns: 2,
    droppedMessages: 0,
    totalMessages: 5,
    ...over,
});

const cfg: DeliveryBadgeInput["cfg"] = {
    mode: "auto",
    triggers: { systemContextChanged: true, cacheExpired: true, contextWindowOver: 61440 },
    ttlMs: 60 * 60_000,
    mustStages: mustStagesOf(undefined),
};

const input = (over: Partial<DeliveryBadgeInput> = {}): DeliveryBadgeInput => ({
    selection: sel(),
    hits: [],
    cfg,
    stepTokens: 12345,
    ...over,
});

describe("##423 徽章文本：维度写在词里，不再有裸「全量」", () => {
    it("没丢消息 → 「历史·无裁剪」；丢了 → 「历史·丢 N 条」", () => {
        expect(deliveryBadgeText(sel())).toBe("历史·无裁剪");
        expect(deliveryBadgeText(sel({ droppedMessages: 3 }))).toBe("历史·丢 3 条");
        for (const t of [deliveryBadgeText(sel()), deliveryBadgeText(sel({ droppedMessages: 3 }))]) {
            expect(t).not.toContain("全量");
            expect(t.startsWith("历史")).toBe(true);
        }
    });

    it("字节：0 是「清零」、其余按 KB / B", () => {
        expect(fmtBudgetBytes(0)).toBe("0（清零）");
        expect(fmtBudgetBytes(3072)).toBe("3 KB");
        expect(fmtBudgetBytes(512)).toBe("512 B");
    });
});

describe("##423 hover：四块缺一不可", () => {
    const title = deliveryBadgeTitle(input());

    it("① 说清维度 = 历史裁剪（与 runtime 无关）+ 预算/丢几条/保留几段", () => {
        expect(title).toContain("历史裁剪");
        expect(title).toContain("与 runtime 无关");
        expect(title).toContain("预算 60 KB");
        expect(title).toContain("丢 0/5 条");
        expect(title).toContain("保留 2 段");
    });

    it("②【关键】must 级不吃预算要写在脸上（压完还超预算的根因）", () => {
        expect(title).toContain("预算只约束非 must 级");
        expect(title).toContain("must 级（必保）不吃预算");
        expect(title).toContain("每轮都在压");
        // 缺省 plan 的必保级 = steps n=6（回显成数据，不是空话）
        expect(title).toContain("steps n=6");
    });

    it("③ 三触发器都列出来（名字 + 配置开关 + 阈值）", () => {
        for (const k of ["systemContextChanged", "cacheExpired", "contextWindowOver"]) expect(title).toContain(k);
        expect(title).toContain("mode=auto");
        expect(title).toContain("60 分钟"); // cacheExpired 的生效 TTL
        expect(title).toContain("上限 61440 tok");
    });

    it("④ 本步命中要说得出来：未命中 / 命中哪个；窗口超限给实测 vs 上限", () => {
        expect(title).toContain("本步未命中");
        expect(title).toContain("实测 12345 tok vs 上限 61440 tok");

        const hit = deliveryBadgeTitle(input({ hits: [{ trigger: "contextWindowOver", by: "auto" }] }));
        expect(hit).toContain("本步命中");
        expect(hit).toContain("实测 12345 tok vs 上限 61440 tok");
    });

    it("手动压不归触发器：另起一行说清，不让它看起来像「三个都没命中却压过」", () => {
        const t = deliveryBadgeTitle(input({ hits: [{ trigger: "manual", by: "ui" }] }));
        expect(t).toContain("本步未命中");
        expect(t).toContain("另有手动压缩 1 次");
    });

    it("没有实测 token → 说「无实测」，不编 0", () => {
        expect(deliveryBadgeTitle(input({ stepTokens: null }))).toContain("实测 无实测");
    });

    it("读不到配置 → 只讲历史裁剪事实，不编触发条件", () => {
        const t = deliveryBadgeTitle(input({ cfg: null }));
        expect(t).toContain("历史裁剪");
        expect(t).toContain("配置未读到");
        expect(t).not.toContain("本步命中");
    });
});

describe("must 级识别", () => {
    it("配置没写 keep → 回落缺省管道（steps 必保）", () => {
        expect(mustStagesOf(undefined).map((s) => s.summary)).toContain("steps n=6");
    });

    it("配置写了 keep → 按配置算（must 缺省 false = 计预算）", () => {
        const keep = [
            { type: "recent" as const, data: { n: 3 } },
            { type: "ladder" as const, must: true },
        ];
        expect(mustStagesOf(keep)).toEqual([{ type: "ladder", summary: "ladder" }]);
    });

    it("级摘要：带参数就带出来（steps n=6 / role tool）", () => {
        expect(stageSummary(DEFAULT_KEEP[0]!)).toBe("steps n=6");
        expect(stageSummary({ type: "role", data: { role: "tool" } } as never)).toBe("role tool");
    });
});

describe("触发器词的单一真源", () => {
    it("四个 trigger 都有中文短名", () => {
        expect(TRIGGER_LABEL.systemContextChanged).toBe("系统上下文变");
        expect(TRIGGER_LABEL.cacheExpired).toBe("缓存过期");
        expect(TRIGGER_LABEL.contextWindowOver).toBe("窗口超限");
        expect(TRIGGER_LABEL.manual).toBe("手动");
    });
});
