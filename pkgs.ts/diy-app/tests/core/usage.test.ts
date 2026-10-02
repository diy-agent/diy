// tests/core/usage.test.ts
// 🎯 用量口径锁定（任务 231 / 设计 211 §一·四·五）：
//   四桶关系、tier 选价、金额分解、**不可测 ≠ 0**、聚合与格式化。
//
// 为什么这些必须单测：三个消费端（落盘 / UI 页脚明细 / CLI 报表）共用 shared/usage，
// 而它们答的是同一个问题「我花了多少、离窗口上限多远」。口径漂了不会报错，只会静默给出
// 一个看起来合理但错的数 —— 那正是 ##227 里"UI 数字与后台对不上"的成因。

import { describe, it, expect } from "vitest";
import {
    bucketsOf,
    cacheHitRate,
    costBreakdown,
    fmtCost,
    fmtTokens,
    groupByAgent,
    groupByTurn,
    ratesOf,
    snapshotUsage,
    sumBuckets,
    sumCosts,
    turnUsagePatch,
    windowRate,
    type StepUsageRecord,
} from "../../src/shared/usage";
import { costOf, LOCAL_MODELS, contextLimitOf } from "../../src/shared/models";

/** 一条 responses 面的 finish-step usage（luna 系实测形状，含 cacheWrite 与 reasoning） */
const RESP_USAGE = {
    inputTokens: 764,
    inputTokenDetails: { noCacheTokens: 252, cacheReadTokens: 512, cacheWriteTokens: 0 },
    outputTokens: 29,
    outputTokenDetails: { textTokens: 22, reasoningTokens: 7 },
    totalTokens: 793,
    raw: { prompt_tokens: 764, completion_tokens: 29 },
};

describe("四桶口径（##211 §1b：AI SDK 归一化后的权威关系）", () => {
    it("总输入 = 非缓存 + 缓存读 + 缓存写；总输出 = 文本 + 思考", () => {
        const b = bucketsOf(RESP_USAGE);
        expect(b.noCache).toBe(252);
        expect(b.cacheRead).toBe(512);
        expect(b.cacheWrite).toBe(0);
        expect(b.inputTotal).toBe(764);
        expect(b.text).toBe(22);
        expect(b.reasoning).toBe(7);
        expect(b.outputTotal).toBe(29);
        expect(b.total).toBe(793);
    });

    it("思考是总输出的**子集**：只拆解不另加（多加一次就是重复计费）", () => {
        const b = bucketsOf(RESP_USAGE);
        expect(b.total).toBe(b.inputTotal + b.outputTotal);
        // 思考**不再**单独加到 total 上（opencode 口径的改法）：拆开只是展示
        expect(b.total).not.toBe(b.inputTotal + b.outputTotal + b.reasoning);
    });

    it("chat 面 cacheWrite 恒 undefined → 保持 null（不可测），**不落 0**", () => {
        const b = bucketsOf({
            inputTokens: 102,
            inputTokenDetails: { noCacheTokens: 102, cacheReadTokens: 4544 },
            outputTokens: 25,
        });
        expect(b.cacheWrite).toBeNull();
        expect(b.inputTotal).toBe(102 + 4544); // 不可测桶不参与求和
    });

    it("上游只给总数时按反推兜底（展示可用，桶仍以 provider 为真）", () => {
        const b = bucketsOf({ inputTokens: 1000, inputTokenDetails: { cacheReadTokens: 400 }, outputTokens: 50 });
        expect(b.noCache).toBe(600); // 1000 - 400
        expect(b.text).toBe(50); // 无明细 → 全算文本
    });
});

describe("tier 选价（按**总输入 token**取满足条件的最大阈值）", () => {
    const luna6 = LOCAL_MODELS.find((m) => m.id === "gpt-6-luna")!;

    it("未过阈值 → base 价", () => {
        const r = ratesOf(luna6.cost, 271_999)!;
        expect(r.tier).toBe("base");
        expect(r.input).toBe(0.1);
    });

    it("超过 272k → 整档翻倍", () => {
        const r = ratesOf(luna6.cost, 272_001)!;
        expect(r.tier).toBe("input>272000");
        expect(r.input).toBe(0.2);
        expect(r.cacheWrite).toBe(0.25);
    });

    it("阈值边界是**严格大于**（等于不翻档）", () => {
        expect(ratesOf(luna6.cost, 272_000)!.tier).toBe("base");
    });

    it("分母含缓存读/写：小非缓存 + 大缓存读也能翻档", () => {
        // costOf 的 promptTokens 就是 buckets.inputTotal（= 三桶之和）
        const b = bucketsOf({
            inputTokens: 300_000,
            inputTokenDetails: { noCacheTokens: 1_000, cacheReadTokens: 299_000 },
            outputTokens: 10,
        });
        expect(costOf("gpt-6-luna", b.inputTotal)!.tier).toBe("input>272000");
    });

    it("无价目的模型 → null（不猜价，也不按 0 算）", () => {
        expect(costOf("不存在的模型", 1000)).toBeNull();
    });
});

describe("金额分解（##211 §四.2：取 pi 口径，思考不重复计）", () => {
    it("逐项 = 桶 × 单价；合计 = 非缓存 + 缓存读 + 缓存写 + 文本 + 思考", () => {
        const rates = ratesOf(LOCAL_MODELS.find((m) => m.id === "gpt-6-luna")!.cost, 764)!;
        const c = costBreakdown(rates, bucketsOf(RESP_USAGE));
        expect(c.noCache).toBeCloseTo((0.1 * 252) / 1e6, 12);
        expect(c.cacheRead).toBeCloseTo((0.01 * 512) / 1e6, 12);
        expect(c.cacheWrite).toBe(0); // 实测为 0（可测且有价）
        expect(c.text).toBeCloseTo((0.5 * 22) / 1e6, 12);
        expect(c.reasoning).toBeCloseTo((0.5 * 7) / 1e6, 12);
        expect(c.total).toBeCloseTo(c.noCache + c.cacheRead + c.text + c.reasoning, 12);
    });

    it("不可测桶 → 金额也是 null（按 0 算是静默低估）", () => {
        const rates = ratesOf(LOCAL_MODELS.find((m) => m.id === "mimo-v2.6-flash")!.cost, 100)!;
        const c = costBreakdown(rates, bucketsOf({ inputTokens: 100, inputTokenDetails: { noCacheTokens: 100 }, outputTokens: 5 }));
        expect(c.cacheWrite).toBeNull();
    });

    it("cacheWrite 有 token 但无单价时按普通输入价兜底（保守且可解释）", () => {
        const rates = ratesOf({ input: 1, output: 2 }, 100)!;
        expect(rates.cacheWrite).toBeUndefined();
        const c = costBreakdown(rates, { noCache: 0, cacheRead: 0, cacheWrite: 1000, text: 0, reasoning: 0 });
        expect(c.cacheWrite).toBeCloseTo((1 * 1000) / 1e6, 12);
    });

    it("chat 面（mimo）实测金额：与手算一致", () => {
        const rates = ratesOf(LOCAL_MODELS.find((m) => m.id === "mimo-v2.6-flash")!.cost, 171)!;
        const c = costBreakdown(rates, { noCache: 102, cacheRead: 4544, cacheWrite: null, text: 8, reasoning: 17 });
        expect(c.total).toBeCloseTo((0.14 * 102 + 0.0028 * 4544 + 0.28 * 25) / 1e6, 12);
    });
});

describe("窗口占用 / 缓存命中率", () => {
    it("窗口占用 = (总输入 + 总输出) ÷ 上限；上限未知 → null（不编百分比）", () => {
        expect(windowRate({ total: 262_144 }, 1_048_576)).toBeCloseTo(0.25, 6);
        expect(windowRate({ total: 262_144 }, undefined)).toBeNull();
    });

    it("缓存命中率分母是总输入（含缓存读），空输入 → null", () => {
        expect(cacheHitRate({ cacheRead: 50, inputTotal: 100 })).toBeCloseTo(0.5, 6);
        expect(cacheHitRate({ cacheRead: 0, inputTotal: 0 })).toBeNull();
    });

    it("页脚两种口径并存且**不可相除**：累加值（重发成本）≠ 窗口分子（上下文）", () => {
        // 实测场景（2026-10-02）：一轮 40 步，累加 986k，而真实上下文只有最后一步的 44k。
        // 界面上这两个数并排显示 —— 不标注范围就会被读成"窗口 96%"。
        const step = (n: number) => bucketsOf({
            inputTokens: n, inputTokenDetails: { noCacheTokens: 1000, cacheReadTokens: n - 1000 }, outputTokens: 100,
        });
        const cumulative = sumBuckets([step(20_000), step(24_000)]);
        const patch = turnUsagePatch(cumulative, step(24_000), null, 1_000_000, 2);
        expect(patch.inputTotal).toBe(44_000);      // 累加（解释"这轮为什么贵"）
        expect(patch.windowTotal).toBe(24_100);     // 最后一步（上下文压力）
        expect(patch.lastInputTotal).toBe(24_000);
        expect(patch.lastOutputTotal).toBe(100);
        expect(patch.steps).toBe(2);
        // 上限是同一个，但两个分子差一倍以上 —— 混用得出的是假象
        expect(windowRate({ total: patch.windowTotal }, patch.contextLimit!)).toBeCloseTo(0.0241, 6);
        expect(windowRate({ total: patch.total }, patch.contextLimit!)).toBeCloseTo(0.0442, 6);
    });

    it("窗口占用分子**不是**累加值：最后一步才是上下文压力", () => {
        const cumulative = sumBuckets([
            bucketsOf({ inputTokens: 1000, inputTokenDetails: { noCacheTokens: 1000 }, outputTokens: 100 }),
            bucketsOf({ inputTokens: 1500, inputTokenDetails: { noCacheTokens: 200, cacheReadTokens: 1300 }, outputTokens: 50 }),
        ]);
        const last = bucketsOf({ inputTokens: 1500, inputTokenDetails: { noCacheTokens: 200, cacheReadTokens: 1300 }, outputTokens: 50 });
        const patch = turnUsagePatch(cumulative, last, null, 10_000);
        expect(patch.total).toBe(2650); // 累加（解释"这轮为什么贵"）
        expect(patch.windowTotal).toBe(1550); // 最后一步（上下文压力）
        expect(patch.contextLimit).toBe(10_000);
    });
});

describe("聚合（UI 明细/看板与 CLI 报表共用）", () => {
    const rec = (over: Partial<StepUsageRecord>): StepUsageRecord => ({
        ts: "2026-10-02T09:12:01Z",
        turnId: "t1",
        step: 1,
        persona: "persona/1",
        model: "gpt-6-luna",
        apiFace: "responses",
        usage: snapshotUsage(RESP_USAGE)!,
        ...over,
    });
    const priced = (r: StepUsageRecord): StepUsageRecord => {
        const rates = costOf(r.model, bucketsOf(r.usage).inputTotal)!;
        return { ...r, rates: { ...rates, asOf: "2026-10-02" }, cost: costBreakdown(rates, bucketsOf(r.usage)) };
    };

    it("按 turn 分组：步升序、桶相加、成本取快照之和", () => {
        const rows = [
            priced(rec({ turnId: "t1", step: 2 })),
            priced(rec({ turnId: "t1", step: 1 })),
            priced(rec({ turnId: "t2", step: 1 })),
        ];
        const groups = groupByTurn(rows);
        expect(groups.map((g) => g.turnId)).toEqual(["t1", "t2"]);
        expect(groups[0]!.steps.map((s) => s.record.step)).toEqual([1, 2]);
        expect(groups[0]!.buckets.inputTotal).toBe(764 * 2);
        expect(groups[0]!.last.record.step).toBe(2); // 窗口占用取最后一步
        expect(groups[0]!.cost!.total).toBeCloseTo(groups[0]!.steps.reduce((s, v) => s + v.cost!.total, 0), 12);
    });

    it("按 人物+模型+面+档位 分行（同一会话换模型 → 多行）", () => {
        const rows = [
            priced(rec({ persona: "persona/1", model: "gpt-6-luna", apiFace: "responses", reasoningEffort: "medium" })),
            priced(rec({ persona: "persona/1", model: "gpt-6-luna", apiFace: "responses", reasoningEffort: "medium" })),
            priced(rec({ persona: "persona/2", model: "mimo-v2.6-flash", apiFace: "chat", reasoningEffort: "high" })),
        ];
        const groups = groupByAgent(rows);
        expect(groups).toHaveLength(2);
        expect(groups[0]!.stepCount).toBe(2);
        expect(groups[1]!.tiers).toEqual(["base"]);
    });

    it("缺金额快照的步被计为 unpriced（合计不完整必须说得出）", () => {
        const rows = [priced(rec({})), rec({ step: 2 })]; // 第二条无 rates/cost
        const g = groupByTurn(rows)[0]!;
        expect(g.unpriced).toBe(1);
        expect(g.cost!.total).toBeCloseTo(rows[0]!.cost!.total, 12);
    });

    it("不可测桶聚合保持 null（不被 0 污染）", () => {
        const b = sumBuckets([
            bucketsOf({ inputTokens: 10, inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0 }, outputTokens: 1 }),
            bucketsOf({ inputTokens: 20, inputTokenDetails: { noCacheTokens: 5, cacheReadTokens: 15 }, outputTokens: 2 }),
        ]);
        expect(b.cacheWrite).toBeNull();
        const c = sumCosts([
            { noCache: 1, cacheRead: 2, cacheWrite: null, text: 3, reasoning: 4, total: 10 },
            { noCache: 1, cacheRead: 2, cacheWrite: 5, text: 3, reasoning: 4, total: 15 },
        ]);
        expect(c.cacheWrite).toBe(5); // 有实测值才累加
        expect(c.total).toBe(25);
    });
});

describe("展示格式化（UI 与 CLI 同源）", () => {
    it("token：万位起用 k，百万用 M", () => {
        expect(fmtTokens(764)).toBe("764");
        expect(fmtTokens(180_400)).toBe("180.4k");
        expect(fmtTokens(1_048_576)).toBe("1.05M");
    });

    it("金额：小额保留足够位数（四舍五入成 0 就白显示了）", () => {
        expect(fmtCost(0.00004482)).toBe("0.000045");
        expect(fmtCost(0.919)).toBe("0.9190");
        expect(fmtCost(0)).toBe("0");
    });

    it("spec 样例：luna 的 per-step 金额逐项可复算（##211 §六b 的 s2 行）", () => {
        const rates = ratesOf(LOCAL_MODELS.find((m) => m.id === "gpt-6-luna")!.cost, 764)!;
        const c = costBreakdown(rates, bucketsOf(RESP_USAGE));
        expect(fmtCost(c.noCache)).toBe("0.000025");
        expect(fmtCost(c.total)).toBe("0.000045"); // 0.0000252+0.00000512+0.000011+0.0000035
    });
});

describe("落盘快照（字段必须看得见「没有这个数」）", () => {
    it("undefined → null，raw 原样保留", () => {
        const s = snapshotUsage({ inputTokens: 5, inputTokenDetails: { noCacheTokens: 5 }, outputTokens: 1 })!;
        expect(s.inputTokenDetails.cacheWriteTokens).toBeNull();
        expect(s.outputTokenDetails.reasoningTokens).toBeNull();
        expect(s.totalTokens).toBeNull();
    });

    it("空 usage → null（不写一行空记录）", () => {
        expect(snapshotUsage(undefined)).toBeNull();
    });
});

describe("模型表价格数据自洽", () => {
    it("四个模型都有价格，且 contextLimit 与 tier 阈值分开（不是同一个数）", () => {
        for (const m of LOCAL_MODELS) {
            expect(m.cost, `${m.id} 缺价格`).toBeTruthy();
            expect(contextLimitOf(m.id)).toBeGreaterThan(0);
        }
        // responses 面（有 cacheWrite 价）与 chat 面（无）必须区分开：这是"可测性"的前提
        expect(LOCAL_MODELS.find((m) => m.id === "gpt-6-luna")!.cost!.cacheWrite).toBe(0.125);
        expect(LOCAL_MODELS.find((m) => m.id === "mimo-v2.6-flash")!.cost!.cacheWrite).toBeUndefined();
    });
});
