// tests/core/flow-runner.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 驱动环里**不依赖 Electron** 的那几件（##341）：结论判据 / turn 消息装配 / 执行者取法 / 事实预热。
//
// 判据为什么值得单独钉住：
//   · **打回判据**（`verdictOf`）决定工作流「这一轮过不过」——它是本任务里唯一由**自然语言**翻译成
//     领域动作的地方，猜错一次就是静默放行或无限打回，必须逐条钉死（末行 / 缺标记 / 正文里有「打回」）；
//   · **turn 消息**是 agent 唯一的输入契约：少一段（上游产物）agent 就看不见前面发生了什么，
//     少「交付约定」就永远拿不到结论 —— 这两件都不是「跑一遍看看」能稳定发现的。
// E2E（真 Electron + 桩上游）在 `tests/cli.intent.flow-run.test.ts`。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { advanceFlow, putArtifact, showFlow, startFlow } from "../../src/main/core/flow";
import type { FlowView } from "../../src/main/core/flow";
import { composeTurnMessage, routeOf, verdictOf } from "../../src/main/services/flow-runner";
import { collectFacts, createRenderRegistry } from "../../src/main/workflows/plugins";
import type { PluginContext } from "@diy-agent/flow";
import { DEV_WORKFLOW } from "../../src/main/workflows/dev";
import { executorOf } from "../../src/main/workflows";

function freshTask(name: string): string {
    const uri = `projects/8/tasks/${name}`;
    mkdirSync(join(process.env["DIY_HOME"]!, uri), { recursive: true });
    writeFileSync(join(process.env["DIY_HOME"]!, uri, "AGENTS.md"), `---\ntitle: ${name}\nstate: pending\n---\n`, "utf-8");
    return uri;
}

describe("打回判据：末行约定（##341）", () => {
    it("末行「结论：通过」⇒ 推进；「结论：打回（原因）」⇒ 打回并带出原因", () => {
        expect(verdictOf("做完了。\n结论：通过")).toEqual({ kind: "pass", reason: "" });
        expect(verdictOf("P0 未落点。\n结论：打回（P0 未落点）")).toEqual({ kind: "bounce", reason: "P0 未落点" });
        expect(verdictOf("结论：打回")).toEqual({ kind: "bounce", reason: "" });
    });

    it("认定的是**末行**：正文里出现「打回」不算（否则一句「不需要打回」就被读反）", () => {
        expect(verdictOf("这一轮不需要打回任何东西。\n结论：通过")).toEqual({ kind: "pass", reason: "" });
        expect(verdictOf("结论：打回（P1）\n（以上）")).toEqual({ kind: "pass", reason: "" }); // 打回那行不在末行 ⇒ 按通过
    });

    it("读不到约定 ⇒ 按**通过**（不误打回、不会打出死循环）", () => {
        expect(verdictOf("我改完了，没啥问题")).toEqual({ kind: "pass", reason: "" });
        expect(verdictOf("")).toEqual({ kind: "pass", reason: "" });
    });
});

describe("turn 消息装配（##341）：agent 的输入契约", () => {
    it("五段齐：角色 / 节点（含插值后的提示）/ 上游（折线 + 上游产物）/ 本步产物 / 交付约定", () => {
        const uri = freshTask("turn-msg");
        startFlow(uri, "dev");
        advanceFlow(uri, "clarify");
        putArtifact(uri, "clarify", "澄清结论：需求是「把导入修好」");
        advanceFlow(uri, "design");
        const msg = composeTurnMessage(uri, showFlow(uri), { kind: "agent", agent: "设计 agent", role: "你是设计 agent。" });

        expect(msg).toContain("【角色】你是设计 agent。");
        expect(msg).toContain("【当前节点】开发工作流 · 设计（design）");
        expect(msg).toContain("【本步要求】产出方案与边界");
        expect(msg).toContain("- clarify#1（推进）"); // 折线
        expect(msg).toContain("澄清结论：需求是「把导入修好」"); // **上游产物**（少这一段 agent 就是瞎的）
        expect(msg).toContain("【本步产物】方案与边界（纯文本）"); // 交付形状来自节点 `art.raw`
        expect(msg).toContain("结论：通过"); // 交付约定（判据的机器可读面）
    });

    it("上游产物袋坏 ⇒ 只提示、不拖垮本轮（产物不是领域态）", () => {
        const uri = freshTask("turn-broken-bag");
        startFlow(uri, "dev");
        advanceFlow(uri, "clarify");
        const bagDir = join(process.env["DIY_HOME"]!, uri, "flow", "artifacts");
        mkdirSync(bagDir, { recursive: true });
        writeFileSync(join(bagDir, "clarify.json"), "{ 坏 JSON", "utf-8");
        advanceFlow(uri, "design");
        const msg = composeTurnMessage(uri, showFlow(uri), { kind: "agent", agent: "设计 agent", role: "" });
        expect(msg).toContain("产物袋读不出");
        expect(msg).toContain("【交付约定】");
    });
});

describe("分类与优先级（##341 review1 P3-1）：`human` 压过一切自动推", () => {
    /** 只关心 `next.mode` 与执行者的分类，其余字段不参与判据 */
    const view = (mode: "entry" | "actor" | "system"): FlowView => ({ next: { mode } }) as unknown as FlowView;
    const agentExec = { kind: "agent", agent: "开发 agent", role: "" } as const;

    it("`actor: human` **且**守卫可观测（mode=system）⇒ 仍是 human（自推 = 没有审批点）", () => {
        expect(routeOf(view("system"), { kind: "human" }).kind).toBe("human");
        expect(routeOf(view("actor"), { kind: "human" }).kind).toBe("human");
    });

    it("其余三分流照旧：system 模式求值自推 · `actor: system` 落 actor 模式 ⇒ 停住 · agent 起轮", () => {
        expect(routeOf(view("system"), agentExec).kind).toBe("system");
        expect(routeOf(view("actor"), { kind: "system" }).kind).toBe("inert-system");
        const r = routeOf(view("actor"), agentExec);
        expect(r.kind).toBe("agent");
        expect(r.kind === "agent" && r.exec).toBe(agentExec); // agent 那一支带出收窄后的执行者
    });
});

describe("执行者取法（##341）：表里声明优先，缺项按 actor 兜底", () => {
    it("dev 的表命中（开发 / 评审 是**两个**执行者）；未知定义按 actor 推导", () => {
        expect(executorOf("dev", "implement", "agent")).toMatchObject({ kind: "agent", agent: "开发 agent" });
        expect(executorOf("dev", "review", "agent")).toMatchObject({ kind: "agent", agent: "评审 agent" });
        expect(executorOf("dev", "approve", "human")).toEqual({ kind: "human" });
        expect(executorOf("dev", "merge", "system")).toEqual({ kind: "system" });
        expect(executorOf("nope", "whatever", "human")).toEqual({ kind: "human" });
        expect(executorOf("nope", "whatever", "agent")).toMatchObject({ kind: "agent" });
    });
});

describe("事实预热（##341）：异步取、同步读", () => {
    const ctxOf = (nodeId: string, params: Record<string, unknown>): PluginContext => ({
        workflow: DEV_WORKFLOW,
        node: DEV_WORKFLOW.nodes.find((n) => n.id === nodeId)!,
        params,
        actor: "system",
    });

    it("按 guard 里的插件名取事实；`cwd` 透传给命令；缺项（其它插件名）不掺和", async () => {
        const calls: Array<[string, string]> = [];
        const facts = await collectFacts(ctxOf("ci", { ci: { command: "echo hi" } }), {
            cwd: "/tmp/x",
            runCommand: async (command, cwd) => {
                calls.push([command, cwd]);
                return { code: 0, output: "hi" };
            },
        });
        expect(calls).toEqual([["echo hi", "/tmp/x"]]);
        expect(facts.map((f) => f.name)).toEqual(["ci_green"]);
        expect(facts[0]!.fact).toEqual({ command: "echo hi", code: 0, output: "hi" });
    });

    it("`action:pr_mergeable`：默认**只查不合**；`apply=true` 才真动手（且动手结果进事实）", async () => {
        let merged = 0;
        const deps = {
            runCommand: async (command: string) => ({ code: 0, output: command.includes("view") ? "MERGEABLE" : "" }),
            mergePr: async () => {
                merged += 1;
                return { code: 0, output: "merged" };
            },
        };
        const look = await collectFacts(ctxOf("merge", { merge: { command: "gh pr view --json mergeable -q .mergeable", apply: false } }), deps);
        expect(look[0]!.fact).toMatchObject({ code: 0, output: "MERGEABLE" });
        expect(look[0]!.fact.applied).toBeUndefined();
        expect(merged).toBe(0); // 默认不合：一个默认值不该替人合掉真实 PR

        const doIt = await collectFacts(ctxOf("merge", { merge: { command: "gh pr view --json mergeable -q .mergeable", apply: true } }), deps);
        expect(doIt[0]!.fact.applied).toBe(true);
        expect(merged).toBe(1);
    });
});

describe("render 插件：`records` 收「一行一条」文本（##341 补）", () => {
    it("纯文本 ⇒ 一行一条 cell；空行丢掉；空串 ⇒ 空表", () => {
        const records = createRenderRegistry().resolve("render", "records");
        const view = records("P0 未落点\n\nP1 缺测试\n", { type: "node", data: { nodeId: "review" } });
        expect(view).toEqual({
            renderer: "table",
            payload: { rows: [{ cells: ["P0 未落点"] }, { cells: ["P1 缺测试"] }] },
        });
        expect(records("", { type: "node", data: { nodeId: "review" } })).toEqual({ renderer: "table", payload: { rows: [] } });
    });

    it("结构化两种 raw 照旧（裸数组 / { columns, rows }），别的形状照旧当场拒", () => {
        const records = createRenderRegistry().resolve("render", "records");
        expect(records([{ 项: "落点" }], { type: "node", data: { nodeId: "review" } })).toEqual({
            renderer: "table",
            payload: { rows: [{ cells: ["落点"] }] },
        });
        expect(() => records(42, { type: "node", data: { nodeId: "review" } })).toThrow(/一行一条/);
    });
});
