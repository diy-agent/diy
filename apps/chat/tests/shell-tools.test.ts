// tests/shell-tools.test.ts
// 🎯 ##515 第 2 步：bot 装上 shell 工具后**真跑三条判据**（不是只看 schema）。
//
// 判据（用户 2026-11-04 定）：
//   ① 普通命令能跑通（`ls` / `pwd`）
//   ② `timeout: 1000` 的 `sleep 5` ⇒ 返回 partial + `timed_out: true`，**不抛**
//   ③ `cat` 不挂住（stdin 是 /dev/null，立刻 EOF）
//
// 另外钉两条装配事实：bot 的工具集**没有 background**（job 账本归 diy-app，第 3 步再评估）；
// shell 工具与 read / write / edit 同一张表里共存（重名会抛）。

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectShells, shellToolName } from "@diy-agent/tools";
import { botToolsFor } from "../index.js";

const spec = detectShells()[0];
const name = spec ? shellToolName(spec) : "bash";

/** 直接调工具的 execute（bot 也是这么调的：入参 + toolCallId） */
async function run(cwdTools: ReturnType<typeof botToolsFor>, input: Record<string, unknown>): Promise<string> {
    const tool = cwdTools.tools[name] as { execute?: (i: unknown, o: unknown) => Promise<unknown> } | undefined;
    expect(tool?.execute, `bot 工具集里没有 ${name}`).toBeTypeOf("function");
    return String(await tool!.execute!(input, { toolCallId: `t-${Math.random().toString(36).slice(2)}` }));
}

describe("bot 的 shell 工具（##515 判据，真跑）", () => {
    it.skipIf(!spec)("① 普通命令能跑通（cwd = bot 自己的工作目录）", async () => {
        const home = mkdtempSync(join(tmpdir(), "t515-bot-home-"));
        writeFileSync(join(home, "probe.txt"), "x");
        const bt = botToolsFor(home, "b1");
        try {
            const out = await run(bt, { command: "pwd; ls" });
            expect(out.startsWith("---\n")).toBe(true); // YAML 头
            expect(out).toContain("ok: true");
            expect(out).toContain(bt.cwd); // 跑在 bot 自己的工作目录里
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    }, 20_000);

    it.skipIf(!spec)("② timeout: 1000 的 sleep 5 ⇒ partial + timed_out: true，且**不抛**", async () => {
        const home = mkdtempSync(join(tmpdir(), "t515-bot-home-"));
        const bt = botToolsFor(home, "b1");
        try {
            const t0 = Date.now();
            const out = await run(bt, { command: "printf 'partial-out\\n'; sleep 5", timeout: 1000 });
            expect(Date.now() - t0).toBeLessThan(4_000);
            expect(out).toContain("timed_out: true");
            expect(out).toContain("partial-out"); // 已收到的输出不许丢
            expect(out).toContain("[命令超时被杀]");
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    }, 20_000);

    it.skipIf(!spec)("③ cat 不挂住（stdin 接 /dev/null）", async () => {
        const home = mkdtempSync(join(tmpdir(), "t515-bot-home-"));
        const bt = botToolsFor(home, "b1");
        try {
            const t0 = Date.now();
            const out = await run(bt, { command: "cat; echo after-cat" });
            expect(Date.now() - t0).toBeLessThan(3_000);
            expect(out).toContain("after-cat");
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    }, 20_000);

    it("装配事实：bot 的 shell 工具**有 background**（##515 3b 接了 jobs），且 job 工具同在表里", () => {
        const home = mkdtempSync(join(tmpdir(), "t515-bot-home-"));
        try {
            const bt = botToolsFor(home, "b1");
            const tool = bt.tools[name] as unknown as { inputSchema?: { shape?: Record<string, unknown> }; description: string };
            expect(Object.keys(tool.inputSchema?.shape ?? {})).toEqual(["command", "timeout", "background"]);
            expect(tool.description).toContain("不要轮询");
            // read / write / edit / job 与 shell 共存（重名会在 buildTools 里抛，能到这里就是没重）
            expect(Object.keys(bt.tools)).toEqual(expect.arrayContaining(["read", "write", "edit", "job", name]));
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
});
