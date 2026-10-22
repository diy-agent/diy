// tests/core/spawned-job.test.ts
// 🎯 ##408 刀 5 —— 「长时命令 → job」的**纯判据**（`shared/spawned-job.ts`）
//
// 钉四件事：
//   ① 阈值是显式常量且与 process-health 的 progressWindow 对齐（不是拍脑袋的数字）；
//   ② outcome 四值 → state 四态是**固定映射**（取消 / 超时不许和缺陷混在一起统计）；
//   ③ 采样汇总**空样本必须说 0**（不许编造健康），峰值取最大、stuck 计数复用同一把尺子；
//   ④ jobId / runId 过 `isSafeJobId`（账本文件名），同命令同桶、不同命令不同桶。

import { describe, it, expect } from "vitest";
import {
    SPAWN_JOB_PROMOTE_MS,
    OUTCOME_TO_STATE,
    RUN_OUTCOMES,
    buildRunSummary,
    describeOutcome,
    emptyHealthSummary,
    fmtBytes,
    fmtDuration,
    jobIdOfTaskCommand,
    jobTitleOf,
    makeRunId,
    outcomeState,
    shouldTrackAsJob,
    summarizeRunHealth,
} from "../../src/shared/spawned-job";
import { isSafeJobId } from "../../src/shared/job-run";
import { DEFAULT_HEALTH_POLICY, type ProcessSample } from "../../src/shared/process-health";

function sample(over: Partial<ProcessSample> = {}): ProcessSample {
    return {
        command: "npm i",
        runMs: 20_000,
        outputBytes: 100,
        silentMs: 1_000,
        cpuPercent: 1,
        treeCpuPercent: 1,
        childCount: 0,
        connections: [],
        historicalP50Ms: null,
        ...over,
    };
}

describe("阈值：显式常量，且与 process-health 的窗口对齐", () => {
    it("10 秒（理由见文件头 a/b/c）", () => {
        expect(SPAWN_JOB_PROMOTE_MS).toBe(10_000);
    });

    it("阈值必须 ≤ progressWindowMs（否则「已登记但判据还认为一切正常」，白登记）", () => {
        expect(SPAWN_JOB_PROMOTE_MS).toBeLessThanOrEqual(DEFAULT_HEALTH_POLICY.progressWindowMs);
    });

    it("shouldTrackAsJob：等于阈值即算（>= 不是 >，避免正好 10.000s 漏掉）", () => {
        expect(shouldTrackAsJob(SPAWN_JOB_PROMOTE_MS - 1)).toBe(false);
        expect(shouldTrackAsJob(SPAWN_JOB_PROMOTE_MS)).toBe(true);
        expect(shouldTrackAsJob(SPAWN_JOB_PROMOTE_MS * 10)).toBe(true);
    });
});

describe("outcome → state：固定映射（取消/超时不许混进缺陷统计）", () => {
    it("ok → settled；fail/canceled/timeout → failed", () => {
        expect(outcomeState("ok")).toBe("settled");
        expect(outcomeState("fail")).toBe("failed");
        expect(outcomeState("canceled")).toBe("failed");
        expect(outcomeState("timeout")).toBe("failed");
    });

    it("映射表覆盖全部四值（加新 outcome 忘了映射会在这里红）", () => {
        expect(Object.keys(OUTCOME_TO_STATE).sort()).toEqual([...RUN_OUTCOMES].sort());
        for (const o of RUN_OUTCOMES) expect(describeOutcome(o).length).toBeGreaterThan(0);
    });
});

describe("采样汇总：空样本如实说 0，峰值取最大", () => {
    it("没采过样 ⇒ samples=0 且 verdict=null（**不编造健康**）", () => {
        const h = summarizeRunHealth([]);
        expect(h).toEqual(emptyHealthSummary());
        expect(h.samples).toBe(0);
        expect(h.lastVerdict).toBeNull();
    });

    it("多份样本 ⇒ 峰值取最大；最后一份的结论就是「最后状态」", () => {
        const h = summarizeRunHealth([
            sample({ cpuPercent: 3, treeCpuPercent: 90, memoryRssKb: 100_000, silentMs: 1_000 }),
            // 第二份故意让**树** CPU 也低（否则 R2 会判「在算」——见下一条），静默 900s ⇒ R4
            sample({ cpuPercent: 0.2, treeCpuPercent: 0.3, memoryRssKb: 2_000_000, silentMs: 900_000, historicalP50Ms: 1_000 }),
        ]);
        expect(h.samples).toBe(2);
        expect(h.peakCpuPercent).toBe(3);
        expect(h.peakTreeCpuPercent).toBe(90);
        expect(h.peakMemoryKb).toBe(2_000_000);
        // 第二份：静默 900s 且 CPU 低 ⇒ R4 stuck（同一把尺子：judgeHealth）
        expect(h.lastVerdict).toBe("stuck");
        expect(h.stuckSamples).toBe(1);
    });

    it("进程在算（树 CPU 高）不判 stuck —— 汇总复用判据，不另写一套阈值", () => {
        const h = summarizeRunHealth([
            sample({ silentMs: 900_000, cpuPercent: 0.1, treeCpuPercent: 88, historicalP50Ms: 1_000 }),
        ]);
        expect(h.lastVerdict).toBe("progressing");
        expect(h.lastRule).toBe("R2:cpu-active");
        expect(h.stuckSamples).toBe(0);
    });

    it("没有 memoryRssKb 的样本 ⇒ peakMemoryKb=0（不是 NaN、不是 -1）", () => {
        const h = summarizeRunHealth([sample({ silentMs: 1_000 })]);
        expect(h.peakMemoryKb).toBe(0);
    });
});

describe("成账文案：同一句话供账本/CLI/面板共用", () => {
    const health = summarizeRunHealth([sample({ silentMs: 1_000, treeCpuPercent: 12, memoryRssKb: 1024 * 1024 })]);

    it("成功：带耗时、退出码、输出量、峰值与采样次数", () => {
        const text = buildRunSummary({ outcome: "ok", ms: 12_300, exitCode: 0, outputBytes: 2048, droppedBytes: 0, health });
        expect(text).toContain("完成");
        expect(text).toContain("12.3s");
        expect(text).toContain("退出码 0");
        expect(text).toContain("2.0KB");
        expect(text).toContain("采样 1 次");
        expect(text).not.toContain("丢头");
    });

    it("丢弃量 > 0 必须出现在文案里（否则 tail 会被当成全量）", () => {
        const text = buildRunSummary({ outcome: "timeout", ms: 300_000, signal: "SIGKILL", outputBytes: 900_000, droppedBytes: 400_000, health });
        expect(text).toContain("超时");
        expect(text).toContain("信号 SIGKILL");
        expect(text).toContain("已丢头");
    });

    it("没采样 ⇒ 明说「未采样（无人查看）」，不许写「健康」", () => {
        const text = buildRunSummary({ outcome: "ok", ms: 11_000, outputBytes: 0, droppedBytes: 0, health: summarizeRunHealth([]) });
        expect(text).toContain("未采样");
        expect(text).not.toContain("健康");
    });

    it("fmtBytes / fmtDuration 的刻度（CLI 与面板同一把尺子）", () => {
        expect(fmtBytes(999)).toBe("999B");
        expect(fmtBytes(1536)).toBe("1.5KB");
        expect(fmtBytes(2 * 1024 * 1024)).toBe("2.0MB");
        expect(fmtDuration(999)).toBe("999ms");
        expect(fmtDuration(1_500)).toBe("1.5s");
        expect(fmtDuration(125_000)).toBe("2m5s");
    });
});

describe("标识：jobId 是「同一件事」的桶，runId 是每次执行", () => {
    const task = "projects/4/tasks/408";
    const cwd = "/Users/ccc/git/diy/diy";

    it("同 task + cwd + 命令 ⇒ 同 jobId（折叠 1:n 的前提）", () => {
        const a = jobIdOfTaskCommand(task, cwd, "npm i");
        const b = jobIdOfTaskCommand(task, cwd, "npm i");
        expect(a).toBe(b);
        // 不同命令 / 不同任务 / 不同目录 ⇒ 不同桶
        expect(jobIdOfTaskCommand(task, cwd, "npm test")).not.toBe(a);
        expect(jobIdOfTaskCommand("projects/4/tasks/401", cwd, "npm i")).not.toBe(a);
        expect(jobIdOfTaskCommand(task, "/tmp", "npm i")).not.toBe(a);
    });

    it("jobId 能当账本文件名（isSafeJobId）：绝对路径 / 空格 / 中文命令都不得越界", () => {
        for (const cmd of ["/usr/local/bin/python3 -m http.server", "rg '中文' -n src", "  ", "echo $(rm -rf /)"]) {
            const id = jobIdOfTaskCommand(task, cwd, cmd);
            expect(isSafeJobId(id)).toBe(true);
            expect(id).not.toContain("..");
            expect(id).not.toContain("/");
        }
    });

    it("jobId 带可读 slug（首词），不是纯哈希（人要在 ls 里认得出来）", () => {
        expect(jobIdOfTaskCommand(task, cwd, "npm i")).toMatch(/^spawn-npm-[0-9a-f]{8}$/);
        expect(jobIdOfTaskCommand(task, cwd, "/usr/bin/npm run build")).toMatch(/^spawn-npm-/);
        // 首词全非法字符 ⇒ 退回 cmd，仍然形状合法
        expect(isSafeJobId(jobIdOfTaskCommand(task, cwd, "「引号」"))).toBe(true);
    });

    it("makeRunId 唯一可读（epoch36 + 4 位随机）且能当文件名", () => {
        const a = makeRunId(1_700_000_000_000, () => 0.1);
        expect(a).toMatch(/^r[0-9a-z]+-[0-9a-f]{4}$/);
        expect(isSafeJobId(a)).toBe(true);
        expect(makeRunId(1_700_000_000_000, () => 0.9)).not.toBe(a);
    });

    it("jobTitleOf 取首行、压空白、超长截断（命令可能很长且带换行）", () => {
        expect(jobTitleOf("  npm   i\n--verbose")).toBe("npm i");
        expect(jobTitleOf("")).toBe("(空命令)");
        expect(jobTitleOf("\n\n", 10)).toBe("(空命令)");
        const long = jobTitleOf("x".repeat(200), 20);
        expect(long.length).toBe(20);
        expect(long.endsWith("…")).toBe(true);
    });
});
