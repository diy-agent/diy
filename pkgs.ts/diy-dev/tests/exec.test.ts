/**
 * exec.test.ts — runStreaming / runBuffered 单测（PATH 注入假 git 脚本）
 *
 * 假 git 是可控时序的 shell 脚本（先输出再静默 / sleep 超时 / 打印环境变量），
 * 比真实 clone 确定性高且完全离线。覆盖：
 *   - 流式增量：首个 onData 明显早于进程结束（不等命令结束）
 *   - 心跳：stderr 静默触发 onIdle；stdout 持续输出抑制 onIdle（190 修正 2：输出活动判据）
 *   - 超时分级：短命令 timeoutMs 到点被杀；缺省不超时（clone 严禁硬超时）
 *   - GIT_TERMINAL_PROMPT=0 统一注入
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStreaming, runBuffered, gitEnv } from "../src/git/exec";

let fakeBin: string;
const savedPath = process.env.PATH;

beforeAll(() => {
    fakeBin = mkdtempSync(join(tmpdir(), "execfake-"));
});

afterAll(() => {
    process.env.PATH = savedPath;
    rmSync(fakeBin, { recursive: true, force: true });
});

/** 写一个假 git 脚本（覆盖上一个），并把 fakeBin 注入 PATH（保留真 PATH 供脚本用 sleep/echo） */
function writeGit(script: string): void {
    const p = join(fakeBin, "git");
    rmSync(p, { force: true });
    writeFileSync(p, `#!/bin/sh\n${script}`, "utf-8");
    chmodSync(p, 0o755);
}

/** 本次调用用的 env：fakeBin 优先，其余保持真环境 */
function fakeEnv(): Record<string, string> {
    return { PATH: `${fakeBin}:${savedPath}` };
}

describe("runStreaming", () => {
    it("流式增量：输出到达即回调，不等命令跑完", async () => {
        // 判据只用「回调间隔 vs 脚本 sleep 时长」，不依赖机器启动速度：
        // 旧 spawnSync 是收尾一次性 dump（两次回调间隔 ≈ 0），流式执行器间隔 ≈ sleep
        writeGit(`echo "out-line"\necho "first" >&2\nsleep 1.2\necho "second" >&2\n`);
        const chunks: string[] = [];
        let firstAt = 0;
        let secondAt = 0;
        const res = await runStreaming([], {
            env: fakeEnv(),
            onData: (c) => {
                chunks.push(c);
                if (firstAt === 0) firstAt = Date.now();
                else if (secondAt === 0) secondAt = Date.now();
            },
        });
        const tEnd = Date.now();
        expect(res.ok).toBe(true);
        expect(chunks.length).toBeGreaterThanOrEqual(2); // 分两次到达，非一次性 dump
        expect(chunks.join("")).toContain("first");
        expect(chunks.join("")).toContain("second");
        expect(res.stdout).toContain("out-line"); // stdout 同时收集
        expect(secondAt - firstAt).toBeGreaterThan(900); // ≈ sleep 1.2s
        expect(tEnd - secondAt).toBeLessThan(900); // second 已到末尾，之后很快退出
    });

    it("心跳：stderr 静默 ≥ heartbeatMs 触发 onIdle，携带静默时长", async () => {
        writeGit(`echo "x" >&2\nsleep 0.8\necho "y" >&2\n`);
        const idles: number[] = [];
        const res = await runStreaming([], {
            env: fakeEnv(),
            heartbeatMs: 150,
            onIdle: (ms) => idles.push(ms),
        });
        expect(res.ok).toBe(true);
        // 0.8s 静默、150ms 节拍 → 至少 3 次；恢复输出后（close 前）不再误触发收敛于次数上界
        expect(idles.length).toBeGreaterThanOrEqual(3);
        for (const ms of idles) expect(ms).toBeGreaterThanOrEqual(150);
        expect(idles.length).toBeLessThanOrEqual(8);
    });

    it("心跳判据是输出活动：stdout 持续输出期间不触发（190 修正 2）", async () => {
        writeGit(`i=0\nwhile [ $i -lt 14 ]; do echo "tick$i"; i=$((i+1)); sleep 0.1; done\n`);
        const idles: number[] = [];
        const res = await runStreaming([], {
            env: fakeEnv(),
            heartbeatMs: 1000, // 静默阈值 1000ms ≫ 输出间隔 100ms（也覆盖首行前的 shell 启动抖动）
            onIdle: (ms) => idles.push(ms),
        });
        expect(res.ok).toBe(true);
        expect(idles).toHaveLength(0); // stdout 也算活动 → 不该有停滞提示
    });

    it("超时分级：timeoutMs 到点杀进程，timedOut/ok 标记正确", async () => {
        writeGit(`exec sleep 10\n`);
        const t0 = Date.now();
        const res = await runStreaming([], { env: fakeEnv(), timeoutMs: 200 });
        const elapsed = Date.now() - t0;
        expect(res.timedOut).toBe(true);
        expect(res.ok).toBe(false);
        expect(elapsed).toBeLessThan(3000);
    });

    it("缺省无硬超时：慢命令跑完仍成功（clone 严禁加超时的取舍）", async () => {
        writeGit(`exec sleep 1.2\n`);
        const res = await runStreaming([], { env: fakeEnv() }); // 不传 timeoutMs
        expect(res.ok).toBe(true);
        expect(res.timedOut).toBe(false);
    }, 5000);

    it("统一注入 GIT_TERMINAL_PROMPT=0", async () => {
        writeGit(`echo "P=$GIT_TERMINAL_PROMPT"\n`);
        const res = await runStreaming([], { env: fakeEnv() });
        expect(res.stdout.trim()).toBe("P=0");
    });

    it("非零退出：ok=false，stderr 收集", async () => {
        writeGit(`echo "boom" >&2\nexit 3\n`);
        const res = await runStreaming([], { env: fakeEnv() });
        expect(res.ok).toBe(false);
        expect(res.code).toBe(3);
        expect(res.stderr).toContain("boom");
    });
});

describe("runBuffered", () => {
    it("缓冲成功：stdout/stderr 分开收集", () => {
        writeGit(`echo "out"\necho "err" >&2\n`);
        const res = runBuffered([], { env: fakeEnv() });
        expect(res.ok).toBe(true);
        expect(res.timedOut).toBe(false);
        expect(res.stdout.trim()).toBe("out");
        expect(res.stderr.trim()).toBe("err");
    });

    it("timeoutMs 到点被杀（ls-remote 15s 分级的机制）", () => {
        writeGit(`exec sleep 10\n`);
        const t0 = Date.now();
        const res = runBuffered([], { env: fakeEnv(), timeoutMs: 200 });
        expect(res.timedOut).toBe(true);
        expect(res.ok).toBe(false);
        expect(Date.now() - t0).toBeLessThan(3000);
    });

    it("非零退出透传 code 与 stderr", () => {
        writeGit(`echo "fatal: not found" >&2\nexit 128\n`);
        const res = runBuffered([], { env: fakeEnv() });
        expect(res.ok).toBe(false);
        expect(res.code).toBe(128);
        expect(res.stderr).toContain("fatal: not found");
        expect(res.timedOut).toBe(false);
    });

    it("统一注入 GIT_TERMINAL_PROMPT=0", () => {
        writeGit(`echo "P=$GIT_TERMINAL_PROMPT"\n`);
        const res = runBuffered([], { env: fakeEnv() });
        expect(res.stdout.trim()).toBe("P=0");
    });
});

describe("gitEnv", () => {
    it("extra 并入且 GIT_TERMINAL_PROMPT 恒为 0", () => {
        const env = gitEnv({ FOO: "1" });
        expect(env.FOO).toBe("1");
        expect(env.GIT_TERMINAL_PROMPT).toBe("0");
        expect(env.PATH).toBeTruthy();
    });
});
