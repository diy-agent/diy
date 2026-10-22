// tests/core/job-ledger.test.ts
// 🎯 ##408 刀 2 —— 执行账落盘（`main/services/job-ledger.ts`）
//
// 钉住的四条（都是「观测数据可腐烂」场景下不能炸业务的判据）：
//   ① **round-trip**：append 一行 → read 回来是同一个 run；顺序 = 写入顺序（时间线才对得起来）；
//   ② **坏行容错**：半行 / 乱码 / 形状不对 ⇒ 跳过并计数，**其余照读**（绝不因一行烂数据炸业务）；
//   ③ **并发 append 不撕行**：50 条并发写下去，行数不变、每行都能 JSON.parse（没有交错半行）；
//   ④ **jobId 防穿越**：`../x` / `a/../../b` 一律拒（code = agent/invalid-job-id），账不许写到 home 之外。

import { afterAll, describe, it, expect } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    appendRun,
    jobLedgerPath,
    jobsDir,
    latestRun,
    latestState,
    readRuns,
    readRunsDetailed,
} from "../../src/main/services/job-ledger";
import type { JobOrigin, JobRun } from "../../src/shared/job-run";
import { InvariantError } from "../../src/shared/error-triage";

const roots: string[] = [];
function newHome(): string {
    const d = mkdtempSync(join(tmpdir(), "diy-job-ledger-"));
    roots.push(d);
    return d;
}
afterAll(() => {
    for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const origin: JobOrigin = {
    type: "spawned",
    data: { taskUri: "projects/4/tasks/408", turnId: "t1", stepId: "s1", toolCallId: "call_1", cmd: "sleep 5" },
};

function run(id: string, state: "running" | "settled" | "failed" | "lost" = "running", over: Partial<JobRun> = {}): JobRun {
    const base = {
        id,
        jobId: "bash.background",
        kind: "spawned",
        title: "后台命令",
        owner: { type: "turn", taskUri: "projects/4/tasks/408", turnId: "t1" },
        state,
        startedAt: "2026-10-22T08:00:00.000Z",
        origin,
        ...(state === "running" ? {} : { endedAt: "2026-10-22T08:00:01.000Z", ms: 1000 }),
        ...over,
    } as JobRun;
    return base;
}

function catchInvariant(fn: () => unknown): InvariantError {
    try {
        fn();
    } catch (e) {
        if (e instanceof InvariantError) return e;
        throw e;
    }
    throw new Error("期望抛 InvariantError，实际没抛");
}

describe("落点 —— 一律走 runtime 解析的 home", () => {
    it("jobsDir / jobLedgerPath 都落在 <home>/jobs 下", async () => {
        const home = newHome();
        expect(jobsDir(home)).toBe(join(home, "jobs"));
        expect(jobLedgerPath("models.refresh", home)).toBe(join(home, "jobs", "models.refresh.jsonl"));
    });

    it("目录不存在时自动建（首次跑不该因缺目录失败）", async () => {
        const home = newHome();
        await appendRun(run("r1"), { home });
        expect(existsSync(join(home, "jobs", "bash.background.jsonl"))).toBe(true);
    });
});

describe("round-trip —— 写进去的 = 读回来的", () => {
    it("append → read 保序且字段不丢；latestState 取最后一条", async () => {
        const home = newHome();
        await appendRun(run("r1"), { home, now: Date.parse("2026-10-22T08:00:00.000Z") });
        await appendRun(run("r2", "settled", { summary: "ok" }), { home });
        const runs = await readRuns("bash.background", { home });
        expect(runs.map((r) => r.id)).toEqual(["r1", "r2"]);
        expect(runs[1]!.state).toBe("settled");
        expect(runs[1]!.summary).toBe("ok");
        expect(runs[1]!.origin).toEqual(origin);
        expect(await latestState("bash.background", { home })).toBe("settled");
        expect((await latestRun("bash.background", { home }))?.id).toBe("r2");
    });

    it("行形状 = { ts, ...run }：ts 是写入时刻，与 startedAt 不是一个概念", async () => {
        const home = newHome();
        await appendRun(run("r1"), { home, now: Date.parse("2026-10-22T09:00:00.000Z") });
        const raw = readFileSync(jobLedgerPath("bash.background", home), "utf-8").trim();
        const row = JSON.parse(raw) as { ts: string; startedAt: string; id: string };
        expect(row.ts).toBe("2026-10-22T09:00:00.000Z");
        expect(row.startedAt).toBe("2026-10-22T08:00:00.000Z");
        expect(row.id).toBe("r1");
    });

    it("limit 取尾部 N 条（面板「最近几次」）；空账 = 空列表不是错误", async () => {
        const home = newHome();
        expect(await readRuns("nobody", { home })).toEqual([]);
        for (const id of ["r1", "r2", "r3"]) await appendRun(run(id), { home });
        expect((await readRuns("bash.background", { home, limit: 2 })).map((r) => r.id)).toEqual(["r2", "r3"]);
    });

    it("origin 缺失 ⇒ 抛 agent/missing-origin 且**不落盘**（账本只收有来源的 run）", async () => {
        const home = newHome();
        const bad = { ...run("r1"), origin: undefined } as unknown as JobRun;
        await expect(appendRun(bad, { home })).rejects.toBeInstanceOf(InvariantError);
        expect(existsSync(jobLedgerPath("bash.background", home))).toBe(false);
    });
});

describe("坏行容错 —— 观测数据可腐烂，不许炸业务", () => {
    it("半行 / 乱码 / 形状不对都跳过，合法行照读", async () => {
        const home = newHome();
        await appendRun(run("r1"), { home });
        const p = jobLedgerPath("bash.background", home);
        appendFileSync(p, '{"id":"broken"\n', "utf-8"); // 半行（进程被 kill 的典型现场）
        appendFileSync(p, "not json at all\n", "utf-8"); // 乱码
        appendFileSync(p, JSON.stringify({ ...run("rx"), origin: undefined }) + "\n", "utf-8"); // 缺 origin
        appendFileSync(p, "\n", "utf-8"); // 空行（不算坏行）
        await appendRun(run("r2", "failed", { error: "boom" }), { home });

        const got = await readRunsDetailed("bash.background", { home });
        expect(got.runs.map((r) => r.id)).toEqual(["r1", "r2"]);
        expect(got.skipped).toBe(3);
    });

    it("全是坏行 ⇒ 空列表（latestState = null，不假装有状态）", async () => {
        const home = newHome();
        mkdirSync(join(home, "jobs"), { recursive: true });
        writeFileSync(jobLedgerPath("bash.background", home), "garbage\n{\"id\":\"x\"}\n", "utf-8");
        const got = await readRunsDetailed("bash.background", { home });
        expect(got.runs).toEqual([]);
        expect(got.skipped).toBe(2);
        expect(await latestState("bash.background", { home })).toBeNull();
    });
});

describe("并发 append —— 不撕行、不丢行", () => {
    it("50 条并发写下去：行数 = 50，每行都能解析，run 一个不少", async () => {
        const home = newHome();
        const runs = Array.from({ length: 50 }, (_, i) => run(`r${i}`));
        await Promise.all(runs.map((r) => appendRun(r, { home })));
        const text = readFileSync(jobLedgerPath("bash.background", home), "utf-8");
        const lines = text.split("\n").filter((l) => l.trim());
        expect(lines.length).toBe(50);
        for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
        const ids = new Set((await readRuns("bash.background", { home })).map((r) => r.id));
        expect(ids.size).toBe(50);
    });
});

describe("jobId 防路径穿越", () => {
    it("../x / a/../../b / . / 空串 一律拒（agent/invalid-job-id）", async () => {
        const home = newHome();
        for (const bad of ["../x", "a/../../b", "..", ".", "", "a b", "x/y"]) {
            expect(catchInvariant(() => jobLedgerPath(bad, home)).code).toBe("agent/invalid-job-id");
            await expect(appendRun({ ...run("r1"), jobId: bad }, { home })).rejects.toBeInstanceOf(InvariantError);
        }
        expect(existsSync(join(home, "x.jsonl"))).toBe(false);
    });

    it("正常 jobId（点号 / 下划线 / 连字符）放行", () => {
        const home = newHome();
        for (const ok of ["models.refresh", "watch_self", "bash-background-v2"]) {
            expect(jobLedgerPath(ok, home)).toBe(join(home, "jobs", `${ok}.jsonl`));
        }
    });
});
