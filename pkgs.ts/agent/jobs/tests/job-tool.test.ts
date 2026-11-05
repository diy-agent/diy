// tests/job-tool.test.ts
// 🎯 ##515 第 3 步：`job` 工具面搬进包之后 —— **动作语义与越权边界不变**。
//
// 钉五件事（真起进程，不 mock）：
//   ① 空表 ⇒ 「（本任务没有后台进程）」
//   ② list 只列 `visible` 认的（越权边界：A 看不见 B 的 run）
//   ③ status / output 取到输出尾巴；缺 id 时给能照办的话
//   ④ kill ⇒ 后续 status 是「已被杀」
//   ⑤ wait 等到结束；等到上限仍未结束则明说「仍未结束，别干等」

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunRegistry, WAIT_MAX_MS, makeJobTool, runDetail } from "../src/node.js";

type Executable = {
    execute: (input: Record<string, unknown>) => Promise<unknown>;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setup(tag: string, taskUri = "t/a") {
    const rootDir = join(mkdtempSync(join(tmpdir(), `t515-tool-${tag}-`)), "runs");
    const registry = new RunRegistry({ rootDir });
    const tool = makeJobTool({ registry, visible: (r) => r.origin?.taskUri === taskUri }) as unknown as Executable;
    return {
        rootDir,
        registry,
        tool,
        run: async (input: Record<string, unknown>): Promise<string> => String(await tool.execute(input)),
        cleanup: (): void => {
            registry.clear();
            rmSync(rootDir, { recursive: true, force: true });
        },
    };
}

describe("makeJobTool（抽包后的工具面，##515 3a）", () => {
    it("① 空表 ⇒ 明确说没有", async () => {
        const s = setup("empty");
        try {
            expect(await s.run({ action: "list" })).toBe("（本任务没有后台进程）");
        } finally {
            s.cleanup();
        }
    });

    it("② list 只列 visible 认的（A 看不见 B 的 run）", async () => {
        const s = setup("scope");
        try {
            await s.registry.spawn({ command: "echo mine", cwd: process.cwd(), origin: { taskUri: "t/a" } });
            await s.registry.spawn({ command: "echo other", cwd: process.cwd(), origin: { taskUri: "t/b" } });
            const text = await s.run({ action: "list" });
            expect(text).toContain("共 1 条");
            expect(text).toContain("echo mine");
            expect(text).not.toContain("echo other");
        } finally {
            s.cleanup();
        }
    });

    it("③ 缺 id 有可照办的提示；status 取到输出尾巴", async () => {
        const s = setup("status");
        try {
            expect(await s.run({ action: "status" })).toContain("[缺 id]");
            const info = await s.registry.spawn({
                command: "printf 's1\\ns2\\n'",
                cwd: process.cwd(),
                origin: { taskUri: "t/a" },
            });
            await s.registry.wait(info.id, 10_000);
            const text = await s.run({ action: "status", id: info.id });
            expect(text).toContain(info.id);
            expect(text).toContain("已结束");
            expect(text).toContain("s2");
            expect(text).toContain(`输出：${info.logPath}`);
        } finally {
            s.cleanup();
        }
    });

    it("③b 看不见的 run 一律当「没有这个进程」（连状态都不泄露）", async () => {
        const s = setup("invisible");
        try {
            const other = await s.registry.spawn({ command: "echo secret", cwd: process.cwd(), origin: { taskUri: "t/b" } });
            await s.registry.wait(other.id, 10_000);
            const text = await s.run({ action: "status", id: other.id });
            expect(text).toContain("[没有这个后台进程]");
            expect(text).not.toContain("secret");
        } finally {
            s.cleanup();
        }
    });

    it("④ kill ⇒ 后续 status 是「已被杀」", async () => {
        const s = setup("kill");
        try {
            const info = await s.registry.spawn({ command: "sleep 30", cwd: process.cwd(), origin: { taskUri: "t/a" } });
            expect(await s.run({ action: "kill", id: info.id })).toContain("已发送停止信号");
            await s.registry.wait(info.id, 10_000);
            expect(await s.run({ action: "status", id: info.id })).toContain("已被杀");
        } finally {
            s.cleanup();
        }
    });

    it("⑤ wait 等到结束（拿终态与尾巴）", async () => {
        const s = setup("wait");
        try {
            const info = await s.registry.spawn({
                command: "sleep 0.15; echo finished",
                cwd: process.cwd(),
                origin: { taskUri: "t/a" },
            });
            const text = await s.run({ action: "wait", id: info.id, timeoutMs: 10_000 });
            expect(text).toContain("已结束");
            expect(text).toContain("finished");
            expect(text).not.toContain("仍未结束");
        } finally {
            s.cleanup();
        }
    });

    it("⑤b 等到上限仍在跑 ⇒ 明说「仍未结束，别干等」", async () => {
        const s = setup("wait-limit");
        try {
            const info = await s.registry.spawn({ command: "sleep 30", cwd: process.cwd(), origin: { taskUri: "t/a" } });
            const text = await s.run({ action: "wait", id: info.id, timeoutMs: 200 });
            expect(text).toContain("仍未结束");
            expect(text).toContain("别干等长任务");
        } finally {
            s.cleanup();
        }
    });

    it("⑥ wait 的上限口径：0 = 10 分钟（不是「永远等」）", async () => {
        expect(WAIT_MAX_MS).toBe(600_000);
        // 详情文案是纯函数：状态 / 结局 / 目录 / 输出路径四行都在
        const text = runDetail(
            {
                id: "r-1",
                command: "ls",
                cwd: "/tmp",
                state: "exited",
                exitCode: 0,
                startedAt: 0,
                endedAt: 1500,
                dir: "/tmp/r-1",
                logPath: "/tmp/r-1/out.log",
            },
            { text: "hi", lines: 1, droppedBytes: 0 },
            2000,
        );
        expect(text).toContain("r-1 · 已结束 · 1.5s");
        expect(text).toContain("命令：ls");
        expect(text).toContain("输出：/tmp/r-1/out.log");
        expect(text).toContain("hi");
    });

    it("⑦ 收尾：等进程真的死透（fork/exec 的生命周期不留残渣）", async () => {
        const s = setup("cleanup");
        try {
            const info = await s.registry.spawn({ command: "sleep 30", cwd: process.cwd(), origin: { taskUri: "t/a" } });
            s.registry.kill(info.id);
            await s.registry.wait(info.id, 10_000);
            await sleep(50);
            expect(s.registry.list().every((r) => r.state !== "running")).toBe(true);
        } finally {
            s.cleanup();
        }
    });
});
