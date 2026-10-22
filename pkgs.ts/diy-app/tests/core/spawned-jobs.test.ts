// tests/core/spawned-jobs.test.ts
// 🎯 ##408 刀 5 —— spawned job 的**生命周期闭环**（`main/services/spawned-jobs.ts`）
//
// 全部用 tmpdir + **假时钟** + 假采样器：不 sleep、不真起进程、不真跑 top。
// 真账本（`job-ledger.appendRun`）照用 —— 要的就是「账上真落了几行、内容对不对」。
//
// 钉六件事：
//   ① 阈值：< 10s 的命令**不落账**（不制造噪声）；≥ 10s 才出现，且 `running` 行只写一次；
//   ② 收口：终态 + exitCode + 耗时 + outcome + summary 一句话（含峰值 / 丢弃量）；
//   ③ 取消 / 超时 / 失败三档分得开（state 都是 failed，outcome 不同 —— 失败率才不失真）；
//   ④ 收口幂等（取消与 close 两条到达路径只落一行终态）；
//   ⑤ settle 日志落盘 + logPath，且内容 = 环的**尾**（丢头时丢弃量出现在 summary 里）；
//   ⑥ 采样是**拉**的：没 pid 不采、没人看就 0 次，且 origin 指回 task/turn/step/toolCall。

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    SpawnedJobHandle,
    SpawnedJobTracker,
    jobLogPath,
    originOf,
    type SpawnedJobDeps,
} from "../../src/main/services/spawned-jobs";
import { appendRun, readAllRuns, readRuns } from "../../src/main/services/job-ledger";
import { jobList, jobShow } from "../../src/main/services/job-view";
import { SPAWN_JOB_PROMOTE_MS } from "../../src/shared/spawned-job";
import { LIVE_RING_BYTES } from "../../src/shared/output-ring";
import type { ProcessSample } from "../../src/shared/process-health";
import { InvariantError } from "../../src/shared/error-triage";

const dirs: string[] = [];
function tmpHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "diy-job-"));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 假时钟：测试用 `clock.ms` 推进（不真等）。 */
function makeHarness(home: string) {
    const clock = { ms: 1_700_000_000_000 };
    const samples: ProcessSample[] = [];
    let sampleCount = 0;
    const deps: SpawnedJobDeps = {
        home,
        now: () => clock.ms,
        rand: () => 0.5,
        appendRun: (run) => appendRun(run, { home, now: clock.ms }),
        // 假采样器：返回构造好的现场，绝不真跑 top/ps（否则单测要 ~1s/次）
        sample: (input) => {
            sampleCount += 1;
            const s: ProcessSample = {
                command: input.command,
                runMs: clock.ms - 1_700_000_000_000,
                outputBytes: input.outputBytes,
                silentMs: 2_000,
                cpuPercent: 12.5,
                treeCpuPercent: 88.8,
                memoryRssKb: 512 * 1024,
                childCount: 3,
                connections: [],
                historicalP50Ms: null,
            };
            samples.push(s);
            return s;
        },
        writeFile: async (path, data) => {
            const { writeFile: wf, mkdir } = await import("node:fs/promises");
            await mkdir(join(path, ".."), { recursive: true });
            await wf(path, data, "utf-8");
        },
    };
    const tracker = new SpawnedJobTracker(deps);
    return { clock, deps, tracker, samples, sampleCount: () => sampleCount };
}

const BEGIN = {
    taskUri: "projects/4/tasks/408",
    turnId: "t1700000000000",
    stepId: "t1700000000000_s2",
    toolCallId: "call_abc",
    cmd: "npm run build",
    cwd: "/Users/ccc/git/diy/diy",
};

async function advance(clock: { ms: number }, ms: number): Promise<void> {
    clock.ms += ms;
}

describe("阈值与晋升：短命令不落账，长命令只写一行 running", () => {
    it("< 10s 的命令**不落账**（也不写日志）：账本里什么都没有", async () => {
        const home = tmpHome();
        const { tracker, clock } = makeHarness(home);
        const job = tracker.begin(BEGIN);
        job.setPid(4242);
        job.noteOutput(Buffer.from("quick output\n"));
        await advance(clock, 1_500);

        const r = await job.finish({ outcome: "ok", exitCode: 0 });
        expect(r.persisted).toBe(false);
        expect(r.run.state).toBe("settled");
        expect(await readRuns(r.run.jobId, { home })).toEqual([]);
        expect(r.run.logPath).toBeUndefined();
    });

    it("≥ 10s 且有输出 ⇒ 晋升时写 running 行，且**只写一次**（多块输出不刷账）", async () => {
        const home = tmpHome();
        const { tracker, clock } = makeHarness(home);
        const job = tracker.begin(BEGIN);
        job.setPid(4242);
        job.noteOutput(Buffer.from("chunk-1\n"));
        await advance(clock, SPAWN_JOB_PROMOTE_MS + 1);
        for (let i = 0; i < 20; i++) {
            job.noteOutput(Buffer.from(`chunk-${i + 2}\n`));
            await advance(clock, 100);
        }
        await job.flush(); // 等晋升的落盘链走完（appendRun 是异步的）
        const rows = await readRuns(job.jobId, { home });
        expect(rows.length).toBe(1);
        expect(rows[0]!.state).toBe("running");
        expect(rows[0]!.origin.type).toBe("spawned");
    });

    it("running 行的 origin 指回 task/turn/step/toolCall（用户点名要能导航）", async () => {
        const home = tmpHome();
        const { tracker, clock } = makeHarness(home);
        const job = tracker.begin(BEGIN);
        await advance(clock, SPAWN_JOB_PROMOTE_MS);
        await job.finish({ outcome: "ok", exitCode: 0 });
        const rows = await readRuns(job.jobId, { home });
        const origin = rows[0]!.origin;
        expect(origin.type).toBe("spawned");
        expect(origin.data).toMatchObject({
            taskUri: BEGIN.taskUri,
            turnId: BEGIN.turnId,
            stepId: BEGIN.stepId,
            toolCallId: BEGIN.toolCallId,
            cmd: BEGIN.cmd,
        });
        // owner = 会话轮次（向上溯源，D7）
        expect(rows[0]!.owner).toEqual({ type: "turn", taskUri: BEGIN.taskUri, turnId: BEGIN.turnId });
    });

    it("缺锚点 ⇒ 在 begin() 当场抛 agent/missing-origin（不留到收口才炸）", () => {
        const { tracker } = makeHarness(tmpHome());
        for (const patch of [{ turnId: "" }, { stepId: "" }, { toolCallId: "" }, { taskUri: "" }, { cmd: "" }]) {
            let code: string | null = null;
            try {
                tracker.begin({ ...BEGIN, ...patch });
            } catch (e) {
                code = e instanceof InvariantError ? e.code : "NOT_INVARIANT";
            }
            expect(code, JSON.stringify(patch)).toBe("agent/missing-origin");
        }
    });

    it("originOf 是纯函数：同一入参给同一份规范化的 origin", () => {
        expect(originOf(BEGIN)).toEqual(originOf({ ...BEGIN }));
    });
});

describe("收口：终态 + 耗时 + outcome + 一句话结果", () => {
    it("成功：settled + exitCode 0 + ms + outcome ok + summary 带峰值", async () => {
        const home = tmpHome();
        const { tracker, clock } = makeHarness(home);
        const job = tracker.begin(BEGIN);
        job.setPid(4242);
        job.noteOutput(Buffer.from("hello\n"));
        await advance(clock, 12_000);
        job.sampleNow(); // 有人看 ⇒ 采一次
        await advance(clock, 3_000);
        const r = await job.finish({ outcome: "ok", exitCode: 0 });

        expect(r.run.state).toBe("settled");
        expect(r.run.outcome).toBe("ok");
        expect(r.run.exitCode).toBe(0);
        expect(r.run.ms).toBe(15_000);
        expect(r.run.endedAt).toBeDefined();
        expect(r.run.summary).toContain("完成");
        expect(r.run.summary).toContain("15.0s");
        expect(r.run.summary).toContain("采样 1 次");
        expect(r.health.peakTreeCpuPercent).toBe(88.8);

        const rows = await readRuns(job.jobId, { home });
        expect(rows.map((x) => x.state)).toEqual(["running", "settled"]); // 时间线两行，不改写旧行
        expect(rows[1]!.summary).toContain("退出码 0");
    });

    it("取消 / 超时 / 失败都落 failed，但 outcome 分得开（失败率不失真）", async () => {
        const home = tmpHome();
        for (const [outcome, extra] of [
            ["canceled", {}],
            ["timeout", { signal: "SIGKILL" }],
            ["fail", { exitCode: 2 }],
        ] as const) {
            const { tracker, clock } = makeHarness(home);
            const job = tracker.begin({ ...BEGIN, cmd: `npm run ${outcome}` });
            await advance(clock, SPAWN_JOB_PROMOTE_MS);
            const r = await job.finish({ outcome, ...extra });
            expect(r.run.state).toBe("failed");
            expect(r.run.outcome).toBe(outcome);
            if (outcome === "timeout") expect(r.run.signal).toBe("SIGKILL");
            if (outcome === "fail") expect(r.run.exitCode).toBe(2);
        }
    });

    it("收口幂等：重复 finish 只落一行终态（取消与 close 两条路径都会到这儿）", async () => {
        const home = tmpHome();
        const { tracker, clock } = makeHarness(home);
        const job = tracker.begin(BEGIN);
        await advance(clock, SPAWN_JOB_PROMOTE_MS);
        const a = await job.finish({ outcome: "canceled" });
        const b = await job.finish({ outcome: "ok", exitCode: 0 });
        expect(b.run).toEqual(a.run); // 第二次不改写第一次的结论
        const rows = await readRuns(job.jobId, { home });
        expect(rows.filter((r) => r.state !== "running").length).toBe(1);
        expect(rows[rows.length - 1]!.outcome).toBe("canceled");
    });
});

describe("输出环 → settle 日志：尾快照落盘，丢弃量如实记", () => {
    it("settle 日志 = 环的尾（超容量时前面被丢，summary 里写明丢了多少）", async () => {
        const home = tmpHome();
        const { tracker, clock } = makeHarness(home);
        const job = tracker.begin(BEGIN);
        job.setPid(4242);
        job.noteOutput(Buffer.from("a".repeat(LIVE_RING_BYTES)));
        await advance(clock, SPAWN_JOB_PROMOTE_MS);
        job.noteOutput(Buffer.from("TAIL-MARKER"));
        const r = await job.finish({ outcome: "ok", exitCode: 0 });

        expect(r.run.logPath).toBe(jobLogPath(job.id, home));
        const text = await readFile(r.run.logPath!, "utf-8");
        expect(text.endsWith("TAIL-MARKER")).toBe(true);
        expect(text.length).toBe(16 * 1024); // settle 快照上限，不是 256KB
        expect(r.run.summary).toContain("已丢头");
        expect(r.run.summary).toContain("输出 256.0KB");
    });

    it("没有输出 ⇒ 环空、日志空文件、summary 说 0B（不编造）", async () => {
        const home = tmpHome();
        const { tracker, clock } = makeHarness(home);
        const job = tracker.begin(BEGIN);
        await advance(clock, SPAWN_JOB_PROMOTE_MS);
        const r = await job.finish({ outcome: "timeout" });
        expect(await readFile(r.run.logPath!, "utf-8")).toBe("");
        expect(r.run.summary).toContain("输出 0B");
    });
});

describe("采样是「拉」的：没人看就 0 次，没 pid 不采", () => {
    it("没有 pid ⇒ sampleNow 返回 null 且不调用采样器（不造假数据）", () => {
        const { tracker, sampleCount } = makeHarness(tmpHome());
        const job = tracker.begin(BEGIN);
        expect(job.sampleNow()).toBeNull();
        expect(sampleCount()).toBe(0);
    });

    it("没人看 ⇒ 一次都不采，收口 summary 写「未采样」（诚实，不写「健康」）", async () => {
        const home = tmpHome();
        const { tracker, clock, sampleCount } = makeHarness(home);
        const job = tracker.begin(BEGIN);
        job.setPid(4242);
        await advance(clock, SPAWN_JOB_PROMOTE_MS);
        const r = await job.finish({ outcome: "ok", exitCode: 0 });
        expect(sampleCount()).toBe(0);
        expect(r.run.summary).toContain("未采样");
        expect(r.health.samples).toBe(0);
    });

    it("有人看 ⇒ 采到 CPU / 内存 / 子进程，且判据结果进 lastSample", () => {
        const { tracker, samples } = makeHarness(tmpHome());
        const job = tracker.begin(BEGIN);
        job.setPid(4242);
        job.noteOutput(Buffer.from("x"));
        const s1 = job.sampleNow();
        const s2 = job.sampleNow();
        expect(s1).not.toBeNull();
        expect(s1!.cpuPercent).toBe(12.5);
        expect(s1!.memoryRssKb).toBe(512 * 1024);
        expect(s1!.childCount).toBe(3);
        expect(s1!.verdict).toBe("progressing"); // 静默 2s < progressWindow，采样器造的样本
        expect(s2).not.toBeNull();
        expect(samples.length).toBe(2);
        expect(job.snapshot().samples).toBe(2);
    });
});

describe("视图：ls 的折叠 + show 的双视角", () => {
    it("ls：同命令多次执行折叠成 1 组（runs=N），按最近跑过的排序", async () => {
        const home = tmpHome();
        const { tracker, clock } = makeHarness(home);
        for (let i = 0; i < 3; i++) {
            const job = tracker.begin(BEGIN);
            job.setPid(100 + i);
            await advance(clock, SPAWN_JOB_PROMOTE_MS + i);
            await job.finish({ outcome: "ok", exitCode: 0 });
            tracker.noteFinished(job);
            await advance(clock, 1_000);
        }
        const other = tracker.begin({ ...BEGIN, cmd: "npm test" });
        await advance(clock, SPAWN_JOB_PROMOTE_MS);
        await other.finish({ outcome: "fail", exitCode: 1 });

        const view = await jobList({ home, tracker });
        // 账本是 append-only：每次 run 两行（running + 终态）⇒ 4 次 run = 8 行
        expect(view.runs.length).toBe(8);
        expect(view.groups.length).toBe(2);
        const build = view.groups.find((g) => g.title === "npm run build")!;
        expect(build.runs).toBe(3); // 折叠按**不同 run** 计，不是行数
        expect(build.lastState).toBe("settled");
        expect(build.lastOutcome).toBe("ok");
        // 最近跑过的在前
        expect(view.groups[0]!.title).toBe("npm test");
    });

    it("ls：在跑但还没落账的也在 live 里（promoted=false）—— 短命令不至于完全隐身", async () => {
        const home = tmpHome();
        const { tracker } = makeHarness(home);
        const job = tracker.begin({ ...BEGIN, cmd: "npm run dev" });
        job.setPid(999);
        const view = await jobList({ home, tracker });
        expect(view.runs).toEqual([]); // 账上还没有
        expect(view.live.length).toBe(1);
        expect(view.live[0]!.promoted).toBe(false);
        expect(view.live[0]!.pid).toBe(999);
        expect(view.groups).toEqual([]);
    });

    it("show：给 runId 只回一条；给 jobId 回该命令的整条时间线", async () => {
        const home = tmpHome();
        const { tracker, clock } = makeHarness(home);
        const ids: string[] = [];
        for (let i = 0; i < 2; i++) {
            const job = tracker.begin(BEGIN);
            job.noteOutput(Buffer.from(`run-${i}\n`));
            await advance(clock, SPAWN_JOB_PROMOTE_MS);
            const r = await job.finish({ outcome: "ok", exitCode: 0 });
            ids.push(r.run.id);
            tracker.noteFinished(job);
            await advance(clock, 1_000);
        }
        const byRun = await jobShow(ids[0]!, { home, tracker });
        // 一条 run 在 append-only 账上就是「running + 终态」两行 —— 全给（时间线），current 取最后
        expect(byRun.runs.length).toBe(2);
        expect(byRun.runs.every((r) => r.id === ids[0])).toBe(true);
        expect(byRun.current!.state).toBe("settled");

        const byJob = await jobShow(byRun.runs[0]!.jobId, { home, tracker });
        expect(byJob.runs.length).toBe(4); // 两次 run × 2 行
        expect(byJob.group?.runs).toBe(2); // 但只有 2 次运行
        expect(byJob.current!.id).toBe(ids[1]);
        // settle 日志 tail 读得到（双视角里的 settle 那一半）
        expect(byJob.logTail).toContain("run-1");
        expect(byJob.logPath).toBeTruthy();
    });

    it("show：活体在一起时给 live/settle 双视角（settle 未收口 = 空且 frozen=false）", async () => {
        const home = tmpHome();
        const { tracker } = makeHarness(home);
        const job = tracker.begin({ ...BEGIN, cmd: "npm run watch" });
        job.setPid(777);
        job.noteOutput(Buffer.from("streaming..."));
        const view = await jobShow(job.id, { home, sample: true, tracker });
        expect(view.live).not.toBeNull();
        expect(view.live!.liveText).toBe("streaming...");
        expect(view.live!.settleText).toBe("");
        expect(view.live!.frozen).toBe(false);
        expect(view.live!.output.droppedBytes).toBe(0);
        expect(view.live!.lastSample).not.toBeNull(); // --sample 才采
        expect(view.runs).toEqual([]); // 还没落账
    });

    it("show：不存在的 id ⇒ 全空（查询结果不是错误）", async () => {
        const home = tmpHome();
        const { tracker } = makeHarness(home);
        const view = await jobShow("spawn-nope-deadbeef", { home, tracker });
        expect(view.runs).toEqual([]);
        expect(view.live).toBeNull();
        expect(view.current).toBeNull();
        expect(view.logTail).toBeNull();
    });
});

describe("账本：跨文件读取（ls 的数据源）", () => {
    it("readAllRuns：合并多个 job 文件、按 startedAt 升序、空目录返回空", async () => {
        const home = tmpHome();
        expect((await readAllRuns({ home })).runs).toEqual([]);
        const { tracker, clock } = makeHarness(home);
        const a = tracker.begin({ ...BEGIN, cmd: "npm run a" });
        await advance(clock, SPAWN_JOB_PROMOTE_MS);
        await a.finish({ outcome: "ok", exitCode: 0 });
        const b = tracker.begin({ ...BEGIN, cmd: "npm run b" });
        await advance(clock, SPAWN_JOB_PROMOTE_MS);
        await b.finish({ outcome: "fail", exitCode: 1 });

        const all = await readAllRuns({ home });
        expect(all.files).toBe(2);
        expect(all.skipped).toBe(0);
        expect(all.runs.length).toBe(4);
        const starts = all.runs.map((r) => r.startedAt);
        expect([...starts].sort()).toEqual(starts); // 升序
    });
});

/** 类型守卫：让 `SpawnedJobHandle` 的引用不被摇树（也证明它是对外类型） */
export type _Handle = SpawnedJobHandle;
