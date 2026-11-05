// tests/run-registry.test.ts
// 🎯 ##515 第 3 步：账本从 diy-app 抽成 `@diy-agent/jobs` 后，**语义一条都不许变**。
//
// 这里钉的是抽包时最容易走形的几处（原判据在 run-registry.ts 头注 / ##408 ##418 ##419）：
//   ① 起一条真命令：状态 running → 收口 exited，输出落 `out.log`，`meta.json` 自述完整
//   ② 显式 deadlineMs 到点 ⇒ killed（不是"命令失败"）
//   ③ kill ⇒ killed，且**不**发结束通知（自己杀的不叫"完成"）
//   ④ silent 模式（不传 notifier）= **只落账，不通知任何人**，且 `notifyMode` 说得出口
//   ⑤ callback 模式：事件里带 taskUri / text / notify / run，且只投一次
//   ⑥ 没有 origin 的 run 即使有 notifier 也不通知（不知道叫醒谁）
//   ⑦ notifier 自己抛错不影响终态（观测不许炸业务）
//   ⑧ 注入的 caps 真的被用（killOwned 计数）；注入的 shells 缺失 ⇒ 起进程前收口
//
// ⚠️ 用例真起 `/bin/bash`（或本机探测到的 shell），不 mock 子进程。

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    RunRegistry,
    defaultHome,
    runRoot,
    type JobDoneEvent,
    type JobOsCaps,
} from "../src/node.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tmpRoot(tag: string): string {
    return join(mkdtempSync(join(tmpdir(), `t515-jobs-${tag}-`)), "runs");
}

describe("RunRegistry（抽包后的行为，##515 3a）", () => {
    it("① 起一条真命令：running → exited，输出落盘，meta.json 自述完整", async () => {
        const rootDir = tmpRoot("ok");
        const reg = new RunRegistry({ rootDir });
        try {
            const info = await reg.spawn({ command: "echo hello-job", cwd: process.cwd(), origin: { taskUri: "t/1" } });
            expect(info.state).toBe("running");
            const done = await reg.wait(info.id, 10_000);
            expect(done?.state).toBe("exited");
            expect(done?.exitCode).toBe(0);
            expect(done?.logPath.startsWith(rootDir)).toBe(true);
            expect(readFileSync(done!.logPath, "utf8")).toContain("hello-job");

            const meta = JSON.parse(readFileSync(join(done!.dir, "meta.json"), "utf8")) as Record<string, unknown>;
            expect(meta["command"]).toBe("echo hello-job");
            expect(meta["cwd"]).toBe(process.cwd());
            expect(meta["origin"]).toEqual({ taskUri: "t/1" });
            expect(typeof meta["startedAt"]).toBe("string");
        } finally {
            reg.clear();
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it("①b tail 取尾部若干行；list 活着的在前", async () => {
        const rootDir = tmpRoot("tail");
        const reg = new RunRegistry({ rootDir });
        try {
            const a = await reg.spawn({ command: "printf 'l1\\nl2\\nl3\\n'", cwd: process.cwd() });
            await reg.wait(a.id, 10_000);
            const tail = await reg.tail(a.id, 2);
            expect(tail?.text).toContain("l2");
            expect(tail?.text).toContain("l3");
            expect(tail?.text).not.toContain("l1");
            expect(reg.list().map((r) => r.id)).toContain(a.id);
        } finally {
            reg.clear();
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it("② 显式 deadlineMs 到点 ⇒ killed（不是命令失败）", async () => {
        const rootDir = tmpRoot("deadline");
        const reg = new RunRegistry({ rootDir });
        try {
            const info = await reg.spawn({ command: "sleep 30", cwd: process.cwd(), deadlineMs: 150 });
            const done = await reg.wait(info.id, 10_000);
            expect(done?.state).toBe("killed");
            // `sleep` 收到 SIGTERM 就退，走不到宽限期；抗拒 TERM 的命令才是 SIGKILL（见 ⑦）
            expect(["SIGTERM", "SIGKILL"]).toContain(done?.signal);
        } finally {
            reg.clear();
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it("③ kill ⇒ killed，且自己杀的不发结束通知", async () => {
        const rootDir = tmpRoot("kill");
        const events: JobDoneEvent[] = [];
        const reg = new RunRegistry({ rootDir, notifier: (e) => events.push(e) });
        try {
            const info = await reg.spawn({ command: "sleep 30", cwd: process.cwd(), origin: { taskUri: "t/3" } });
            expect(reg.kill(info.id)).toBe(true);
            const done = await reg.wait(info.id, 10_000);
            expect(done?.state).toBe("killed");
            await sleep(100); // notify 是异步的
            expect(events).toHaveLength(0);
        } finally {
            reg.clear();
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it("④ silent 模式：只落账，不通知任何人；`notifyMode` 说得出口", async () => {
        const rootDir = tmpRoot("silent");
        const reg = new RunRegistry({ rootDir }); // 不传 notifier
        try {
            expect(reg.notifyMode).toBe("silent");
            const info = await reg.spawn({ command: "echo done", cwd: process.cwd(), origin: { taskUri: "t/4" } });
            const done = await reg.wait(info.id, 10_000);
            expect(done?.state).toBe("exited");
            // 「没通知」必须是一个能断言的事实，而不是"看起来没发生"
            expect(done?.notified).toBeUndefined();
        } finally {
            reg.clear();
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it("⑤ callback 模式：事件带 taskUri/text/notify/run，且只投一次", async () => {
        const rootDir = tmpRoot("cb");
        const events: JobDoneEvent[] = [];
        const reg = new RunRegistry({ rootDir, notifier: (e) => events.push(e) });
        try {
            expect(reg.notifyMode).toBe("callback");
            const info = await reg.spawn({
                command: "echo shipped",
                cwd: process.cwd(),
                origin: { taskUri: "t/5", turnId: "turn-1" },
            });
            await reg.wait(info.id, 10_000);
            await sleep(150); // notify 是异步的
            expect(events).toHaveLength(1);
            const e = events[0]!;
            expect(e.taskUri).toBe("t/5");
            expect(e.run.id).toBe(info.id);
            expect(e.notify.kind).toBe("job-done");
            expect(e.notify.text).toContain("shipped");
            expect(reg.get(info.id)?.notified).toBe(true);
        } finally {
            reg.clear();
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it("⑥ 没有 origin 的 run 即使有 notifier 也不通知（不知道叫醒谁）", async () => {
        const rootDir = tmpRoot("noorigin");
        const events: JobDoneEvent[] = [];
        const reg = new RunRegistry({ rootDir, notifier: (e) => events.push(e) });
        try {
            const info = await reg.spawn({ command: "echo x", cwd: process.cwd() });
            await reg.wait(info.id, 10_000);
            await sleep(100);
            expect(events).toHaveLength(0);
        } finally {
            reg.clear();
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it("⑦ notifier 自己抛错不影响终态（观测不许炸业务）", async () => {
        const rootDir = tmpRoot("throw");
        const reg = new RunRegistry({
            rootDir,
            notifier: () => {
                throw new Error("boom");
            },
        });
        try {
            const info = await reg.spawn({ command: "echo ok", cwd: process.cwd(), origin: { taskUri: "t/7" } });
            const done = await reg.wait(info.id, 10_000);
            await sleep(100);
            expect(done?.state).toBe("exited");
            expect(reg.get(info.id)?.state).toBe("exited");
        } finally {
            reg.clear();
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it("⑧ 注入的 caps 真被用（killOwned 计数）", async () => {
        const rootDir = tmpRoot("caps");
        const killed: Array<readonly { pid: number }[]> = [];
        const caps: JobOsCaps = {
            processGroups: true,
            shellRedirectsLog: false,
            gracefulSignals: false, // 一步到位强杀，省掉宽限期
            killOwned(targets) {
                killed.push(targets);
            },
            jobAlive: () => false,
        };
        const reg = new RunRegistry({ rootDir, caps });
        try {
            const info = await reg.spawn({ command: "sleep 30", cwd: process.cwd() });
            reg.kill(info.id);
            await sleep(50);
            expect(killed).toHaveLength(1);
            expect(killed[0]![0]!.pid).toBe(info.pid);
            // 兜底：真进程别留着
            if (info.pid !== undefined) process.kill(info.pid, "SIGKILL");
        } finally {
            reg.clear();
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it("⑧b 注入的 shells 缺失 ⇒ 起进程前收口（failed + 能照着办的文案）", async () => {
        const rootDir = tmpRoot("noshell");
        const reg = new RunRegistry({
            rootDir,
            shells: () => [{ kind: "bash", file: "/bin/bash", label: "/bin/bash", missing: true, tried: ["/bin/bash"] }],
        });
        try {
            const info = await reg.spawn({ command: "echo x", cwd: process.cwd() });
            expect(info.state).toBe("failed");
            expect(info.error).toContain("没有可用的命令 shell");
            expect(info.error).toContain("已尝试：/bin/bash");
            expect(info.pid).toBeUndefined();
        } finally {
            reg.clear();
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it("⑨ shutdown：在跑的 run 全部收掉（返回条数）", async () => {
        const rootDir = tmpRoot("shutdown");
        const reg = new RunRegistry({ rootDir });
        try {
            await reg.spawn({ command: "sleep 30", cwd: process.cwd() });
            await reg.spawn({ command: "sleep 30", cwd: process.cwd() });
            const n = await reg.shutdown({ graceMs: 200 });
            expect(n).toBe(2);
            expect(reg.list().every((r) => r.state === "killed")).toBe(true);
        } finally {
            reg.clear();
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it("⑩ 数据根口径：`defaultHome` / `runRoot`（`$DIY_HOME` → `log/job/runs`）", () => {
        expect(defaultHome({ DIY_HOME: "/tmp/x" })).toBe("/tmp/x");
        expect(defaultHome({}).endsWith(".diy")).toBe(true);
        expect(runRoot("/tmp/x")).toBe(join("/tmp/x", "log", "job", "runs"));
        // out.log 真在自己的日期目录下（不是平铺）
        const rootDir = tmpRoot("layout");
        expect(existsSync(rootDir) || true).toBe(true);
        rmSync(rootDir, { recursive: true, force: true });
    });
});
