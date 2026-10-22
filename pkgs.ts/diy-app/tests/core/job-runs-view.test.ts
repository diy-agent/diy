// tests/core/job-runs-view.test.ts
// 🎯 ##408 刀 6 —— 作业面板的**展示判据**（纯函数；不碰 DOM、不碰 RPC）
//
// 三组判据各自对应一条用户/派活要求：
//   ① 归属      —— 面板只显示**本任务**的作业（origin 优先、owner 兜底）；
//   ② 可导航    —— 「指不回去的 job 不显示成可点」：非 spawned / 锚点残缺 ⇒ 纯文本；
//   ③ 灯与一行  —— state 与 outcome 合成人话（取消 / 超时不画成红色失败）。

import { describe, it, expect } from "vitest";
import {
    lastLineOf,
    liveOfTask,
    navTargetOf,
    originBadgeOf,
    rowsOfTask,
    runsOfTask,
    stateBadgeOf,
    taskUriOfRun,
    whenTextOf,
    type LiveRunRef,
} from "../../src/shared/job-runs-view";
import type { JobOrigin, JobRun } from "../../src/shared/job-run";

const TASK = "projects/4/tasks/408";
const OTHER = "projects/4/tasks/999";

function spawned(taskUri = TASK, over: Partial<Extract<JobOrigin, { type: "spawned" }>["data"]> = {}): JobOrigin {
    return {
        type: "spawned",
        data: {
            taskUri,
            turnId: "t1791126774555",
            stepId: "s3",
            toolCallId: "call_abc",
            cmd: "npm run build",
            ...over,
        },
    };
}

function run(over: Partial<JobRun> = {}): JobRun {
    return {
        id: "r1",
        jobId: "spawn-npm-run-build-1a2b3c4d",
        kind: "spawned",
        title: "npm run build",
        owner: { type: "turn", taskUri: TASK, turnId: "t1791126774555" },
        state: "settled",
        startedAt: "2026-10-22T10:00:00.000Z",
        endedAt: "2026-10-22T10:00:12.000Z",
        ms: 12_000,
        exitCode: 0,
        origin: spawned(),
        summary: "完成 12.0s · 退出码 0",
        ...over,
    };
}

function live(over: Partial<LiveRunRef> = {}): LiveRunRef {
    return {
        runId: "r9",
        jobId: "spawn-npm-run-build-1a2b3c4d",
        title: "npm run build",
        taskUri: TASK,
        origin: spawned(),
        startedAt: "2026-10-22T10:10:00.000Z",
        runMs: 4_000,
        promoted: false,
        pid: 4321,
        output: { capBytes: 262_144, bytes: 10, totalBytes: 10, droppedBytes: 0 },
        ...over,
    };
}

describe("归属：这一条算哪个任务的", () => {
    it("spawned ⇒ 取 origin 里的 taskUri（这次是谁在哪按的开始）", () => {
        expect(taskUriOfRun(run())).toBe(TASK);
    });

    it("manual / trigger 没有 taskUri ⇒ 回落 owner（会话内定时器 owner 是 turn）", () => {
        const manual = run({
            origin: { type: "manual", data: { by: "human:chen56", cwd: "/tmp" } },
        });
        expect(taskUriOfRun(manual)).toBe(TASK);
    });

    it("owner 是 global 且 origin 不是 spawned ⇒ null（与任务无关，不进任何任务面板）", () => {
        const global = run({
            owner: { type: "global", by: "models.refresh" },
            origin: { type: "trigger", data: { jobId: "models.refresh", firedAt: "2026-10-22T10:00:00.000Z", reason: "interval" } },
        });
        expect(taskUriOfRun(global)).toBeNull();
    });

    it("活体没有 owner 字段 ⇒ 只看 origin（缺信息就是查不到，不猜）", () => {
        expect(taskUriOfRun(live())).toBe(TASK);
        expect(taskUriOfRun(live({ origin: { type: "manual", data: { by: "x", cwd: "/" } } }))).toBeNull();
    });

    it("runsOfTask / liveOfTask 只挑本任务的", () => {
        const mine = run();
        const theirs = run({ id: "r2", origin: spawned(OTHER) });
        expect(runsOfTask([mine, theirs], TASK).map((r) => r.id)).toEqual(["r1"]);
        expect(liveOfTask([live(), live({ runId: "r8", origin: spawned(OTHER) })], TASK).map((v) => v.runId)).toEqual([
            "r9",
        ]);
    });
});

describe("导航：指不回去的不许装成可点", () => {
    it("spawned 且锚点齐全 ⇒ 目标 = 任务 + 轮 + 块（块 id 用 toolCallId）", () => {
        expect(navTargetOf(spawned())).toEqual({ taskUri: TASK, turnId: "t1791126774555", blockId: "call_abc" });
    });

    it("trigger / manual / agent 一律 null（v1 没有定时器页；agent 只有轮到不了那一步）", () => {
        expect(navTargetOf({ type: "trigger", data: { jobId: "j", firedAt: "x", reason: "interval" } })).toBeNull();
        expect(navTargetOf({ type: "manual", data: { by: "human:x", cwd: "/" } })).toBeNull();
        expect(navTargetOf({ type: "agent", data: { memberUri: "agent:a", turnId: "t1" } })).toBeNull();
        expect(navTargetOf(null)).toBeNull();
        expect(navTargetOf(undefined)).toBeNull();
    });

    it("锚点残缺（空 toolCallId / 非任务 URI）⇒ null（账是外部数据，不许因此崩）", () => {
        expect(navTargetOf(spawned(TASK, { toolCallId: "" }))).toBeNull();
        expect(navTargetOf(spawned(TASK, { turnId: "" }))).toBeNull();
        expect(navTargetOf(spawned("not-a-uri"))).toBeNull();
    });

    it("徽标与导航判据同源：图标三类各异，navigable 与 navTargetOf 一致", () => {
        expect(originBadgeOf(spawned())).toMatchObject({ icon: "▶", short: "会话", navigable: true });
        expect(originBadgeOf({ type: "manual", data: { by: "human:x", cwd: "/" } })).toMatchObject({
            icon: "✋",
            navigable: false,
        });
        expect(originBadgeOf(spawned(TASK, { toolCallId: "" })).navigable).toBe(false);
    });

    it("spawned 的 hint 里写出完整地址（「点了会去哪」在点之前就说得清）", () => {
        const hint = originBadgeOf(spawned()).hint;
        expect(hint).toContain(TASK);
        expect(hint).toContain("call_abc");
    });
});

describe("状态灯：state + outcome 合成一句人话", () => {
    it("running ⇒ 运行中（running 灯）", () => {
        expect(stateBadgeOf({ state: "running" })).toMatchObject({ tone: "running", text: "运行中" });
    });

    it("settled ⇒ 完成（ok 灯，hint 带退出码）", () => {
        expect(stateBadgeOf({ state: "settled", exitCode: 0 })).toMatchObject({ tone: "ok", text: "完成" });
        expect(stateBadgeOf({ state: "settled", exitCode: 0 }).hint).toContain("退出码 0");
    });

    it("failed + canceled / timeout ⇒ warn（不是缺陷，不许画成红的）", () => {
        expect(stateBadgeOf({ state: "failed", outcome: "canceled" })).toMatchObject({ tone: "warn", text: "已取消" });
        expect(stateBadgeOf({ state: "failed", outcome: "timeout" })).toMatchObject({ tone: "warn", text: "超时" });
    });

    it("failed 且没有取消/超时 ⇒ error，hint 优先说信号（信号才是退出码为空的解释）", () => {
        expect(stateBadgeOf({ state: "failed", outcome: "fail", exitCode: 2 })).toMatchObject({
            tone: "error",
            text: "失败",
        });
        expect(stateBadgeOf({ state: "failed", signal: "SIGKILL" }).hint).toContain("SIGKILL");
    });

    it("lost ⇒ 已失联（灰灯：结局不可知，不假装在跑）", () => {
        expect(stateBadgeOf({ state: "lost" })).toMatchObject({ tone: "lost", text: "已失联" });
    });
});

describe("一行摘要", () => {
    it("lastLineOf 取最后一行非空（首行是永远一样的欢迎语，没有信息）", () => {
        expect(lastLineOf("npm i\nadded 12 packages\n")).toBe("added 12 packages");
        expect(lastLineOf("")).toBe("");
        expect(lastLineOf(null)).toBe("");
    });

    it("lastLineOf 超长截断但保留可读前缀", () => {
        const line = "x".repeat(200);
        expect(lastLineOf(line, 20)).toHaveLength(20);
        expect(lastLineOf(line, 20).endsWith("…")).toBe(true);
    });

    it("whenTextOf：有 ms 用耗时；running（没有 ms）写「始于 …」，**不许拿现在减**", () => {
        expect(whenTextOf({ startedAt: "2026-10-22T10:00:00.000Z" })).toMatch(/^始于 /);
        expect(whenTextOf({ startedAt: "2026-10-22T10:00:00.000Z", ms: 1_500 })).toBe("1.5s");
    });
});

describe("面板行：账本 + 活体合并成一次 run 一行", () => {
    it("同一 runId 的 running 行 + 终态行 ⇒ 只留一行，取**最后**一行（append-only 的语义）", () => {
        const running = run({ state: "running", endedAt: undefined, ms: undefined });
        const done = run({ state: "settled" });
        const rows = rowsOfTask([running, done], [], TASK);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.state).toBe("settled");
        expect(rows[0]!.summary).toContain("完成");
    });

    it("活体还在 ⇒ 行状态判 running（账上的 running 行可能是从未收口的残留）", () => {
        const rows = rowsOfTask([run({ state: "running", endedAt: undefined, ms: undefined })], [live({ runId: "r1" })], TASK);
        expect(rows[0]!.state).toBe("running");
        expect(rows[0]!.live?.runId).toBe("r1");
        expect(rows[0]!.promoted).toBe(true);
    });

    it("只在活体里的（还没落账）⇒ 也进列表，标 promoted:false（否则在跑的看不到）", () => {
        const rows = rowsOfTask([], [live()], TASK);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.promoted).toBe(false);
        expect(rows[0]!.state).toBe("running");
    });

    it("别的任务的 run / 活体不进本任务列表", () => {
        const rows = rowsOfTask([run()], [live({ origin: spawned(OTHER) })], TASK);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.live).toBeNull();
    });

    it("最近的在前（面板是「现在在跑什么 / 刚跑完什么」）", () => {
        const old = run({ id: "a", startedAt: "2026-10-22T09:00:00.000Z" });
        const recent = run({ id: "b", startedAt: "2026-10-22T11:00:00.000Z" });
        expect(rowsOfTask([old, recent], [], TASK).map((r) => r.runId)).toEqual(["b", "a"]);
    });
});
