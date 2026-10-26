import { describe, expect, it } from "vitest";
import {
    DEFAULT_QUIET_AFTER,
    EMPTY_WATCH_STATE,
    WATCH_ERROR_STREAK_LIMIT,
    WATCH_MAX_EVERY_MIN,
    diffParts,
    fingerprintOf,
    intervalMinOf,
    isBroken,
    isDue,
    nextDueAt,
    probeFailed,
    probeSucceeded,
    endWatch,
    parseSubjectSpec,
    sinkAddressError,
    subjectError,
    subjectIsPersistent,
    subjectLabel,
    taskOfSink,
    validateWatchDef,
    watchIdError,
} from "../../src/shared/job-watch";
import type { JobWatchDef, JobWatchState, ProbePart } from "../../src/shared/job-watch";

// ##408 v2：JobWatch 判据（纯函数）。判据写进用例名。

function def(over: Partial<JobWatchDef> = {}): JobWatchDef {
    return {
        id: "daily-pr",
        title: "看 PR 有没有人回",
        every: 30,
        probes: ["glob:gen/**"],
        quietAfter: DEFAULT_QUIET_AFTER,
        sinks: ["task:projects/4/tasks/408"],
        subject: { kind: "none" },
        createdAt: "2026-10-26T00:00:00.000Z",
        enabled: true,
        ...over,
    };
}

function state(over: Partial<JobWatchState> = {}): JobWatchState {
    return { ...EMPTY_WATCH_STATE, ...over };
}

const parts = (...pairs: [string, string][]): ProbePart[] => pairs.map(([key, value]) => ({ key, value }));

describe("多久看一眼（降频阶梯）", () => {
    it("没攒够无变化次数 ⇒ 原频率", () => {
        expect(intervalMinOf(def(), state({ quietStreak: 0 }))).toBe(30);
        expect(intervalMinOf(def(), state({ quietStreak: 3 }))).toBe(30);
    });

    it("连续 quietAfter 次无变化 ⇒ 间隔 ×4；再攒一轮 ⇒ ×16", () => {
        expect(intervalMinOf(def(), state({ quietStreak: 4 }))).toBe(120);
        // 30 × 16 = 480 已越顶 ⇒ 封顶 360
        expect(intervalMinOf(def(), state({ quietStreak: 8 }))).toBe(WATCH_MAX_EVERY_MIN);
    });

    it("封顶 360 分钟：再怎么降频，一天至少看一眼", () => {
        expect(intervalMinOf(def(), state({ quietStreak: 100 }))).toBe(WATCH_MAX_EVERY_MIN);
        expect(intervalMinOf(def({ every: 1 }), state({ quietStreak: 100 }))).toBe(WATCH_MAX_EVERY_MIN);
    });

    it("quietAfter = 0 ⇒ 永不降频（勤快的人自己管）", () => {
        expect(intervalMinOf(def({ quietAfter: 0 }), state({ quietStreak: 1000 }))).toBe(30);
    });
});

describe("这一拍该不该探", () => {
    it("从未探过 ⇒ 立刻探（新 watch 不必等一个周期）", () => {
        expect(isDue(def(), state(), 1_000)).toBe(true);
        expect(nextDueAt(def(), state())).toBeNull();
    });

    it("刚探过 ⇒ 不到点；到点 ⇒ 该探", () => {
        const s = state({ lastProbeAt: 0 });
        expect(isDue(def(), s, 30 * 60_000 - 1)).toBe(false);
        expect(isDue(def(), s, 30 * 60_000)).toBe(true);
        expect(nextDueAt(def(), s)).toBe(30 * 60_000);
    });

    it("降频后按降频间隔算", () => {
        const s = state({ lastProbeAt: 0, quietStreak: 4 }); // 30 → 120
        expect(isDue(def(), s, 60 * 60_000)).toBe(false);
        expect(isDue(def(), s, 120 * 60_000)).toBe(true);
    });

    it("停用的 watch 一拍都不探", () => {
        expect(isDue(def({ enabled: false }), state(), 1_000_000)).toBe(false);
    });
});

describe("指纹：顺序不算变化", () => {
    it("同一批 part 换个顺序 ⇒ 同一个指纹", () => {
        const a = parts(["a", "1"], ["b", "2"]);
        const b = parts(["b", "2"], ["a", "1"]);
        expect(fingerprintOf(a)).toBe(fingerprintOf(b));
    });

    it("值变了 ⇒ 指纹变（长度 16 位十六进制）", () => {
        const a = fingerprintOf(parts(["a", "1"]));
        expect(a).toMatch(/^[0-9a-f]{16}$/);
        expect(fingerprintOf(parts(["a", "2"]))).not.toBe(a);
    });
});

describe("人话 diff：只列变化的那几行", () => {
    it("没变化 ⇒ 空串（调用方据此「不喊人」）", () => {
        expect(diffParts(parts(["a", "1"]), parts(["a", "1"]))).toBe("");
    });

    it("新增 / 消失 / 改值三种行各有前缀", () => {
        const d = diffParts(parts(["gone", "x"], ["same", "s"], ["chg", "old"]), parts(["same", "s"], ["chg", "new"], ["new", "y"]));
        expect(d.split("\n").sort()).toEqual(["+ new = y", "- gone", "~ chg: old → new"].sort());
    });

    it("没有旧基线 ⇒ 空串（第一次不是「变化」）", () => {
        expect(diffParts(null, parts(["a", "1"]))).toBe("");
    });
});

describe("一次成功探测", () => {
    it("第一次只建基线：不喊人、不动 quietStreak", () => {
        const out = probeSucceeded(def(), state(), parts(["a", "1"]), 1_000);
        expect(out.verdict).toBe("baseline");
        expect(out.diff).toBe("");
        expect(out.state).toMatchObject({ lastProbeAt: 1_000, probes: 1, quietStreak: 0 });
        expect(out.state.fingerprint).not.toBeNull();
    });

    it("内容没变 ⇒ no-change，无关变化次数 +1（降频依据）", () => {
        const first = probeSucceeded(def(), state(), parts(["a", "1"]), 1_000);
        const second = probeSucceeded(def(), first.state, parts(["a", "1"]), 2_000);
        expect(second.verdict).toBe("no-change");
        expect(second.diff).toBe("");
        expect(second.state.quietStreak).toBe(1);
        expect(second.state.lastChangeAt).toBeNull();
    });

    it("内容变了 ⇒ changed，带 diff，无变化次数归零（回到原频率）", () => {
        const first = probeSucceeded(def(), state(), parts(["a", "1"]), 1_000);
        const second = probeSucceeded(def(), first.state, parts(["a", "2"]), 2_000);
        expect(second.verdict).toBe("changed");
        expect(second.diff).toBe("~ a: 1 → 2");
        expect(second.state).toMatchObject({ quietStreak: 0, lastChangeAt: 2_000 });
    });

    it("成功一次就清掉错误计数（恢复了就是恢复了）", () => {
        const broken = probeFailed(state(), "EACCES", 1_000);
        const out = probeSucceeded(def(), broken, parts(["a", "1"]), 2_000);
        expect(out.state.errorStreak).toBe(0);
        expect(out.state.lastError).toBeNull();
    });
});

describe("一次失败探测", () => {
    it("失败不算变化：指纹不动，错误累积，探测时刻照样推进（否则会每拍重试）", () => {
        const first = probeSucceeded(def(), state(), parts(["a", "1"]), 1_000);
        const bad = probeFailed(first.state, "EACCES", 2_000);
        expect(bad.fingerprint).toBe(first.state.fingerprint);
        expect(bad.lastProbeAt).toBe(2_000);
        expect(bad.errorStreak).toBe(1);
        expect(bad.lastError).toBe("EACCES");
    });

    it("连续失败到阈值 ⇒ isBroken（「watch 死了」要比「没变化」更吵）", () => {
        let s = state();
        for (let i = 0; i < WATCH_ERROR_STREAK_LIMIT; i++) s = probeFailed(s, "boom", i);
        expect(isBroken(s)).toBe(true);
    });
});

describe("定义校验（写入口的闸门）", () => {
    it("id 只认小写字母 / 数字 / 连字符：路径穿越被拒", () => {
        for (const bad of ["../etc/passwd", "a/b", "a.b", "A", "", "-x", "x".repeat(65)]) {
            expect(watchIdError(bad)).not.toBeNull();
        }
        expect(watchIdError("daily-pr")).toBeNull();
    });

    it("合法定义过；空标题 / 空探针 / 非法间隔各有一条错", () => {
        expect(validateWatchDef(def())).toBeNull();
        expect(validateWatchDef(def({ title: "  " }))).toContain("title");
        expect(validateWatchDef(def({ probes: [] }))).toContain("探针");
        expect(validateWatchDef(def({ every: 7 as never }))).toContain("every");
        expect(validateWatchDef(def({ quietAfter: -1 }))).toContain("quietAfter");
    });
});

describe("出口地址（订阅者抽象）", () => {
    it("四种前缀都认；没前缀 / 空目标 / 未知前缀各有自己的错", () => {
        for (const ok of ["room:projects/4/tasks/408", "task:projects/4/tasks/408", "member:agent:main", "inbox:human:chen56"]) {
            expect(sinkAddressError(ok)).toBeNull();
        }
        expect(sinkAddressError("projects/4/tasks/408")).toContain("前缀");
        expect(sinkAddressError("task:")).toContain("不能为空");
        expect(sinkAddressError("nope:x")).toContain("未知出口");
        expect(sinkAddressError("task:a b")).toContain("空白");
        expect(sinkAddressError("task:../etc")).toContain("..");
    });

    it("只有 room / task 跟任务走（任务结案时用来结束 watch）", () => {
        expect(taskOfSink("room:projects/4/tasks/408")).toBe("projects/4/tasks/408");
        expect(taskOfSink("task:projects/4/tasks/408")).toBe("projects/4/tasks/408");
        expect(taskOfSink("inbox:human:chen56")).toBeNull();
    });
});

describe("观察对象与生命周期", () => {
    it("四种 subject 各自带标识；none 没有标识", () => {
        expect(subjectLabel({ kind: "run", runId: "r1" })).toBe("run:r1");
        expect(subjectLabel({ kind: "task", uri: "projects/4/tasks/408" })).toBe("task:projects/4/tasks/408");
        expect(subjectLabel({ kind: "command", key: "npm test" })).toBe("command:npm test");
        expect(subjectLabel({ kind: "none" })).toBeUndefined();
    });

    it("空 id 的 subject 不合法（改绑新 run 无从判起）", () => {
        expect(subjectError({ kind: "run", runId: " " })).toContain("runId");
        expect(subjectError({ kind: "task", uri: "" })).toContain("uri");
        expect(subjectError({ kind: "command", key: "" })).toContain("key");
        expect(subjectError({ kind: "none" })).toBeNull();
        expect(subjectError(undefined)).toContain("subject");
    });

    it("command / none 天生不朽（不会因为「这次跑完了」被结束）", () => {
        expect(subjectIsPersistent({ kind: "command", key: "x" })).toBe(true);
        expect(subjectIsPersistent({ kind: "none" })).toBe(true);
        expect(subjectIsPersistent({ kind: "run", runId: "r1" })).toBe(false);
        expect(subjectIsPersistent({ kind: "task", uri: "u" })).toBe(false);
    });

    it("ended 之后一拍都不探；结束时刻不被后来的判定改写", () => {
        const s = endWatch(state(), 5_000, "对象没了");
        expect(s.ended).toEqual({ at: 5_000, reason: "对象没了" });
        expect(isDue(def(), s, 10_000_000)).toBe(false);
        expect(nextDueAt(def(), s)).toBeNull();
        expect(endWatch(s, 9_000, "又判了一次").ended?.at).toBe(5_000);
    });
});

describe("CLI 的 --subject 解析", () => {
    it("四种前缀各自落成对应形态；省略 / none 是无主观察", () => {
        expect(parseSubjectSpec("run:r-1")).toEqual({ kind: "run", runId: "r-1" });
        expect(parseSubjectSpec("task:projects/4/tasks/266")).toEqual({ kind: "task", uri: "projects/4/tasks/266" });
        expect(parseSubjectSpec("command:npm test")).toEqual({ kind: "command", key: "npm test" });
        expect(parseSubjectSpec(undefined)).toEqual({ kind: "none" });
        expect(parseSubjectSpec("none")).toEqual({ kind: "none" });
        expect(parseSubjectSpec("  ")).toEqual({ kind: "none" });
    });

    it("认不出的形态落成 command（可重开的身份），不抛 —— 报错交给 validateWatchDef", () => {
        expect(parseSubjectSpec("npm test")).toEqual({ kind: "command", key: "npm test" });
        // `run:` 空 id 是合法解析、非法定义 ⇒ 下一步由 subjectError 拦
        expect(parseSubjectSpec("run:")).toEqual({ kind: "run", runId: "" });
        expect(subjectError(parseSubjectSpec("run:"))).toContain("runId");
    });
});
