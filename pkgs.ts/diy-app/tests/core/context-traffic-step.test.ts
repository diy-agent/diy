// tests/core/context-traffic-step.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 变更历史的**一步** → 流量日志里的**那条真实请求**（##310「该步实际请求」）。
//
// 口径（宁可给不出，也不给错的）：
//   · 只认 turnId 完全相等（taskUri 也相等）；
//   · 判据是**时刻**（记录写在 prepareStep、即该步请求之前 → 取 ts ≥ 记录 ts 的第一条），
//     因为 `attempt` 是"本次运行内的请求序号"（重试也 +1），**不等于第几步**；
//   · 给不出时刻时才退化为"按 ts 升序取第 step 条"；条数不够 → null（UI 出声）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { dateOfLogFile, groupByStep, pickStepTraffic, type TrafficStepRecord } from "../../src/shared/context/traffic-step";
import { changeForNode, nodeHitByChange } from "../../src/shared/context/changelog";

const rec = (over: Partial<TrafficStepRecord> & { ts: number }): TrafficStepRecord => ({
    turnId: "t1",
    taskUri: "projects/1/tasks/1",
    attempt: 1,
    status: 200,
    model: "mimo-v2.6-flash",
    log: { file: "log/network/2026-10-15.jsonl", line: 1, abs: "/abs/2026-10-15.jsonl" },
    ...over,
});

describe("pickStepTraffic：一步 → 那条请求", () => {
    it("★ 时刻判据：取该轮里 ts ≥ 记录 ts 的第一条（记录写在该步请求之前）", () => {
        // 第 1 步请求 ts=1000、第 2 步请求 ts=2000；第 2 步的记录写在 1900
        const records = [rec({ ts: 1000, attempt: 1 }), rec({ ts: 2000, attempt: 2 })];
        const iso = (ms: number) => new Date(ms).toISOString();
        expect(pickStepTraffic(records, { turnId: "t1", step: 2 }, "projects/1/tasks/1", iso(1900))?.record.ts).toBe(2000);
        expect(pickStepTraffic(records, { turnId: "t1", step: 1 }, "projects/1/tasks/1", iso(900))?.record.ts).toBe(1000);
        expect(pickStepTraffic(records, { turnId: "t1", step: 1 }, "projects/1/tasks/1", iso(900))?.turnRecords).toBe(2);
    });

    it("★ 重试自动吸收：第 1 步重发过（attempt 顶到 2），第 2 步的记录仍取到第 2 步那条", () => {
        const records = [
            rec({ ts: 1000, attempt: 1 }),
            rec({ ts: 1100, attempt: 2 }), // 第 1 步的重试
            rec({ ts: 2000, attempt: 3 }), // 第 2 步（序号被顶到 3）
        ];
        const iso = (ms: number) => new Date(ms).toISOString();
        const p = pickStepTraffic(records, { turnId: "t1", step: 2 }, "projects/1/tasks/1", iso(1900));
        expect(p?.record.ts).toBe(2000); // 不是按 step-1=1 取到的 1100（那只是重发）
        expect(p?.turnRecords).toBe(3);
    });

    it("给不出时刻 → 退化为按 ts 升序取第 step 条", () => {
        const records = [rec({ ts: 100 }), rec({ ts: 200 }), rec({ ts: 300 })];
        expect(pickStepTraffic(records, { turnId: "t1", step: 2 }, "projects/1/tasks/1")?.record.ts).toBe(200);
        expect(pickStepTraffic(records, { turnId: "t1", step: 3 }, "projects/1/tasks/1")?.turnRecords).toBe(3);
    });

    it("条数不够 / turnId 对不上 / taskUri 对不上 / 无记录 → null（不编）", () => {
        const records = [rec({ ts: 100 })];
        expect(pickStepTraffic(records, { turnId: "t1", step: 2 }, "projects/1/tasks/1")).toBeNull();
        expect(pickStepTraffic(records, { turnId: "tX", step: 1 }, "projects/1/tasks/1")).toBeNull();
        expect(pickStepTraffic(records, { turnId: "t1", step: 1 }, "projects/2/tasks/9")).toBeNull();
        expect(pickStepTraffic([], { turnId: "t1", step: 1 }, null)).toBeNull();
    });

    it("记录时刻晚于该轮全部请求（不该发生）→ 退化为最后一条，不返回 null", () => {
        const records = [rec({ ts: 100 }), rec({ ts: 200 })];
        const p = pickStepTraffic(records, { turnId: "t1", step: 2 }, null, new Date(9999).toISOString());
        expect(p?.record.ts).toBe(200);
    });

    it("taskUri 传 null = 不按任务过滤（CLI/跨任务视角）", () => {
        const records = [rec({ ts: 100, taskUri: "projects/9/tasks/9" })];
        expect(pickStepTraffic(records, { turnId: "t1", step: 1 }, null)?.record.ts).toBe(100);
    });
});

describe("步号判据（##409）：有 stepSeq 时优先按步取，比时刻更硬", () => {
    it("★ 重试把时刻判据顶歪时，步号仍取对那一步的首试", () => {
        const records = [
            rec({ ts: 1000, attempt: 3, stepSeq: 2, attemptInStep: 1, status: 500 }),
            rec({ ts: 1100, attempt: 4, stepSeq: 2, attemptInStep: 2, status: 200 }),
        ];
        // 记录时刻落在两次往返之间：按时刻会取到重试那条（1100），按步号仍取该步首试（1000）
        const p = pickStepTraffic(records, { turnId: "t1", step: 2 }, null, new Date(1050).toISOString());
        expect(p?.record.attemptInStep).toBe(1);
        expect(p?.record.ts).toBe(1000);
        expect(p?.turnRecords).toBe(2);
    });

    it("老记录（无步号）自动退回时刻判据 / 按序判据", () => {
        const records = [rec({ ts: 100 }), rec({ ts: 200 })];
        expect(pickStepTraffic(records, { turnId: "t1", step: 2 }, null)?.record.ts).toBe(200);
        expect(
            pickStepTraffic(records, { turnId: "t1", step: 1 }, null, new Date(150).toISOString())?.record.ts,
        ).toBe(200);
    });
});

describe("groupByStep：一步 = 一条重试链（试了几次 / 各自成败 / 最后一次成没成）", () => {
    it("★ 一步含 1 次重试：retries=1、attempts 按序、lastOk 取最后一次", () => {
        const records = [
            rec({ ts: 1000, attempt: 1, stepSeq: 1, attemptInStep: 1, status: null }),
            rec({ ts: 1500, attempt: 2, stepSeq: 1, attemptInStep: 2, status: 200 }),
            rec({ ts: 2000, attempt: 3, stepSeq: 2, attemptInStep: 1, status: 200 }),
        ];
        const chains = groupByStep(records);
        expect(chains.map((c) => c.stepSeq)).toEqual([1, 2]);
        expect(chains[0]!.attempts.map((a) => a.attemptInStep)).toEqual([1, 2]);
        expect(chains[0]!.retries).toBe(1);
        expect(chains[0]!.lastOk).toBe(true); // 最后一次成功
        expect(chains[1]!.retries).toBe(0);
        expect(chains[1]!.lastOk).toBe(true);
    });

    it("重试全失败：retries 照数、lastOk=false（「最后一次也没成」读得出）", () => {
        const records = [
            rec({ ts: 1000, stepSeq: 1, attemptInStep: 1, status: 503 }),
            rec({ ts: 2000, stepSeq: 1, attemptInStep: 2, status: 503 }),
            rec({ ts: 3000, stepSeq: 1, attemptInStep: 3, status: null }),
        ];
        const [chain] = groupByStep(records);
        expect(chain!.retries).toBe(2);
        expect(chain!.lastOk).toBe(false);
    });

    it("没有步号的记录（探测 / 摘要 / 老记录）不成步，直接跳过", () => {
        const records = [
            rec({ ts: 100, stepSeq: null, attemptInStep: null }),
            rec({ ts: 200 }),
            rec({ ts: 300, stepSeq: 1, attemptInStep: 1 }),
        ];
        expect(groupByStep(records).map((c) => c.stepSeq)).toEqual([1]);
    });
});

describe("dateOfLogFile：日志文件 → 日期", () => {
    it("认出 log/network/<date>.jsonl；认不出给 null", () => {
        expect(dateOfLogFile("log/network/2026-10-15.jsonl")).toBe("2026-10-15");
        expect(dateOfLogFile("a/b/c/2026-01-02.jsonl")).toBe("2026-01-02");
        expect(dateOfLogFile("log/network/x.jsonl")).toBeNull();
        expect(dateOfLogFile(null)).toBeNull();
    });
});

describe("变量树节点 × 变更命中", () => {
    const changes = [
        { kind: "update" as const, path: "chain", before: "a", after: "b" },
        { kind: "update" as const, path: "task.body", before: "x", after: "y" },
    ];

    it("同路径命中；变更单元**之下**的节点也算它变的（chain 变 → chain.0.path 变）", () => {
        expect(nodeHitByChange("chain", "chain")).toBe(true);
        expect(nodeHitByChange("chain.0.path", "chain")).toBe(true);
        expect(nodeHitByChange("task.body", "chain")).toBe(false);
        // 反向不成立：不会因为叶子变了就说整棵 chain 变了（原子单元的语义）
        expect(nodeHitByChange("chain", "chain.0")).toBe(false);
    });

    it("命中取**最具体**的那条（同路径优先，其次最近祖先）", () => {
        expect(changeForNode("task.body", changes)?.path).toBe("task.body");
        expect(changeForNode("chain.0.path", changes)?.path).toBe("chain");
        expect(changeForNode("diy.cli", changes)).toBeNull();
    });
});
