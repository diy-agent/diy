// tests/core/run-detach.test.ts
// 🎯 ##408 刀 19 —— 前台命令**运行中转后台**（`runBash.handoff` + `RunRegistry.adopt`）
//
// 参考 opencode `ctrl+b`（`core/src/job.ts::background`）：它的转换是纯内存的
// （前台从第一秒就写文件，转后台 = resolve 一个 Deferred）。我们不同：前台是
// `pipe + 内存缓冲`，所以转换必须**就地改道**——同一个 child、同一个读端，只换字节去向。
//
// 六个坑逐条钉在测试名里（漏一个都是"转过去的活几百毫秒后自己死掉"）：
//   ① 读端不关（关了就 64KB 阻塞）② 不再判 maxBuffer ③ 撤超时 ④ 摘 abort
//   ⑤ 双按 / 已结束要拒绝 ⑥ 前半段输出不许丢。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBash, type BashControl, type LocalAgentLimits } from "../../src/main/services/local-agent";
import { RunRegistry } from "../../src/main/services/run-registry";

/** 刻意短（300ms）：第 2 例要证明「转后台之后这个超时不再开火」。 */
const limits = { bashTimeoutMs: 300 } as unknown as LocalAgentLimits;
const origin = { taskUri: "projects/4/tasks/408", turnId: "t1", stepId: "t1_s1", toolCallId: "call-1" };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let root: string;
let reg: RunRegistry;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "diy-detach-"));
    reg = new RunRegistry({ rootDir: root });
});

afterEach(() => {
    for (const p of reg.list()) if (p.state === "running") reg.kill(p.id);
    reg.clear();
    rmSync(root, { recursive: true, force: true });
});

/** 起一条前台命令并拿控制句柄（`onControl` 在 executor 里同步调用，故返回时必有）。 */
function startForeground(
    command: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): { run: ReturnType<typeof runBash>; ctl: BashControl } {
    let ctl: BashControl | undefined;
    const run = runBash(
        command,
        root,
        limits,
        opts.signal,
        {
            onControl: (c) => {
                ctl = c;
            },
        },
        opts.timeoutMs,
    );
    if (!ctl) throw new Error("onControl 没有被同步调用");
    return { run, ctl };
}

describe("运行中转后台", () => {
    it("转后台不重启进程：pid 不变、前半段与后续输出按序落盘、按 close 收口", async () => {
        const { run, ctl } = startForeground("echo early; sleep 0.4; echo late", { timeoutMs: 20_000 });
        // 让 `early` 先被前台收下（这就是"转之前已经产生的输出"）
        await sleep(150);
        let toolSettled = false;
        void run.then(() => {
            toolSettled = true;
        });

        const info = await reg.adopt({ process: ctl, command: "echo early; sleep 0.4; echo late", cwd: root, origin });
        expect(info.pid).toBe(ctl.pid); // 同一个进程，不是重开的
        expect(info.state).toBe("running");

        const done = await reg.wait(info.id, 10_000);
        expect(done?.state).toBe("exited");
        expect(done?.exitCode).toBe(0);
        // ① 读端没关（关了 sleep 之后那次 echo 会因 EPIPE 丢）+ ⑥ 前半段没丢
        expect(readFileSync(info.logPath, "utf8")).toBe("early\nlate\n");
        // 交接之后本函数不再落 settle：工具调用的 Promise 永远不 resolve（归属权已交出）
        await sleep(50);
        expect(toolSettled).toBe(false);
    });

    it("②③ 转后台后不再判 maxBuffer、超时定时器已撤（原 300ms 超时不许开火）", async () => {
        const { ctl } = startForeground("sleep 0.7; echo alive", { timeoutMs: 300 });
        await sleep(50);
        const info = await reg.adopt({ process: ctl, command: "sleep 0.7; echo alive", cwd: root });
        await sleep(500); // 已越过原来的 300ms 超时
        expect(reg.get(info.id)?.state).toBe("running");
        const done = await reg.wait(info.id, 10_000);
        expect(done?.state).toBe("exited");
        expect(done?.exitCode).toBe(0);
        expect(readFileSync(info.logPath, "utf8")).toContain("alive");
    });

    it("④ 转后台后摘掉轮次 abort：用户点「停止本轮」不许带走刚转后台的活", async () => {
        const ac = new AbortController();
        const { ctl } = startForeground("sleep 0.5; echo survived", { signal: ac.signal, timeoutMs: 20_000 });
        const info = await reg.adopt({ process: ctl, command: "sleep 0.5; echo survived", cwd: root });
        ac.abort(); // 本轮的取消
        const done = await reg.wait(info.id, 10_000);
        expect(done?.state).toBe("exited"); // 不是 killed
        expect(done?.exitCode).toBe(0);
        expect(readFileSync(info.logPath, "utf8")).toContain("survived");
    });

    it("⑤ 已结束的命令转后台要如实拒绝（别假装转成功再补一条「其实早结束了」）", async () => {
        const { run, ctl } = startForeground("echo done-quickly");
        await run;
        expect(ctl.ended()).toBe(true);
        await expect(async () => reg.adopt({ process: ctl, command: "echo done-quickly", cwd: root })).rejects.toThrow(
            "命令已结束",
        );
        // 拒绝时不许留下半只 run
        expect(reg.list()).toHaveLength(0);
    });

    it("⑤ 连按两次：第二次说「已转后台」，且表里只有一条", async () => {
        const { ctl } = startForeground("sleep 0.4", { timeoutMs: 20_000 });
        const info = await reg.adopt({ process: ctl, command: "sleep 0.4", cwd: root });
        expect(() => ctl.handoff(() => undefined)).toThrow("已转后台");
        expect(reg.list()).toHaveLength(1);
        await reg.wait(info.id, 10_000);
    });

    it("⑥ 通知里能 tail 到**最后一行**（收口先等写链落干净，再发插话）", async () => {
        const notes: string[] = [];
        reg.setNotifier((_taskUri, text) => notes.push(text));
        const { ctl } = startForeground("echo first; sleep 0.2; echo last-line", { timeoutMs: 20_000 });
        await sleep(100);
        const info = await reg.adopt({ process: ctl, command: "echo first; sleep 0.2; echo last-line", cwd: root, origin });
        await reg.wait(info.id, 10_000);
        await sleep(50); // notify 是异步的
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain("last-line");
    });

    it("并发写入不撕行：转后台后 20 行按顺序落盘（一半在缓冲、一半在写链上）", async () => {
        // 每行之间 10ms：转之前收下前几行、转之后剩下十几行走写链 —— 两条路拼起来仍必须是 1..20
        const cmd = "for i in $(seq 1 20); do echo line$i; sleep 0.01; done";
        const { ctl } = startForeground(cmd, { timeoutMs: 20_000 });
        const info = await reg.adopt({ process: ctl, command: cmd, cwd: root });
        await reg.wait(info.id, 10_000);
        const lines = readFileSync(info.logPath, "utf8").trim().split("\n");
        expect(lines).toEqual(Array.from({ length: 20 }, (_, i) => `line${i + 1}`));
    });

    it("时长按命令真正起跑算（转后台的那一刻不是起点）", async () => {
        const { ctl } = startForeground("sleep 0.3", { timeoutMs: 20_000 });
        await sleep(150);
        const info = await reg.adopt({ process: ctl, command: "sleep 0.3", cwd: root });
        expect(Date.now() - info.startedAt).toBeGreaterThanOrEqual(140);
        await reg.wait(info.id, 10_000);
    });
});
