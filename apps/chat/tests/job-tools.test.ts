// tests/job-tools.test.ts
// 🎯 ##515 3b：bot 接上后台账本后**真跑三条判据**（不是只看 schema）。
//
//   ① `background: true` ⇒ 立刻拿到 job id（不阻塞），`job status` 看到 running
//   ② 结束之后 `job output` 拿到结果（命令真的跑完了，日志真在）
//   ③ `job kill` 真杀掉 —— 判据不只看工具返回，还**用 `kill -0` 查进程真的没了**
//
// 另外钉：bot 的 notifier 是 **silent**（`job wait` 是唯一的"等"；没有下一轮唤醒）。

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectShells, shellToolName } from "@diy-agent/tools";
import { botToolsFor } from "../index.js";

const spec = detectShells()[0];
const shell = spec ? shellToolName(spec) : "bash";

type Exec = { execute: (input: unknown, opts?: unknown) => Promise<unknown> };

function run(bt: ReturnType<typeof botToolsFor>, tool: string, input: Record<string, unknown>): Promise<string> {
    const t = bt.tools[tool] as unknown as Exec | undefined;
    expect(t?.execute, `工具集里没有 ${tool}`).toBeTypeOf("function");
    return Promise.resolve(t!.execute(input, { toolCallId: `t-${Math.random().toString(36).slice(2)}` })).then(String);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 进程还在吗（`kill -0`；与 jobs 包里判活的同一口径） */
function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

describe("bot 的后台任务（##515 3b，真跑）", () => {
    it.skipIf(!spec)("① background 立刻返回 id，status 看到 running；结束后 output 拿到结果", async () => {
        const home = mkdtempSync(join(tmpdir(), "t515-job-home-"));
        const bt = botToolsFor(home, "b1");
        try {
            const t0 = Date.now();
            const out = await run(bt, shell, { command: "sleep 3; echo background-done", background: true });
            expect(Date.now() - t0).toBeLessThan(2_000); // 立刻返回，不等 3 秒
            const id = /\[已转后台\] (r-[a-z0-9-]+)/.exec(out)?.[1];
            expect(id, `没拿到 job id：${out}`).toBeTruthy();

            const status = await run(bt, "job", { action: "status", id });
            expect(status).toContain("运行中");

            // 等它跑完（这里用 job wait：bot 没有唤醒通道，wait 是唯一的"等"）
            const done = await run(bt, "job", { action: "wait", id, timeoutMs: 20_000 });
            expect(done).toContain("已结束");
            const output = await run(bt, "job", { action: "output", id });
            expect(output).toContain("background-done");
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    }, 30_000);

    it.skipIf(!spec)("② job kill 真杀掉：工具说停了，`kill -0` 也说没了", async () => {
        const home = mkdtempSync(join(tmpdir(), "t515-job-home-"));
        const bt = botToolsFor(home, "b1");
        try {
            const out = await run(bt, shell, { command: "sleep 30", background: true });
            const id = /\[已转后台\] (r-[a-z0-9-]+)/.exec(out)?.[1];
            const pid = Number(/pid (\d+)/.exec(out)?.[1]);
            expect(id).toBeTruthy();
            expect(pid).toBeGreaterThan(0);
            expect(pidAlive(pid)).toBe(true);

            expect(await run(bt, "job", { action: "kill", id })).toContain("已发送停止信号");
            await run(bt, "job", { action: "wait", id, timeoutMs: 10_000 });
            expect(await run(bt, "job", { action: "status", id })).toContain("已被杀");
            await sleep(300); // SIGTERM 收尸是异步的
            expect(pidAlive(pid)).toBe(false); // 判据：进程真没了
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    }, 30_000);

    it.skipIf(!spec)("③ job list 只列本 bot 的 run（一个数据根一张表）", async () => {
        const home = mkdtempSync(join(tmpdir(), "t515-job-home-"));
        const bt = botToolsFor(home, "b1");
        try {
            expect(await run(bt, "job", { action: "list" })).toContain("没有后台进程");
            const out = await run(bt, shell, { command: "echo listed; sleep 0.2", background: true });
            const id = /\[已转后台\] (r-[a-z0-9-]+)/.exec(out)?.[1];
            const list = await run(bt, "job", { action: "list" });
            expect(list).toContain(id!);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    }, 30_000);

    it("④ bot 的 notifier 是 silent（没有下一轮唤醒通道）", async () => {
        const { RunRegistry } = await import("@diy-agent/jobs/node");
        const reg = new RunRegistry({ rootDir: join(tmpdir(), "t515-silent-probe") });
        expect(reg.notifyMode).toBe("silent");
        reg.clear();
    });
});
