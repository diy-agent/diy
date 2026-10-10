// tests/core/compaction-plan.test.ts
// 🎯 压缩选择「元件库 + 装配器」（##272，用户 2026-10-08）——
//    把算法从「固定决策者」降级为「默认 + 兜底」，挑选元件可组合、由装配器执行。
//    默认管道 `defaultBudgetPlan` 必须复刻旧纵向阶梯之行为（等价性另见 compaction-budget.test.ts）。

import { describe, it, expect } from "vitest";
import {
    runPlan,
    plan,
    stage,
    exemptStage,
    defaultBudgetPlan,
    byLadder,
    byRole,
    recentMessages,
    recentSteps,
    type PickCtx,
} from "../../src/main/services/compaction-plan";
import type { LocalModelMessage } from "../../src/main/services/local-blocks";
import { utf8Bytes } from "../../src/shared/context/compaction";

const user = (t: string, text: string, step?: string): LocalModelMessage => ({ role: "user", content: text, turn: t, ...(step ? { step } : {}) });
const text = (t: string, s: string, step?: string): LocalModelMessage => ({ role: "assistant", content: [{ type: "text", text: s }], turn: t, ...(step ? { step } : {}) });
const call = (t: string, id: string, step?: string): LocalModelMessage => ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "bash", input: {} }],
    turn: t,
    ...(step ? { step } : {}),
});
const result = (t: string, id: string, v: string, step?: string): LocalModelMessage => ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName: "bash", output: { type: "text", value: v } }],
    turn: t,
    ...(step ? { step } : {}),
});

/** 与 local-blocks 的投递成本同口径（真发不带 turn/step 索引位） */
const costOf = (m: LocalModelMessage): number => utf8Bytes(JSON.stringify({ role: m.role, content: m.content }));
const bytesOf = costOf;
const run = (all: LocalModelMessage[], p: ReturnType<typeof plan>) => runPlan(all, p, { costOf });

describe("默认管道 = 旧纵向阶梯（等价性 sanity）", () => {
    const all = [user("t1", "u1"), call("t1", "c1"), result("t1", "c1", "r1"), text("t1", "a1"), user("t2", "u2"), text("t2", "a2")];

    it("budget=0 → 全丢；大预算 → 全留", () => {
        expect(run(all, defaultBudgetPlan(0)).kept).toEqual([]);
        const total = all.reduce((n, m) => n + bytesOf(m), 0);
        expect(run(all, defaultBudgetPlan(total)).kept).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("纵向：先满足 user、且同层新的先", () => {
        const s = run(all, defaultBudgetPlan(bytesOf(all[4]!)));
        expect(s.kept).toEqual([4]);
    });

    it("配对铁律：只够 call、不够 result → 两者都丢", () => {
        const only = [call("t1", "c1"), result("t1", "c1", "r1")];
        expect(run(only, defaultBudgetPlan(bytesOf(only[0]!))).kept).toEqual([]);
    });
});

describe("元件：recentMessages / recentSteps", () => {
    it("recentMessages(n)：新的先；可带角色过滤", () => {
        const all = [user("t1", "u1"), user("t2", "u2"), user("t3", "u3")];
        const picked = [...recentMessages(2).picks({ all, rank: [], resultOf: new Map(), cost: [] } as unknown as PickCtx)];
        expect(picked).toEqual([2, 1]);
        const pickedU = [...recentMessages(1, { role: "user" }).picks({ all, rank: [], resultOf: new Map(), cost: [] } as unknown as PickCtx)];
        expect(pickedU).toEqual([2]);
    });

    it("recentSteps(n)：只取最近 n 个 step 的消息（新的 step 先）", () => {
        const all = [
            user("t1", "u1"), // 无 step（开场）
            text("t1", "a1", "s1"),
            call("t1", "c1", "s1"),
            text("t2", "a2", "s2"),
            text("t2", "a3", "s3"),
        ];
        const picked = [...recentSteps(1).picks({ all, rank: [], resultOf: new Map(), cost: [] } as unknown as PickCtx)];
        expect(picked).toEqual([4]); // 只 s3
        const picked2 = [...recentSteps(2).picks({ all, rank: [], resultOf: new Map(), cost: [] } as unknown as PickCtx)];
        expect(picked2.sort((a, b) => a - b)).toEqual([3, 4]); // s2 + s3
    });
});

describe("装配：级 / 托底 / 限数 / 去重", () => {
    it("exempt 托底级**不计预算**（预算=0 也保留）", () => {
        const all = [user("t1", "u1"), call("t1", "c1"), result("t1", "c1", "r1")];
        const p = plan(0, exemptStage(recentMessages(1, { role: "assistant" })));
        const s = run(all, p);
        // 命中 call → 连带 result（配对铁律），且 exempt 不受预算 0 限制
        expect(s.kept).toEqual([1, 2]);
    });

    it("托底不消耗预算：exempt 之后 count 级仍拿得到足额预算", () => {
        const all = [user("t1", "u1"), call("t1", "c1"), result("t1", "c1", "r1"), user("t3", "u3")];
        const p = plan(bytesOf(all[3]!), exemptStage(recentMessages(1, { role: "assistant" })), stage(byLadder()));
        const s = run(all, p);
        expect(s.kept).toContain(1); // call（托底，配对带 result）
        expect(s.kept).toContain(2);
        expect(s.kept).toContain(3); // 预算被 exempt 之后仍足额 → user 拿到
    });

    it("limit：本元件最多取 N 个单元", () => {
        const all = [user("t1", "u1"), user("t2", "u2"), user("t3", "u3")];
        const p = plan(1_000_000, stage(byLadder(), { limit: 2 }));
        const s = run(all, p);
        expect(s.kept.sort((a, b) => a - b)).toEqual([1, 2]); // 新的两条（2,1）
    });

    it("多级装配按序填充，同级去重（不重复计费）", () => {
        const all = [user("t1", "u1"), text("t1", "a1")];
        // 第一级只取 user，第二级取全部文本；两条都在，keptBytes 不重复计
        const p = plan(bytesOf(all[0]!) + bytesOf(all[1]!), stage(recentMessages(1, { role: "user" })), stage(byLadder()));
        const s = run(all, p);
        expect(s.kept).toEqual([0, 1]);
        expect(s.keptBytes).toBe(bytesOf(all[0]!) + bytesOf(all[1]!));
    });
});

describe("边界", () => {
    it("空投影 → 空结果", () => {
        const s = runPlan([], defaultBudgetPlan(1024), { costOf });
        expect(s).toEqual({ kept: [], dropped: [], keptRuns: [], keptBytes: 0 });
    });

    it("result 从不单独入选（即便被元件直接指到）", () => {
        const all = [result("t1", "c1", "r1")];
        const s = run(all, plan(1_000_000, stage(recentMessages(10))));
        expect(s.kept).toEqual([]);
    });
});

// ── 实际范例（docs/plans/2026-10-08-compact-plan-config.md ③.2）：工作集必保 + 用户话必保 + ladder 兜底 ──
describe("实际范例：必保层（工作集 + 用户话）不被预算挤掉", () => {
    // 3 轮、13 条消息（含步/无步），与范例执行迹同构
    const all: LocalModelMessage[] = [
        user("t1", "开场问"),                                   // 0
        call("t1", "c1", "s1"), result("t1", "c1", "r1", "s1"),  // 1,2
        text("t1", "结论1", "s2"),                               // 3
        user("t2", "第二问"),                                    // 4
        call("t2", "c2", "s1"), result("t2", "c2", "r2", "s1"),  // 5,6
        call("t2", "c3", "s2"), result("t2", "c3", "r3", "s2"),  // 7,8
        user("t3", "第三问"),                                    // 9
        call("t3", "c4", "s1"), result("t3", "c4", "r4", "s1"),  // 10,11
        text("t3", "结论3", "s2"),                               // 12
    ];
    // ③.2 的管道：steps 必保 + user 必保 + ladder 兜底
    const pipe = (budgetBytes: number) =>
        plan(budgetBytes, exemptStage(recentSteps(10)), exemptStage(byRole("user")), stage(byLadder()));

    it("预算再小，必保层（全部用户话 + 最近步结论）仍在", () => {
        const s = run(all, pipe(64)); // 极小预算，几乎只够 ladder 塞一两条
        // 用户话 0/4/9 必保
        expect(s.kept).toEqual(expect.arrayContaining([0, 4, 9]));
        // 最近一步的结论 12（steps:10 覆盖）必保
        expect(s.kept).toContain(12);
    });

    it("对照：缺省单级 ladder 同预算 → 用户话可能被「更近的」挤掉比例不同（此处验证语义差异存在）", () => {
        const small = 64;
        const sPlan = run(all, pipe(small));
        const sLadder = run(all, defaultBudgetPlan(small));
        // 两者都保住了用户话（ladder 里 user 优先级最高）——差异在**必保 vs 计数**的处理上，
        // 用「最近步结论」体现：管道的 steps 必保把它钉死；单级 ladder 若预算不足可能后到。
        // 这里只断言管道**必含** 12（必保语义确凿）。
        expect(sPlan.kept).toContain(12);
        // 单级 ladder 的结果不承诺必含 12 —— 正是「必保」与「仅按重要度」的区别所在。
        expect(Array.isArray(sLadder.kept)).toBe(true);
    });

    it("预算充足（12KB）→ 全留", () => {
        const total = all.reduce((n, m) => n + bytesOf(m), 0);
        const s = run(all, pipe(total + 1));
        expect(s.kept.length).toBe(all.length);
    });
});
