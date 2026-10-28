// tests/core/usage-fields.test.ts
// 🎯 ##443 刀 2：用量字段契约的**六条硬口径**与聚合等价性锁死。
//
// 为什么这些必须单测：`usage-fields.ts` 要成为四级粒度（step / turn / persona / session）
// 与三处消费者（renderer 表格 / 主进程 CLI 报表 / 将来的导出）**唯一的算数入口**。
// 口径漂了不会报错 —— 只会静默给出"看起来合理但错"的数（##227 的老教训）：
//   · 窗口占用被当成可加数 → 40 步累加成 1M 的假 80%
//   · 缓存命中率拿各步比率求平均 → 短步权重被放大
//   · 缓存写全不可测被写成 0 → 静默低估
// 故这里逐条断言，含**反例**（证明"不是碰巧相等"）。

import { describe, expect, it } from "vitest";
import {
    USAGE_FIELDS,
    aggregateUsage,
    columnsFor,
    fmtCell,
    isPartial,
    type Gran,
    type UsageRow,
} from "../../src/shared/usage-fields";
import type { CostBreakdown, StepUsageRecord } from "../../src/shared/usage";

// ─── 造数（只造账本形状；数值全部来自参数，测试里不藏口径）──────────────

interface StepOpts {
    turnId?: string;
    step?: number;
    persona?: string;
    model?: string;
    apiFace?: string;
    reasoningEffort?: string;
    contextLimit?: number;
    noCache?: number;
    cacheRead?: number;
    cacheWrite?: number | null;
    text?: number;
    reasoning?: number;
    stepTimeMs?: number;
    responseTimeMs?: number;
    ttftMs?: number;
    /** 显式生效速度（`effectiveOutputTokensPerSecond`）；缺省不写 → 由 `responseTimeMs` 折算 */
    effRate?: number;
    /** 金额快照；`null` = 无价目（账本里就是 `cost: null`） */
    cost?: CostBreakdown | null;
    tier?: string;
    contextParts?: { systemBytes: number; toolsBytes: number };
    historySelection?: {
        limitTokens: number;
        keptTokens?: number;
        droppedTokens?: number;
        keptBytes: number;
        keptRuns: number;
        droppedMessages: number;
        totalMessages: number;
    };
    ts?: string;
}

const cost = (n: number): CostBreakdown => ({
    noCache: n,
    cacheRead: 0,
    cacheWrite: null,
    text: 0,
    reasoning: 0,
    total: n,
});

let seq = 0;
function rec(o: StepOpts = {}): StepUsageRecord {
    const noCache = o.noCache ?? 0;
    const cacheRead = o.cacheRead ?? 0;
    const cacheWrite = o.cacheWrite === undefined ? null : o.cacheWrite;
    const text = o.text ?? 0;
    const reasoning = o.reasoning ?? 0;
    const inputTotal = noCache + cacheRead + (cacheWrite ?? 0);
    const outputTotal = text + reasoning;
    seq++;
    return {
        ts: o.ts ?? `2026-10-04T15:00:${String(seq % 60).padStart(2, "0")}.000Z`,
        turnId: o.turnId ?? "t1",
        step: o.step ?? 1,
        persona: o.persona,
        model: o.model ?? "m-a",
        apiFace: o.apiFace ?? "chat",
        reasoningEffort: o.reasoningEffort,
        contextLimit: o.contextLimit,
        usage: {
            inputTokens: inputTotal,
            inputTokenDetails: { noCacheTokens: noCache, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
            outputTokens: outputTotal,
            outputTokenDetails: { textTokens: text, reasoningTokens: reasoning },
            totalTokens: inputTotal + outputTotal,
        },
        performance:
            o.stepTimeMs == null && o.responseTimeMs == null && o.ttftMs == null && o.effRate == null
                ? undefined
                : {
                      stepTimeMs: o.stepTimeMs,
                      responseTimeMs: o.responseTimeMs,
                      timeToFirstOutputMs: o.ttftMs,
                      effectiveOutputTokensPerSecond: o.effRate,
                  },
        rates: o.tier ? ({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: null, tier: o.tier } as never) : undefined,
        cost: o.cost === undefined ? cost(0.001) : o.cost,
        contextParts: o.contextParts,
        historySelection: o.historySelection,
    };
}

const field = (r: UsageRow | undefined, key: string): unknown => r?.fields[key];

/** Σ 数值；**一个数都没有 → null**（不是 0）—— 与 `usage-fields` 的 sum 判据同口径 */
const sumOrNull = (rows: readonly UsageRow[], key: string): number | null => {
    let n = 0;
    let seen = false;
    for (const r of rows) {
        const v = field(r, key);
        if (typeof v === "number" && Number.isFinite(v)) {
            n += v;
            seen = true;
        }
    }
    return seen ? n : null;
};

// ─── 1. 聚合等价性：turn ≡ Σstep；persona ≡ Σ该人物 step；session ≡ Σ全部 step ──

describe("聚合等价性（turn / persona / session 都由 step 加出来）", () => {
    const rows = [
        rec({ turnId: "t1", step: 1, persona: "p1", noCache: 100, cacheRead: 900, text: 10, reasoning: 5 }),
        rec({ turnId: "t1", step: 2, persona: "p1", noCache: 200, cacheRead: 800, text: 20, reasoning: 0 }),
        rec({ turnId: "t2", step: 1, persona: "p2", noCache: 50, cacheRead: 0, text: 7, reasoning: 3 }),
    ];

    it("turn 的每个 sum 列 == 该轮 step 之和", () => {
        const stepRows = aggregateUsage(rows, "step");
        const turnRows = aggregateUsage(rows, "turn");
        const t1 = turnRows.find((r) => r.key === "t1");
        const t1Steps = stepRows.filter((r) => String(field(r, "turnId")) === "t1");

        for (const key of ["noCacheTokens", "cacheReadTokens", "textTokens", "reasoningTokens", "inputTotalTokens", "outputTotalTokens", "totalTokens", "stepTimeMs"]) {
            expect(field(t1, key), key).toBe(sumOrNull(t1Steps, key));
        }
        expect(field(t1, "stepCount")).toBe(t1Steps.length);
    });

    it("persona 的合计 == 该人物全部 step 之和（跨轮）", () => {
        const stepRows = aggregateUsage(rows, "step");
        const personaRows = aggregateUsage(rows, "persona");
        const p1 = personaRows.find((r) => r.key === "p1");
        const p1Steps = stepRows.filter((r) => field(r, "persona") === "p1");
        expect(field(p1, "totalTokens")).toBe(
            p1Steps.reduce((n, r) => n + (field(r, "totalTokens") as number), 0),
        );
        expect(field(p1, "stepCount")).toBe(2);
    });

    it("session 行 == Σturn == Σstep（三路必须同源）", () => {
        const sum = (rows2: UsageRow[], key: string) =>
            rows2.reduce((n, r) => n + (typeof field(r, key) === "number" ? (field(r, key) as number) : 0), 0);
        const stepRows = aggregateUsage(rows, "step");
        const turnRows = aggregateUsage(rows, "turn");
        const sessionRows = aggregateUsage(rows, "session");

        expect(sessionRows).toHaveLength(1);
        for (const key of ["noCacheTokens", "cacheReadTokens", "totalTokens", "inputTotalTokens", "outputTotalTokens"]) {
            expect(field(sessionRows[0], key), key).toBe(sum(stepRows, key));
            expect(sum(turnRows, key), key).toBe(sum(stepRows, key));
        }
        expect(field(sessionRows[0], "stepCount")).toBe(rows.length);
    });

    it("空输入 → 空数组（不返回一行假合计）", () => {
        expect(aggregateUsage([], "session")).toEqual([]);
        expect(aggregateUsage([], "turn")).toEqual([]);
    });
});

// ─── 2. 空值语义：null ≠ 0（缓存写/缓存写$ 全组不可测 → –）──────────────

describe("空值语义（不可测 ≠ 0）", () => {
    it("全组 cacheWrite 都是 null → 聚合为 null，字形 –", () => {
        const rows = [
            rec({ turnId: "t1", step: 1, cacheWrite: null, noCache: 10 }),
            rec({ turnId: "t1", step: 2, cacheWrite: null, noCache: 20 }),
        ];
        const turn = aggregateUsage(rows, "turn")[0];
        expect(field(turn, "cacheWriteTokens")).toBeNull();
        expect(field(turn, "cost.cacheWrite")).toBeNull();
        expect(fmtCell(field(turn, "cacheWriteTokens") as never, "token")).toBe("–");
    });

    it("混有实测（含显式 0）→ 求和；0 仍是 0，不变成 –", () => {
        const rows = [
            rec({ turnId: "t1", step: 1, cacheWrite: 0, noCache: 10 }),
            rec({ turnId: "t1", step: 2, cacheWrite: null, noCache: 20 }),
        ];
        const turn = aggregateUsage(rows, "turn")[0];
        expect(field(turn, "cacheWriteTokens")).toBe(0);
        expect(fmtCell(field(turn, "cacheWriteTokens") as never, "token")).toBe("0");
    });

    it("老记录缺 performance / contextParts → null，不抛错", () => {
        const rows = [rec({ turnId: "t1", step: 1 })];
        const row = aggregateUsage(rows, "step")[0]!;
        expect(field(row, "stepTimeMs")).toBeNull();
        expect(field(row, "responseTimeMs")).toBeNull();
        expect(field(row, "ttftMs")).toBeNull();
        expect(field(row, "rate")).toBeNull();
        expect(field(row, "contextParts.system")).toBeNull();
        expect(field(row, "contextParts.historyShare")).toBeNull();
        expect(fmtCell(field(row, "stepTimeMs") as never, "ms")).toBe("–");
    });
});

// ─── 3. last-step：窗口类取该组最后一步，绝不是加和 ─────────────────────

describe("last-step（窗口占用 / 窗口% / 上限）", () => {
    // 两步的窗口差一个量级：加和会得到 300k，末步才是 200k
    const rows = [
        rec({ turnId: "t1", step: 1, noCache: 100_000, contextLimit: 1_000_000 }),
        rec({ turnId: "t1", step: 2, noCache: 200_000, contextLimit: 1_000_000 }),
    ];

    it("turn 的 windowTotalTokens == 末步的值，且 ≠ 各步之和", () => {
        const turn = aggregateUsage(rows, "turn")[0]!;
        const sumOfSteps = 300_000;
        expect(field(turn, "windowTotalTokens")).toBe(200_000);
        expect(field(turn, "windowTotalTokens")).not.toBe(sumOfSteps);
    });

    it("windowRate 跟着末步（20%），不是两步平均（15%）", () => {
        const turn = aggregateUsage(rows, "turn")[0]!;
        expect(field(turn, "windowRate")).toBeCloseTo(0.2, 10);
        expect(field(turn, "contextLimit")).toBe(1_000_000);
    });

    it("累计列（totalTokens）仍是加和 —— 两个口径同时存在且不混", () => {
        const turn = aggregateUsage(rows, "turn")[0]!;
        expect(field(turn, "totalTokens")).toBe(300_000);
        expect(field(turn, "windowTotalTokens")).toBe(200_000);
    });
});

// ─── 4. recompute：缓存命中率 = Σ读 ÷ Σ输入，不是各步比率的算术平均 ──────

describe("recompute（缓存命中率）", () => {
    // 步 1 命中 0%，步 2 命中 100%；算术平均 = 50%，聚合口径 = 900/1000 = 90%
    const rows = [
        rec({ turnId: "t1", step: 1, noCache: 100, cacheRead: 0 }),
        rec({ turnId: "t1", step: 2, noCache: 0, cacheRead: 900 }),
    ];

    it("turn 命中率 == Σ缓存读 ÷ Σ总输入", () => {
        const turn = aggregateUsage(rows, "turn")[0]!;
        expect(field(turn, "cacheHitRate")).toBeCloseTo(0.9, 10);
    });

    it("明确不等于各步比率的平均（0.5）", () => {
        const turn = aggregateUsage(rows, "turn")[0]!;
        expect(field(turn, "cacheHitRate")).not.toBeCloseTo(0.5, 6);
    });

    it("step 粒度仍是单步比率（0% / 100%）", () => {
        const steps = aggregateUsage(rows, "step");
        expect(field(steps[0], "cacheHitRate")).toBeCloseTo(0, 10);
        expect(field(steps[1], "cacheHitRate")).toBeCloseTo(1, 10);
    });

    it("总输入为 0 → null（不编 0%）", () => {
        const turn = aggregateUsage([rec({ turnId: "t1", step: 1, noCache: 0, cacheRead: 0 })], "turn")[0]!;
        expect(field(turn, "cacheHitRate")).toBeNull();
    });
});

// ─── 5. unpriced：无价目步 > 0 ⇒ 合计是部分和 ───────────────────────────

describe("unpricedSteps（部分和标记）", () => {
    const rows = [
        rec({ turnId: "t1", step: 1, noCache: 10, cost: cost(0.5) }),
        rec({ turnId: "t1", step: 2, noCache: 20, cost: null }), // 无价目
    ];

    it("count 出无价目步数，且合计只加有价目的步", () => {
        const turn = aggregateUsage(rows, "turn")[0]!;
        expect(field(turn, "unpricedSteps")).toBe(1);
        expect(field(turn, "cost.total")).toBeCloseTo(0.5, 10);
    });

    it("isPartial 为真（渲染层据此标「部分和」）", () => {
        const turn = aggregateUsage(rows, "turn")[0]!;
        expect(isPartial(turn)).toBe(true);
        const allPriced = aggregateUsage([rec({ turnId: "t1", step: 1, cost: cost(0.5) })], "turn")[0]!;
        expect(isPartial(allPriced)).toBe(false);
    });

    it("全部无价目 → 金额列 null（不是 $0），无价目步数 = 步数", () => {
        const turn = aggregateUsage([rec({ turnId: "t1", step: 1, cost: null })], "turn")[0]!;
        expect(field(turn, "cost.total")).toBeNull();
        expect(field(turn, "unpricedSteps")).toBe(1);
        expect(fmtCell(field(turn, "cost.total") as never, "money")).toBe("–");
    });
});

// ─── 6. 粒度归属：TTFT / 速度 / 构成 只属于该属于的粒度 ─────────────────

describe("粒度归属（不可聚合列在高层缺席，不是 0）", () => {
    const rows = [
        rec({ turnId: "t1", step: 1, noCache: 10, text: 100, responseTimeMs: 1000, ttftMs: 400, stepTimeMs: 1200 }),
        rec({ turnId: "t1", step: 2, noCache: 20, text: 300, responseTimeMs: 2000, ttftMs: 900, stepTimeMs: 2200 }),
    ];

    it("ttftMs / rate / stepNo / 构成 只在 step 出现", () => {
        const turn = aggregateUsage(rows, "turn")[0]!;
        for (const key of ["ttftMs", "rate", "stepNo", "contextParts.system", "contextParts.toolsShare", "deliveryCompact"]) {
            expect(key in turn.fields, key).toBe(false);
        }
        const step = aggregateUsage(rows, "step")[0]!;
        expect(field(step, "ttftMs")).toBe(400);
    });

    it("turn 的速度 = Σ输出 ÷ Σ响应耗时（不是两步速度的平均）", () => {
        // 步 1：100/1000 = 0.1 tok/ms；步 2：300/2000 = 0.15；加权 = 400/3000
        const turn = aggregateUsage(rows, "turn")[0]!;
        expect(field(turn, "turnRate")).toBeCloseTo((400 / 3000) * 1000, 6);
        const naiveMean = ((100 / 1000) * 1000 + (300 / 2000) * 1000) / 2;
        expect(field(turn, "turnRate")).not.toBeCloseTo(naiveMean, 3);
    });

    it("session 有 sessionRate、persona 没有速度列", () => {
        const session = aggregateUsage(rows, "session")[0]!;
        expect(field(session, "sessionRate")).toBeCloseTo((400 / 3000) * 1000, 6);
        const persona = aggregateUsage(rows, "persona")[0]!;
        expect("rate" in persona.fields).toBe(false);
        expect("turnRate" in persona.fields).toBe(false);
        expect("sessionRate" in persona.fields).toBe(false);
    });

    it("窗口构成只在 step 且高层不求和（turn 无这些列）", () => {
        const cp = { systemBytes: 4000, toolsBytes: 400 }; // → ~1000 / ~100
        const withParts = [
            rec({ turnId: "t1", step: 1, noCache: 5000, contextParts: cp }),
            rec({ turnId: "t1", step: 2, noCache: 6000, contextParts: cp }),
        ];
        const step = aggregateUsage(withParts, "step")[0]!;
        expect(field(step, "contextParts.system")).toBe(1000);
        expect(field(step, "contextParts.tools")).toBe(100);
        expect(field(step, "contextParts.history")).toBe(5000 - 1000 - 100);
        expect(field(step, "contextParts.systemShare")).toBeCloseTo(1000 / 5000, 10);

        const turn = aggregateUsage(withParts, "turn")[0]!;
        expect("contextParts.system" in turn.fields).toBe(false);
        expect("contextParts.systemShare" in turn.fields).toBe(false);
    });
});

// ─── 7. 集合列（模型 / 面 / 档位 / 单价）：单值退化，多值给数组 ───────────

describe("set 列（身份多值）", () => {
    it("单值 → 标量；多值 → 数组（UI 不必自己判长度）", () => {
        const one = aggregateUsage([rec({ turnId: "t1", step: 1, model: "m-a" })], "turn")[0]!;
        expect(field(one, "model")).toBe("m-a");

        const many = aggregateUsage(
            [
                rec({ turnId: "t1", step: 1, model: "m-a", apiFace: "chat" }),
                rec({ turnId: "t1", step: 2, model: "m-b", apiFace: "responses" }),
            ],
            "turn",
        )[0]!;
        expect(field(many, "model")).toEqual(["m-a", "m-b"]);
        expect(field(many, "apiFace")).toEqual(["chat", "responses"]);
        expect(fmtCell(field(many, "model") as never, "text")).toBe("m-a / m-b");
    });

    it("人物缺失统一为 —（分组键与显示同源）", () => {
        const rows = [rec({ turnId: "t1", step: 1 }), rec({ turnId: "t2", step: 1 })];
        const personas = aggregateUsage(rows, "persona");
        expect(personas.map((r) => r.key)).toEqual(["—"]);
    });
});

// ─── 8. 下钻 = 同一函数换参数（不是第二条代码路径）──────────────────────

describe("过滤与下钻", () => {
    const rows = [
        rec({ turnId: "t1", step: 1, persona: "p1", noCache: 10 }),
        rec({ turnId: "t1", step: 2, persona: "p1", noCache: 20 }),
        rec({ turnId: "t2", step: 1, persona: "p2", noCache: 30 }),
    ];

    it("turn 行 → step + turnId 过滤 = 该轮明细（与全量 step 同列）", () => {
        const drill = aggregateUsage(rows, "step", { field: "turnId", value: "t1" });
        expect(drill).toHaveLength(2);
        expect(drill.map((r) => field(r, "stepNo"))).toEqual([1, 2]);
        expect(aggregateUsage(rows, "step")[0]!.fields).toHaveProperty("noCacheTokens");
        expect(drill[0]!.fields).toHaveProperty("noCacheTokens");
    });

    it("persona 行 → turn + persona 过滤", () => {
        const drill = aggregateUsage(rows, "turn", { field: "persona", value: "p2" });
        expect(drill.map((r) => r.key)).toEqual(["t2"]);
    });

    it("行序：step 按 (turnId, step)、turn 按时间升序", () => {
        const steps = aggregateUsage(rows, "step");
        expect(steps.map((r) => r.key)).toEqual(["t1#1", "t1#2", "t2#1"]);
        const turns = aggregateUsage(rows, "turn");
        expect(turns).toHaveLength(2);
    });
});

// ─── 9. 列定义：一份、可过滤、无重名 ───────────────────────────────────

describe("USAGE_FIELDS（列定义只有一份）", () => {
    it("键唯一（表头/行值靠 key 对齐）", () => {
        const keys = USAGE_FIELDS.map((c) => c.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("四个粒度都能筛出非空列集，且 step 覆盖最全", () => {
        const counts: Record<Gran, number> = {
            step: columnsFor("step").length,
            turn: columnsFor("turn").length,
            persona: columnsFor("persona").length,
            session: columnsFor("session").length,
        };
        for (const g of ["step", "turn", "persona", "session"] as const) expect(counts[g]).toBeGreaterThan(5);
        expect(counts.step).toBeGreaterThan(counts.turn);
    });

    it("聚合结果里的字段集合 == 该粒度声明的列（不多不少）", () => {
        const row = aggregateUsage([rec({ turnId: "t1", step: 1 })], "turn")[0]!;
        expect(Object.keys(row.fields).sort()).toEqual(columnsFor("turn").map((c) => c.key).sort());
    });

    it("未注入的压缩事件列恒 null（不编 0），边界列不属于四级粒度", () => {
        const row = aggregateUsage([rec({ turnId: "t1", step: 1 })], "step")[0]!;
        expect(field(row, "compactEvents")).toBeNull();
        expect(USAGE_FIELDS.find((c) => c.key === "compactRetainTokens")!.gran).toEqual([]);
        expect(USAGE_FIELDS.find((c) => c.key === "compactRetainTokens")!.gran.includes("step")).toBe(false);
    });
});

// ─── 10. 字形（fmtCell 是唯一入口）────────────────────────────────────

describe("fmtCell", () => {
    it("null → –（所有字形一致）", () => {
        for (const f of ["text", "int", "token", "money", "pct", "ms", "rate", "datetime"] as const) {
            expect(fmtCell(null, f), f).toBe("–");
            expect(fmtCell(undefined, f), f).toBe("–");
        }
    });

    it("金额四位（小额六位）/ 百分比一位 / 耗时 ms·s 两档 / 速度 tok/s", () => {
        expect(fmtCell(1.23456, "money")).toBe("$1.2346");
        expect(fmtCell(0.0000123, "money")).toBe("$0.000012");
        expect(fmtCell(0, "money")).toBe("$0");
        expect(fmtCell(0.9123, "pct")).toBe("91.2%");
        expect(fmtCell(812, "ms")).toBe("812ms");
        expect(fmtCell(1840, "ms")).toBe("1.84s");
        expect(fmtCell(61.4, "rate")).toBe("61 tok/s");
    });

    it("token：<10k 千分位，≥10k k，≥1M M", () => {
        expect(fmtCell(1234, "token")).toBe("1,234");
        expect(fmtCell(12_345, "token")).toBe("12.3k");
        expect(fmtCell(1_500_000, "token")).toBe("1.50M");
    });

    it("时间：本地到秒（不解析 turnId）", () => {
        const s = fmtCell("2026-10-04T15:12:58.872Z", "datetime");
        expect(s).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        expect(fmtCell("not-a-date", "datetime")).toBe("–");
    });
});
