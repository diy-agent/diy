// tests/shell-tool.test.ts
// 🎯 ##515 第 1 步：`makeShellTool` 搬包之后——**工具语义在包内，宿主只挂账**。
//
// 这里钉四件事：
//   ① 前台执行把 runBash 的结果原样回给模型（YAML 头 + 正文）
//   ② 失败（有 stderr 的非零退出）必须**抛**（SDK 才会发 tool-error → UI 画 ✗ 且展开）
//   ③ 宿主没给 background 时：**参数与描述里那一句都不出现**（不告诉模型一个必然失败的选择）
//   ④ 宿主切面按顺序被调：audit(bash-start) → onSpawn → audit(bash-end) → onEnd

import { describe, it, expect } from "vitest";
import { makeShellTool, FALLBACK_SHELL, type ShellAuditEvent, type ShellCallInfo } from "../src/index.js";

/** 直接调工具的 execute（绕开 SDK）：入参与 ai-sdk 的 execute 同形 */
type Executable = {
    execute: (input: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
    inputSchema: { shape: Record<string, unknown> };
    description: string;
};

describe("makeShellTool（搬包后的工具语义，##515）", () => {
    it("① 前台执行：结果原样回给模型", async () => {
        const tool = makeShellTool(FALLBACK_SHELL, {
            cwd: process.cwd(),
            limits: { bashTimeoutMs: 5_000 },
        }) as unknown as Executable;

        const out = String(await tool.execute({ command: "echo hello-shell" }));
        expect(out.startsWith("---\n")).toBe(true);
        expect(out).toContain("hello-shell");
        expect(out).toContain("ok: true");
    });

    it("② 失败必须抛（不能 return 成正常结果）", async () => {
        const tool = makeShellTool(FALLBACK_SHELL, {
            cwd: process.cwd(),
            limits: { bashTimeoutMs: 5_000 },
        }) as unknown as Executable;

        await expect(tool.execute({ command: "echo boom >&2; exit 4" })).rejects.toThrow(/boom/);
    });

    it("③ 没有 background 能力：schema 不含 background，描述里也不提", () => {
        const tool = makeShellTool(FALLBACK_SHELL, {
            cwd: process.cwd(),
            limits: { bashTimeoutMs: 1_000 },
        }) as unknown as Executable;

        expect(Object.keys(tool.inputSchema.shape)).toEqual(["command", "timeout"]);
        expect(tool.description).not.toContain("background: true");
    });

    it("③b 有 background 能力：参数与描述都在（文案照搬，不缩写）", () => {
        const tool = makeShellTool(FALLBACK_SHELL, {
            cwd: process.cwd(),
            limits: { bashTimeoutMs: 1_000 },
            background: async () => "[已转后台] r-test",
        }) as unknown as Executable;

        expect(Object.keys(tool.inputSchema.shape)).toContain("background");
        expect(tool.description).toContain("不要轮询");
        expect(tool.description).toContain("stdin 已接 /dev/null");
    });

    it("④ 宿主切面按顺序被调（audit / onSpawn / onEnd）", async () => {
        const events: string[] = [];
        const calls: ShellCallInfo[] = [];
        const tool = makeShellTool(FALLBACK_SHELL, {
            cwd: process.cwd(),
            limits: { bashTimeoutMs: 5_000 },
            audit: (e: ShellAuditEvent) => events.push(e.phase),
            onSpawn: (_pid, call) => calls.push(call),
            onEnd: (info) => events.push(`end:${info.pid !== undefined}:${info.toolCallId ?? ""}`),
        }) as unknown as Executable;

        await tool.execute({ command: "echo audit" }, { toolCallId: "call-1" });
        // 顺序与 diy-app 原实现一致：先摘登记（finally），再落 bash-end 审计
        expect(events[0]).toBe("bash-start");
        expect(events[1]).toBe("end:true:call-1");
        expect(events[2]).toBe("bash-end");
        expect(calls[0]?.toolCallId).toBe("call-1");
    });

    it("④b 宿主的 effectiveArgs 生效（与聊天显示同源）", async () => {
        let seen: unknown;
        const tool = makeShellTool(FALLBACK_SHELL, {
            cwd: process.cwd(),
            limits: { bashTimeoutMs: 5_000 },
            effectiveArgs: (raw) => {
                seen = raw;
                return { command: raw.command, timeout: 0, background: false };
            },
        }) as unknown as Executable;

        await tool.execute({ command: "true", timeout: 1500 });
        expect(seen).toEqual({ command: "true", timeout: 1500 });
    });
});
