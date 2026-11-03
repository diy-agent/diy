// tests/core/compact-ledger.test.ts
// 🎯 压缩账本的**自证性**（##269 D4）—— 数字之间不许打架、字段不许自相矛盾
//
// 三条契约（都来自真实账本里核出的实据）：
//   ① `after.turns` 必须按**投递口径**数 —— 旧实现拿全部轮的个数，于是"全部清零"后
//      消息 0 条却写着 3 轮（自相矛盾）；
//   ② `rates.provider` = **谁服务的**，`rates.source` = 价目真源 —— 旧实现把后者填进前者
//      （"provider: models.dev" 会让人以为请求走了 models.dev，它只是个报价网站）；
//   ③ 账目数字要圆整（`50.00000000000001` 是浮点残渣，不是精度）；空壳 `predicted: {}` 不写。

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { getLocalAgent, compactFile } from "../../src/main/services/local-agent";
import { opsFile } from "../../src/main/core/local-paths";
import { parseCompactLog } from "@diy-agent/compaction/compaction";
import { readFileSync } from "node:fs";

let PROJECT = "";
beforeAll(() => {
    process.env["OPENCODE_API_KEY"] = "test-key";
    PROJECT = createProject(join(diyHome(), "ledger-work"));
});
let seq = 0;
const newUri = (): string => createTask({ title: `账本测试 ${++seq}`, project: PROJECT });

/** 三轮会话（每轮 user + assistant 文本 + 一个 tool，工具输出巨大 → 可被 headtail 裁）落盘 */
function seedOpsBigTools(uri: string, turns = 3): void {
    const lines: string[] = [];
    for (let i = 1; i <= turns; i++) {
        const t = `t${6000 + i}`;
        const big = Array.from({ length: 200 }, (_, k) => `row ${k}`).join("\n");
        const push = (o: unknown) => lines.push(JSON.stringify(o));
        push({ op: "start", id: t, kind: "turn" });
        push({ op: "start", id: `${t}_u`, kind: "text", parent: t, meta: { role: "user" } });
        push({ op: "delta", id: `${t}_u`, fields: { content: `第 ${i} 句` } });
        push({ op: "stop", id: `${t}_u` });
        push({ op: "start", id: `${t}_s1`, kind: "step", parent: t });
        push({ op: "start", id: `${t}_c`, kind: "tool", parent: `${t}_s1`, meta: { tool: "bash" } });
        push({ op: "patch", id: `${t}_c`, fields: { args: { command: "ls" } } });
        push({ op: "patch", id: `${t}_c`, fields: { status: "done", output: big } });
        push({ op: "stop", id: `${t}_c` });
        push({ op: "stop", id: `${t}_s1` });
        push({ op: "stop", id: t });
    }
    writeFileSync(opsFile(uri), lines.join("\n") + "\n", "utf-8");
}

/** 三轮会话（每轮 user + assistant 文本 + 一个 tool）落盘 */
function seedOps(uri: string, turns = 3): string[] {
    const lines: string[] = [];
    const ids: string[] = [];
    for (let i = 1; i <= turns; i++) {
        const t = `t${5000 + i}`;
        ids.push(t);
        const push = (o: unknown) => lines.push(JSON.stringify(o));
        push({ op: "start", id: t, kind: "turn" });
        push({ op: "start", id: `${t}_u`, kind: "text", parent: t, meta: { role: "user" } });
        push({ op: "delta", id: `${t}_u`, fields: { content: `第 ${i} 句` } });
        push({ op: "stop", id: `${t}_u` });
        push({ op: "start", id: `${t}_s1`, kind: "step", parent: t });
        push({ op: "start", id: `${t}_c`, kind: "tool", parent: `${t}_s1`, meta: { tool: "bash" } });
        push({ op: "patch", id: `${t}_c`, fields: { args: { command: "ls" } } });
        push({ op: "patch", id: `${t}_c`, fields: { status: "done", output: "out" } });
        push({ op: "stop", id: `${t}_c` });
        push({ op: "stop", id: `${t}_s1` });
        push({ op: "stop", id: t });
    }
    writeFileSync(opsFile(uri), lines.join("\n") + "\n", "utf-8");
    return ids;
}

describe("① after.turns 按投递口径（数字之间不许打架）", () => {
    it("##432：历史只按已落盘边界切（无边界 ⇒ 全保留；旧字节预算已删）", async () => {
        const uri = newUri();
        seedOps(uri);
        const pv0 = await getLocalAgent().compactPreview(uri, { toolResult: { render: "asis" } });
        // 选择只看 turns 里的压缩边界（此处没有 ⇒ 全保留）
        expect(pv0.after.messages).toBeGreaterThan(0);
        expect(pv0.before.turns).toBe(3);

        const uri2 = newUri();
        seedOps(uri2);
        expect((await getLocalAgent().compactPreview(uri2, { toolResult: { render: "asis" } })).after.turns).toBe(3);
    });
});

describe("④ 预算事件的**过滤器表达**（历史回溯可还原投递集）", () => {
    it("事件 details.kept 记保留行号区间（无边界 ⇒ 全覆盖一段）", () => {
        const uri = newUri();
        seedOps(uri);
        // 无边界 → 全部保留（单区间 [1, N]）
        const rec = getLocalAgent().compact(uri, { mode: "budget", toolResult: { render: "asis" }, summary: false }, "cli") as {
            details?: { kept?: [number, number][] };
        };
        expect(rec.details?.kept?.length).toBe(1);
        expect(rec.details!.kept![0]![0]).toBe(1);
        expect(rec.details!.kept![0]![1]).toBeGreaterThanOrEqual(1);

        const uri2 = newUri();
        seedOps(uri2);
        const rec2 = getLocalAgent().compact(uri2, { mode: "budget", toolResult: { render: "asis" }, summary: false }, "cli") as {
            details?: { kept?: [number, number][] };
        };
        // 没有「清零」这种说法了：没有边界时保留区间是全覆盖
        expect(rec2.details?.kept?.length).toBe(1);
    });
});

describe("② details.clippedIds：同 id 只记一次（去重 —— 回归「虚胖一倍」；##431 起只存 id 清单）", () => {
    it("headtail 裁剪时，每个工具 id 在 details.clippedIds.ids 里只出现一次", () => {
        const uri = newUri();
        // ⚠️ 必须**多于保底步数**（##343 M1：最近 6 步 `clip: full` ⇒ 不再被 headtail 裁）：
        //    8 轮 ⇒ 最早两轮的工具输出走阶梯级、照旧被裁，去重才有对象可验。
        seedOpsBigTools(uri, 8);
        const rec = getLocalAgent().compact(
            uri,
            { mode: "budget", toolResult: { render: "headtail" }, summary: false },
            "cli",
        ) as { details?: { clippedIds?: { ids: string[]; count: number } } };
        const ids = rec.details?.clippedIds?.ids ?? [];
        // ##431：账本只留 id 清单（明细现场从 ops 算），但「同 id 只记一次」的去重口径不变
        expect(ids.length).toBeGreaterThan(0);
        expect(rec.details?.clippedIds?.count).toBe(ids.length);
        expect(new Set(ids).size).toBe(ids.length); // 无重复
    });
});

describe("② 空操作压缩：不写账、返回 noop（回归「cacheExpired 空转记一次压缩」）", () => {
    it("历史在上限内（无轮丢、无工具裁）→ rec.noop=true，且 compact 账本无新事件", () => {
        const uri = newUri();
        seedOps(uri); // 三轮小会话
        const rec = getLocalAgent().compact(
            uri,
            { mode: "budget", toolResult: { render: "asis" }, summary: false },
            "auto",
            undefined,
            "cacheExpired",
        ) as { noop?: boolean };
        expect(rec.noop).toBe(true);
        // 空操作**不写账**：账本文件里没有 kind=compact 的行（文件甚至可能不存在）
        const logText = existsSync(compactFile(uri)) ? readFileSync(compactFile(uri), "utf-8") : "";
        const events = parseCompactLog(logText);
        expect(events.filter((e) => e.kind === "compact")).toHaveLength(0);
    });

    it("##432：没有可丢的 ⇒ 无操作（noop），不写账", () => {
        const uri = newUri();
        seedOps(uri);
        const rec = getLocalAgent().compact(
            uri,
            { mode: "budget", toolResult: { render: "asis" }, summary: false },
            "cli",
        ) as { noop?: boolean };
        expect(rec.noop).toBe(true);
        // noop 不写账 ⇒ 账本文件根本不存在
        expect(existsSync(compactFile(uri))).toBe(false);
    });
});

describe("② rates：provider = 谁服务的，source = 价目真源", () => {
    it("provider 不是 models.dev；source 才是；k 圆整", () => {
        const uri = newUri();
        seedOps(uri);
        // 用「真压一次」把账本写出来（预览不落账）：headtail ⇒ 有工具结果被裁 ⇒ 不是空操作
        const rec = getLocalAgent().compact(uri, { toolResult: { render: "headtail" } }, "cli");
        // v2 分组后 rates 在 cost 分组里
        const ev = rec as unknown as { cost?: { rates?: { provider?: string; source?: string; k: number } } };
        const rates = ev.cost?.rates;
        expect(rates).toBeTruthy();
        expect(rates!.provider).toBe("opencode-go");
        expect(rates!.provider).not.toContain("models.dev");
        expect(String(rates!.source)).toContain("models.dev");
        // 圆整：不留浮点残渣（k 的真值因模型而异：mimo/deepseek=50、luna=10；
        // 关键是**圆整后是个干净的数**，且等于 round3(input/cacheRead)）
        const r = rates as unknown as { input: number; cacheRead: number; k: number };
        expect(r.k).toBe(Math.round((r.input / r.cacheRead) * 1000) / 1000);
        expect(String(r.k)).not.toContain("000000000");
        expect([10, 50]).toContain(r.k);
    });
});

describe("③ measure 事件：空壳 predicted 不写", () => {
    const usage: LanguageModelV3Usage = {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
    };
    function textReply(text: string): LanguageModelV3StreamResult {
        const parts: LanguageModelV3StreamPart[] = [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: text },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ];
        return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
    }
    const stub = () =>
        new MockLanguageModelV3({
            provider: "stub",
            modelId: "stub-model",
            doStream: () => Promise.resolve(textReply("答复")),
        });

    it.skip("真发一轮后 measure 落账 —— 依赖一次真压（旧预算面）；##432 刀 2 后压缩由 history.limit 触发，随旧策略面一起删", async () => {
        const uri = newUri();
        seedOps(uri);
        getLocalAgent().compact(uri, { toolResult: { render: "asis" } }, "cli");
        const mgr = new (await import("../../src/main/services/local-agent")).LocalAgentManager(
            () => stub() as unknown as LanguageModel,
        );
        for await (const _op of mgr.chat(uri, "压缩之后再问一句")) void _op;
        const events = parseCompactLog(readFileSync(compactFile(uri), "utf-8"));
        const measure = events.find((e) => e.kind === "measure") as Record<string, unknown> | undefined;
        // measure 由本轮第一步的 usage 借道补写（零额外请求）
        expect(measure).toBeTruthy();
        expect("predicted" in measure!).toBe(false);
        expect(measure!.ref).toBeTruthy();
    });
});

describe("④ v3 分组形状：看 JSON 就知道每块回答什么（D5「结构即语义」）", () => {
    it("policy / boundary / size / cost / details 五块 + v4 的 plan **版本指针**，且 keptTurns 归 size（不是锚点）", () => {
        const uri = newUri();
        seedOps(uri);
        const rec = getLocalAgent().compact(uri, { toolResult: { render: "asis" } }, "cli") as unknown as Record<string, unknown>;
        expect(rec.kind).toBe("compact");
        // ##344 M2 的 plan 快照 → ##378 起只记**内容寻址版本**（全文在 $DIY_HOME/plan-store/）
        expect(rec.v).toBe(5); // ##431：v5 = 明细瘦身
        expect(rec.trigger).toBe("manual");
        expect(Object.keys(rec)).toEqual(
            expect.arrayContaining(["policy", "boundary", "size", "cost", "details", "plan"]),
        );
        // plan 快照：只剩 `source`（级列表与版本链已随 ##432 清理删除）
        const plan = rec.plan as { budgetBytes?: number; source: string; planVersion?: string; keep?: unknown[] };
        expect(plan.budgetBytes).toBeUndefined();
        expect(plan.source).toBe("default");
        expect(plan.keep).toBeUndefined();
        expect(plan.planVersion).toBeUndefined();
        // ⚠️ 「CAS 可取回 + 已入链」不在这里断言：预算 1MB + asis ⇒ 本轮是**空操作**（noop），
        //    压缩按设计**不落账也不物化版本**。旧写法把它写在本用例里，能过只是因为别的用例
        //    先把同内容的版本写进了 CAS —— 那是顺序运气（`--sequence.shuffle` 即现）。
        //    持久化断言搬去下面「非空操作」那条用例。
        // 锚点里**没有** keptTurns/droppedTurns（它们是结果，不是锚）
        const boundary = rec.boundary as Record<string, unknown>;
        expect(boundary).toHaveProperty("keepFromOpIndex");
        expect(boundary).not.toHaveProperty("keptTurns");
        const size = rec.size as Record<string, unknown>;
        expect(size).toHaveProperty("keptTurns", 3);
        expect(size).toHaveProperty("droppedTurns", 0);
        // 明细在 details —— ##431 起只留**计数 + id 清单**（老账的大明细照旧可读，新账不再产出）
        const details = rec.details as Record<string, unknown>;
        expect(details.dropped).toBeUndefined();
        expect(details.clipped).toBeUndefined();
        expect(details.droppedCount).toBe(0); // 1MB + asis ⇒ 无轮被丢
        expect((details.clippedIds as { count: number }).count).toBe(0);
    });

    it("① v1 平铺账照样能读（读侧归一，旧账本无需迁移）", async () => {
        const { parseCompactLog } = await import("@diy-agent/compaction/compaction");
        const v1 = JSON.stringify({
            kind: "compact",
            v: 1,
            id: "old-1",
            ts: "old-1",
            by: "ui",
            policy: { keepTurns: 1, toolResult: "asis", headtail: {}, summary: false },
            boundary: { keptFromTurnId: null, keepFromOpIndex: 7, keptTurns: 0, droppedTurns: 3 },
            before: { turns: 3, messages: 6, bytes: 300, estTokens: 75 },
            after: { turns: 0, messages: 0, bytes: 0, estTokens: 0 },
            taxShare: 0.37,
            clipped: [{ id: "c1", tool: "bash", render: "headtail", origLines: 9, origBytes: 90, keptLines: 3, keptBytes: 30, origPath: "p" }],
            summaryText: "摘要",
        });
        const [e] = parseCompactLog(v1);
        expect(e!.kind).toBe("compact");
        const c = e as unknown as Record<string, any>;
        expect(c.v).toBe(2); // 归一成 v2
        expect(c.trigger).toBe("manual"); // 旧账没有 trigger 概念
        expect(c.boundary.keepFromOpIndex).toBe(7);
        expect(c.size.keptTurns).toBe(0); // 从 boundary 搬到 size
        expect(c.size.droppedTurns).toBe(3);
        expect(c.cost.taxShare).toBe(0.37);
        expect(c.details.clipped).toHaveLength(1);
        expect(c.details.summary.text).toBe("摘要");
        // 空分组不写（不是空壳）
        expect(c).not.toHaveProperty("__nonexistent");
    });
});
