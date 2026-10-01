// tests/core/local-agent-active-turn.test.ts
// 🎯 活跃轮次（runtime-context 的 activeTurns）**不留僵尸** —— 起手就抛错也必须注销
//
// 为什么这条重要：UI 现在把 `agent.local.running`（读的就是 activeTurns）当作运行态真值。
// 以前僵尸条目只影响"崩溃现场"的可读性；现在它会表现为
// 「界面永远显示生成中 + 停止按钮点了没反应」—— 用户只能重启。
//
// 触发方式：让 runTurn 的**前半段**（装配系统上下文，在 try{streamText} 之外）抛错。
// 手法是拿一个**目录**冒充 AGENTS.md：existsSync 通过、readFileSync 抛 EISDIR。
// 这正是 closeTurn 覆盖不到的路径（它在 try/finally 里），所以只能靠 chat() 的兜底。

import { describe, it, expect, beforeAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { LocalAgentManager } from "../../src/main/services/local-agent";
import { activeTurnList } from "../../src/main/services/runtime-context";

beforeAll(() => {
    process.env["OPENCODE_ZEN_API_KEY"] = "test-key"; // 只是让 chat 入口的校验通过；本用例不会真发请求
});

describe("活跃轮次不留僵尸", () => {
    it("runTurn 起手抛错（装配系统上下文失败）：轮次仍被注销", async () => {
        const workDir = join(diyHome(), "active-turn-probe");
        const pid = createProject(workDir);
        const uri = createTask({ title: "僵尸轮次探针", project: pid });

        // 用目录冒充 AGENTS.md → assembleSystem 的 readFileSync 抛 EISDIR
        const fakeAgents = join(workDir, "AGENTS.md");
        rmSync(fakeAgents, { recursive: true, force: true });
        mkdirSync(fakeAgents, { recursive: true });
        try {
            const mgr = new LocalAgentManager();
            let threw = false;
            try {
                for await (const _op of mgr.chat(uri, "你好")) {
                    /* 起手就该失败，不该真的产出 op */
                }
            } catch {
                threw = true;
            }
            // 先确认探针真的走到了"抛错"这条路上（否则本用例什么都没测到）
            expect(threw, "注入应让 runTurn 起手抛错").toBe(true);
            // 关键断言：抛错也必须注销 —— 否则 UI 永远显示生成中且停止无效
            expect(activeTurnList().filter((t) => t.taskUri === uri)).toEqual([]);
        } finally {
            rmSync(fakeAgents, { recursive: true, force: true });
        }
    });
});
