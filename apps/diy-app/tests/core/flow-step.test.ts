// tests/core/flow-step.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 「系统推」的**机器判据**（##341）：`stepFlow` 是 `pred:` / `action:` 求值的唯一落盘口 ——
//    用户要的那条「绿线」（CI 绿 → 自动往下走；红 → 停在边上）就是它。
//
// 为什么这层能钉死它：`stepFlow` 的外部世界走 **deps 注入**（`runCommand` 给个桩就不用真跑命令），
// 而实例的读写在隔离 `DIY_HOME` 里（`tests/setup.ts`）—— 于是**不用起 Electron** 就能把
// 「红不推 / 绿才推 / 停在边上 / 谁推的 / 终态谁置位」全部证成。
// E2E 那侧的同名判据在 `tests/cli.intent.flow-run.test.ts`（真 Electron + 桩上游模型）。
//
// 契约（本文件即契约）：
//   1. 尚未进入 ⇒ `stepFlow` 进入入口（内核 step 的 entry 分支），审计落 `entry`；
//   2. `prompt:` 节点 ⇒ `awaiting-actor`（**一个插件都不调**，更不动状态）；
//   3. `pred:` 不过 ⇒ `stuck`（停在**边上**）、位置**不动**、`path.jsonl` 不加行；
//   4. `pred:` 过 ⇒ 自动 `next`（`author = system`），`path.jsonl` 加一行、`events.jsonl` 加一条；
//   5. 终端节点的系统推 ⇒ `done` **由内核置位**（不是人宣布），`path.jsonl` 落 `finish` 记录；
//   6. 求值事实（命令输出）随回执给驱动方 —— 产物袋里的 CI 日志就是它。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { advanceFlow, showFlow, startFlow, stepFlow } from "../../src/main/core/flow";
import { readAudit } from "../../src/main/core/flow-store";
import { createHostRegistry } from "../../src/main/workflows/plugins";
import { DEV_WORKFLOW } from "../../src/main/workflows/dev";
import type { CommandResult } from "../../src/main/workflows/plugins";

/** 每例一个任务目录（隔离 HOME 在 tests/setup.ts；路径形状 = 数据根下的任务 URI 本身） */
function freshTask(name: string): string {
    const uri = `projects/9/tasks/${name}`;
    mkdirSync(join(process.env["DIY_HOME"]!, uri), { recursive: true });
    writeFileSync(join(process.env["DIY_HOME"]!, uri, "AGENTS.md"), `---\ntitle: ${name}\nstate: pending\n---\n`, "utf-8");
    return uri;
}

/** 桩命令：按命令串给结果（不真跑任何东西 —— 「不真出网」是可证的） */
const stubRun = (results: Record<string, CommandResult>) => async (command: string): Promise<CommandResult> =>
    results[command] ?? { code: 127, output: `桩里没有这条命令：${command}` };

/** 走到 `ci`（六个节点里 system 的那一个） */
function enterToCi(uri: string): void {
    startFlow(uri, "dev");
    advanceFlow(uri, "clarify");
    advanceFlow(uri, "design");
    advanceFlow(uri, "implement");
    advanceFlow(uri, "review");
    advanceFlow(uri, "ci");
}

const CI_CMD = "./sha.sh check";

describe("系统推（##341）：pred: 红则不推、绿才推", () => {
    it("尚未进入 ⇒ 进入入口节点（审计记 entry，author=system）", async () => {
        const uri = freshTask("step-entry");
        startFlow(uri, "dev");
        const r = await stepFlow(uri, {});
        expect(r.status).toBe("moved");
        expect(r.kind).toBe("entry");
        expect(r.to).toBe("clarify");
        expect(showFlow(uri).position).toBe("clarify");
        const audit = readAudit(uri).records;
        expect(audit.at(-1)).toMatchObject({ kind: "entry", from: null, to: "clarify", author: "system" });
    });

    it("`prompt:` 节点 ⇒ awaiting-actor：不动状态、不写审计", async () => {
        const uri = freshTask("step-actor");
        startFlow(uri, "dev");
        advanceFlow(uri, "clarify");
        const before = readAudit(uri).records.length;
        const r = await stepFlow(uri, {});
        expect(r.status).toBe("awaiting-actor");
        expect(r.reason).toMatch(/prompt:requirement_clear/);
        expect(showFlow(uri).position).toBe("clarify");
        expect(readAudit(uri).records.length).toBe(before);
    });

    it("CI 红 ⇒ **不推**（停在边上）、位置不动、增量不加行；事实里带着命令输出", async () => {
        const uri = freshTask("step-red");
        enterToCi(uri);
        const pathBefore = showFlow(uri).trajectory.length;
        const r = await stepFlow(uri, { runCommand: stubRun({ [CI_CMD]: { code: 1, output: "FAIL：类型检查未过" } }) });
        expect(r.status).toBe("stuck");
        expect(r.reason).toMatch(/CI 未绿/);
        expect(r.reason).toMatch(/类型检查未过/);
        expect(showFlow(uri).position).toBe("ci");
        expect(showFlow(uri).trajectory.length).toBe(pathBefore); // 停在边上 = 折线不动
        // 事实随回执给驱动方（`flow run` 据此把 CI 日志落进产物袋）
        expect(r.facts["ci_green"]).toMatchObject({ command: CI_CMD, code: 1 });
    });

    it("CI 绿 ⇒ 自动推到 `approve`（author=system，折线与审计都落盘）", async () => {
        const uri = freshTask("step-green");
        enterToCi(uri);
        const r = await stepFlow(uri, { runCommand: stubRun({ [CI_CMD]: { code: 0, output: "EXIT=0" } }) });
        expect(r.status).toBe("moved");
        expect(r.to).toBe("approve");
        expect(showFlow(uri).position).toBe("approve");
        const audit = readAudit(uri).records;
        expect(audit.at(-1)).toMatchObject({ kind: "next", from: "ci", to: "approve", author: "system" });
        // 注：CI 日志的**落袋**在驱动环（`flow-runner`）里做 —— 这里给的是事实本身
        expect(r.facts["ci_green"]?.["output"]).toBe("EXIT=0");
    });

    it("停在人工审批点：`prompt:` + `actor: human` ⇒ awaiting-actor（环走不动，等人）", async () => {
        const uri = freshTask("step-human");
        enterToCi(uri);
        await stepFlow(uri, { runCommand: stubRun({ [CI_CMD]: { code: 0, output: "绿" } }) });
        const r = await stepFlow(uri, {});
        expect(r.status).toBe("awaiting-actor");
        expect(r.reason).toMatch(/prompt:approved/);
    });

    it("终端节点的系统推：`action:` 过 ⇒ `done` 由内核置位 + `path.jsonl` 落 finish", async () => {
        const uri = freshTask("step-merge");
        enterToCi(uri);
        await stepFlow(uri, { runCommand: stubRun({ [CI_CMD]: { code: 0, output: "绿" } }) });
        advanceFlow(uri, "merge", [], "人工批准");
        const r = await stepFlow(uri, {
            runCommand: stubRun({
                "gh pr view --json mergeable,state -q .mergeable": { code: 0, output: "MERGEABLE" },
            }),
        });
        expect(r.status).toBe("done");
        const view = showFlow(uri);
        expect(view.done).toBe(true);
        expect(view.next.terminal).toBe(true);
        const paths = readAudit(uri).records;
        expect(paths.at(-1)).toMatchObject({ kind: "finish", author: "system" });
        // 幂等：已 done 的实例再推不会重跑 action:（内核 `rule.done-marker`）
        const again = await stepFlow(uri, {
            runCommand: async () => {
                throw new Error("done 之后不许再求值（重跑 action: = 对着外部世界再动一次手）");
            },
        });
        expect(again.status).toBe("done");
    });

    it("PR 不可合并 ⇒ 不推（停在边上）", async () => {
        const uri = freshTask("step-pr-no");
        enterToCi(uri);
        await stepFlow(uri, { runCommand: stubRun({ [CI_CMD]: { code: 0, output: "绿" } }) });
        advanceFlow(uri, "merge", [], "人工批准");
        const r = await stepFlow(uri, {
            runCommand: stubRun({ "gh pr view --json mergeable,state -q .mergeable": { code: 0, output: "CONFLICTING" } }),
        });
        expect(r.status).toBe("stuck");
        expect(showFlow(uri).position).toBe("merge");
    });
});

describe("事实预热（##341）：同步插件只读预热好的事实", () => {
    it("没预热就求值 ⇒ 抛（绝不静默当成「不通过」）", () => {
        const registry = createHostRegistry(); // 不带 facts
        const node = DEV_WORKFLOW.nodes.find((n) => n.id === "ci")!;
        const plugin = registry.resolve("guard", "ci_green");
        expect(() => plugin({ workflow: DEV_WORKFLOW, node, params: {}, actor: "system" })).toThrow(/没有预热/);
    });
});
