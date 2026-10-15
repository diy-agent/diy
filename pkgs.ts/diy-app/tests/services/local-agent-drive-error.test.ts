// tests/services/local-agent-drive-error.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 R5（##305 review2 转出 → ##308 收口）：**无订阅者时驱动异常不许静默**
//
// 缺口原文：`driveTurn` 的异常只写进 `run.error`，由 `chat()` 在流尾 `throw` 上抛 ——
// 消费端早走了（传输断开 / 页面关了）时，那次 `throw` 落在一个已经 return 的生成器上，
// 于是**一个真实的驱动故障在日志里一片空白**（违反 rule.no-silent-catch）。
//
// 修法：在 `driveTurn` 的 catch 里判 `run.subs.size === 0` 就 `console.error` 一次。
// ⚠️ 判据必须用**那一刻**的 `run.subs`：finally 里会 `run.subs.clear()`，
// 等到 `chat()` 那边再看就恒为空（人人都成"无订阅者"）—— 本用例正是钉这一点：
// 先把订阅摘掉，再让驱动撞上异常，必须留下日志。
//
// 手法：同 `local-agent-active-turn.test.ts` —— 拿**目录**冒充 AGENTS.md 让装配期抛 EISDIR。
// `signal` 是 chat() 的第五参（RPC 传输层的等价物）：abort 它 = 消费端当场断开（订阅同步摘除）。
// 无网络、无 Electron。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager } from "../../src/main/services/local-agent";

beforeAll(() => {
    process.env["OPENCODE_API_KEY"] = "test-key"; // 只为过 chat 入口校验；装配期就抛，不会真发请求
});

describe("驱动异常的可观测性（R5）", () => {
    it("无人订阅时驱动异常显式上报（不许静默吞）", async () => {
        const workDir = join(diyHome(), "drive-error-probe");
        const pid = createProject(workDir);
        const uri = createTask({ title: "驱动异常探针", project: pid });
        const fakeAgents = join(workDir, "AGENTS.md");
        rmSync(fakeAgents, { recursive: true, force: true });
        mkdirSync(fakeAgents, { recursive: true });
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const mgr = new LocalAgentManager();
            const ctrl = new AbortController();
            const it = mgr.chat(uri, "你好", undefined, undefined, ctrl.signal)[Symbol.asyncIterator]();
            const first = it.next(); // 起流：此刻订阅（run.subs）已挂上
            ctrl.abort(); // 消费端当场断开（= RPC 传输层挂断，withCleanup 同步摘除订阅）
            // 消费端看到的是"流断了"（可能 reject，也可能空流退出）—— 都无妨，本用例看的是日志
            await first.then(
                () => undefined,
                () => undefined,
            );
            await new Promise((r) => setTimeout(r, 30)); // 等驱动自己撞上装配期异常

            const logged = errSpy.mock.calls.some((c) => String(c[0]).includes("无人订阅"));
            expect(logged, `驱动异常在无订阅者时必须落日志；实际 console.error 调用：${JSON.stringify(errSpy.mock.calls)}`).toBe(
                true,
            );
        } finally {
            errSpy.mockRestore();
            rmSync(fakeAgents, { recursive: true, force: true });
        }
    });
});
