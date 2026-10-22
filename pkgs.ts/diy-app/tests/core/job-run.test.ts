// tests/core/job-run.test.ts
// 🎯 ##408 刀 2 —— 后台 job 运行记录的**判据**（`shared/job-run.ts`）
//
// 钉住的四条（缺一条就等于没判据）：
//   ① **状态机**：只有 `running → {settled,failed,lost}` 合法；终态不得再转（账是 append-only）；
//   ② **四态的可判性**：`lost` = 结局不可知（重启后发现进程没了），不是「失败」；
//   ③ **origin 必填**（硬约束 1）：缺失 / 形状不对一律 `agent/missing-origin` —— 断言 code，不梳文案；
//   ④ **origin 是引用不是快照**（硬约束 2）：多塞私有字段（`.strict()`）当场失败，防止悄悄拷上下文。

import { describe, it, expect } from "vitest";
import {
    JOB_KINDS,
    JOB_ORIGIN_TYPES,
    JOB_RUN_STATES,
    RUN_TRANSITIONS,
    assertOrigin,
    assertRunTransition,
    canTransitionRun,
    isTerminalRunState,
    normalizeRun,
    runDurationMs,
    settleRun,
    type JobOrigin,
    type JobRun,
} from "../../src/shared/job-run";
import { InvariantError } from "../../src/shared/error-triage";

const spawnedOrigin: JobOrigin = {
    type: "spawned",
    data: {
        taskUri: "projects/4/tasks/408",
        turnId: "t123",
        stepId: "s2",
        toolCallId: "call_abc",
        cmd: "./sha.sh test-unit",
    },
};

function run(over: Partial<JobRun> = {}): JobRun {
    return {
        id: "r1",
        jobId: "bash.background",
        kind: "spawned",
        title: "后台命令",
        owner: { type: "turn", taskUri: "projects/4/tasks/408", turnId: "t123" },
        state: "running",
        startedAt: "2026-10-22T08:00:00.000Z",
        origin: spawnedOrigin,
        ...over,
    } as JobRun;
}

/** 取抛出的 InvariantError（断言 code，不断言文案） */
function catchInvariant(fn: () => unknown): InvariantError {
    try {
        fn();
    } catch (e) {
        if (e instanceof InvariantError) return e;
        throw e;
    }
    throw new Error("期望抛 InvariantError，实际没抛");
}

describe("状态机 —— 只许从 running 出发", () => {
    it("枚举口径：四态 = running / settled / failed / lost", () => {
        expect([...JOB_RUN_STATES]).toEqual(["running", "settled", "failed", "lost"]);
    });

    it("合法转移：running → settled / failed / lost", () => {
        for (const to of ["settled", "failed", "lost"] as const) {
            expect(canTransitionRun("running", to)).toBe(true);
            expect(() => assertRunTransition("running", to)).not.toThrow();
        }
        expect([...RUN_TRANSITIONS.running]).toEqual(["settled", "failed", "lost"]);
    });

    it("非法转移：终态不得再转（含 running → running：心跳不许刷账）", () => {
        for (const from of ["settled", "failed", "lost"] as const) {
            for (const to of JOB_RUN_STATES) {
                expect(canTransitionRun(from, to)).toBe(false);
            }
            expect(isTerminalRunState(from)).toBe(true);
            expect(catchInvariant(() => assertRunTransition(from, "running")).code).toBe("agent/invalid-run-transition");
        }
        expect(canTransitionRun("running", "running")).toBe(false);
        expect(isTerminalRunState("running")).toBe(false);
    });
});

describe("origin —— 四种来源各有一条，缺了就报 job/missing-origin", () => {
    const cases: readonly JobOrigin[] = [
        spawnedOrigin,
        { type: "trigger", data: { jobId: "models.refresh", firedAt: "2026-10-22T08:00:00.000Z", reason: "interval" } },
        { type: "manual", data: { by: "human:chen56", cwd: "/Users/ccc/git/diy/diy" } },
        { type: "agent", data: { memberUri: "agent:main", turnId: "t9" } },
    ];

    it("枚举与用例覆盖同一批 type（新增类型必须补用例）", () => {
        expect([...JOB_ORIGIN_TYPES]).toEqual(cases.map((c) => c.type));
    });

    it("四种 origin 都能通过 assertOrigin 且原样返回", () => {
        for (const o of cases) expect(assertOrigin(o)).toEqual(o);
    });

    it("origin 缺失 ⇒ code = agent/missing-origin", () => {
        expect(catchInvariant(() => assertOrigin(undefined)).code).toBe("agent/missing-origin");
        expect(catchInvariant(() => normalizeRun(run({ origin: undefined as unknown as JobOrigin }))).code).toBe(
            "agent/missing-origin",
        );
    });

    it("origin 非法（未知 type / 空字段 / 多塞私有字段）⇒ 同一个 code", () => {
        for (const bad of [
            { type: "unknown", data: {} },
            { type: "manual", data: { by: "", cwd: "/tmp" } },
            // 硬约束 2：不许塞上下文快照（.strict() 拦下）
            { type: "manual", data: { by: "human:x", cwd: "/tmp", snapshot: { messages: [] } } },
            { type: "spawned", data: { ...spawnedOrigin.data, transcript: "..." } },
        ]) {
            expect(catchInvariant(() => assertOrigin(bad)).code).toBe("agent/missing-origin");
        }
    });
});

describe("normalizeRun —— 账本自证的判据", () => {
    it("running 不带 endedAt 合法；带 endedAt 非法", () => {
        expect(normalizeRun(run()).state).toBe("running");
        expect(catchInvariant(() => normalizeRun(run({ endedAt: "2026-10-22T08:00:10.000Z" }))).code).toBe(
            "agent/invalid-job-run",
        );
    });

    it("终态必须带 endedAt（否则耗时算不出、时间线排不了）", () => {
        for (const state of ["settled", "failed", "lost"] as const) {
            expect(catchInvariant(() => normalizeRun(run({ state }))).code).toBe("agent/invalid-job-run");
        }
    });

    it("字段缺失 / 陌生字段被拦（kind 必须在枚举内）", () => {
        expect(catchInvariant(() => normalizeRun({ ...run(), kind: "cron" })).code).toBe("agent/invalid-job-run");
        expect(catchInvariant(() => normalizeRun({ ...run(), extra: 1 })).code).toBe("agent/invalid-job-run");
    });

    it("kind 枚举 = spawned / scheduled / event（v1 只有 spawned 有真数据）", () => {
        expect([...JOB_KINDS]).toEqual(["spawned", "scheduled", "event"]);
    });
});

describe("settleRun —— 收口时该填的一次填齐", () => {
    it("running → settled：补 endedAt / ms / exitCode，且不改原对象", () => {
        const base = run();
        const done = settleRun(base, { state: "settled", endedAt: "2026-10-22T08:00:02.500Z", exitCode: 0, summary: "ok" });
        expect(base.state).toBe("running");
        expect(base.endedAt).toBeUndefined();
        expect(done.state).toBe("settled");
        expect(done.ms).toBe(2500);
        expect(done.exitCode).toBe(0);
        expect(done.origin).toEqual(spawnedOrigin);
    });

    it("被信号杀掉 ⇒ failed + signal（不拿 -1 冒充退出码）", () => {
        const done = settleRun(run(), { state: "failed", endedAt: "2026-10-22T08:00:01.000Z", signal: "SIGKILL", error: "killed" });
        expect(done.state).toBe("failed");
        expect(done.signal).toBe("SIGKILL");
        expect(done.exitCode).toBeUndefined();
    });

    it("已终态不得再 settle（append-only，重写账 = 丢历史）", () => {
        const done = settleRun(run(), { state: "settled", endedAt: "2026-10-22T08:00:01.000Z" });
        expect(catchInvariant(() => settleRun(done, { state: "failed", endedAt: "2026-10-22T08:00:02.000Z" })).code).toBe(
            "agent/invalid-run-transition",
        );
    });
});

describe("runDurationMs —— 同一把尺子", () => {
    it("正常区间给差值；缺失 / 时间倒流 / 解不开给 undefined", () => {
        expect(runDurationMs("2026-10-22T08:00:00.000Z", "2026-10-22T08:00:01.500Z")).toBe(1500);
        expect(runDurationMs("2026-10-22T08:00:00.000Z")).toBeUndefined();
        expect(runDurationMs("2026-10-22T08:00:02.000Z", "2026-10-22T08:00:01.000Z")).toBeUndefined();
        expect(runDurationMs("not-a-date", "2026-10-22T08:00:01.000Z")).toBeUndefined();
    });
});
