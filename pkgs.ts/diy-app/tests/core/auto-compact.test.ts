// tests/core/auto-compact.test.ts
// 🎯 自动压缩：配置契约 + 触发判定（##269 D7）—— 纯函数，无网络无 Electron
//
// 核心契约：
//   ① 判据全是**确定事实**（系统上下文变 / 缓存过期 / 窗口超限），不含任何"划不划算"的预测
//      （那正是 230#25 放弃的评估；两者不冲突，别混为一谈）；
//   ② 默认 `notify` —— **不静默改用户的会话**（静默丢历史与 rule.no-silent-catch 同族）；
//   ③ 触发按**紧急度排序**（撞墙最急）；返回数组以便账本如实记下全部理由。

import { describe, it, expect, afterAll } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    DEFAULT_AUTO_COMPACT,
    autoCompactPolicyInput,
    detectAutoCompactTriggers,
    normalizeAutoCompact,
    TRIGGER_TEXT,
    type AutoCompactFacts,
} from "../../src/shared/context/auto-compact";
import { effectiveTtl, ttlBoundsFrom } from "../../src/shared/context/cache-ttl";
import { loadAutoCompact, saveAutoCompact, autoCompactFile } from "../../src/main/core/auto-compact-config";
import { diyHome } from "../../src/main/core/state";
import { normalizePolicy } from "../../src/shared/context/compaction";

const MIN = 60_000;
/** 已知 TTL：(30min, 45min] —— 30 分钟内一定活着，超过 45 分钟一定过期 */
const TTL = effectiveTtl(ttlBoundsFrom([{ gapMs: 30 * MIN, hit: true, samePrefix: true }, { gapMs: 45 * MIN, hit: false, samePrefix: true }]), 60 * MIN);

const facts = (over: Partial<AutoCompactFacts> = {}): AutoCompactFacts => ({
    systemContextChanged: false,
    sinceLastRequestMs: 5 * MIN,
    ttl: TTL,
    windowRatio: 0.3,
    ...over,
});

describe("detectAutoCompactTriggers：确定事实的判定", () => {
    it("默认配置 + 一切正常 → 不触发", () => {
        expect(detectAutoCompactTriggers(facts(), DEFAULT_AUTO_COMPACT)).toEqual([]);
    });

    it("系统上下文变了 → 触发（前缀缓存必作废，此刻压缩零重建代价）", () => {
        expect(detectAutoCompactTriggers(facts({ systemContextChanged: true }), DEFAULT_AUTO_COMPACT)).toEqual([
            "systemContextChanged",
        ]);
    });

    it("缓存**已过期**（超过实测上界 45min）→ 触发；灰区（40min）与活着（10min）都不触发", () => {
        expect(detectAutoCompactTriggers(facts({ sinceLastRequestMs: 46 * MIN }), DEFAULT_AUTO_COMPACT)).toEqual([
            "cacheExpired",
        ]);
        expect(detectAutoCompactTriggers(facts({ sinceLastRequestMs: 40 * MIN }), DEFAULT_AUTO_COMPACT)).toEqual([]);
        expect(detectAutoCompactTriggers(facts({ sinceLastRequestMs: 10 * MIN }), DEFAULT_AUTO_COMPACT)).toEqual([]);
    });

    it("窗口超上限 → 触发；**排在首位**（撞墙最急）", () => {
        const tr = detectAutoCompactTriggers(
            facts({ windowRatio: 0.85, systemContextChanged: true, sinceLastRequestMs: 60 * MIN }),
            DEFAULT_AUTO_COMPACT,
        );
        expect(tr).toEqual(["contextWindowOver", "systemContextChanged", "cacheExpired"]);
    });

    it("阈值边界：等于上限即触发（>=）；windowRatio 未知（null）不触发", () => {
        expect(detectAutoCompactTriggers(facts({ windowRatio: 0.8 }), DEFAULT_AUTO_COMPACT)).toEqual(["contextWindowOver"]);
        expect(detectAutoCompactTriggers(facts({ windowRatio: null }), DEFAULT_AUTO_COMPACT)).toEqual([]);
    });

    it("首轮（无历史）不因 cacheExpired 触发 —— 没有「上次请求」就没有过期", () => {
        expect(detectAutoCompactTriggers(facts({ sinceLastRequestMs: null }), DEFAULT_AUTO_COMPACT)).toEqual([]);
    });

    it("逐项开关：关掉谁，谁就不触发", () => {
        const cfg = normalizeAutoCompact({
            triggers: { systemContextChanged: false, cacheExpired: false, contextWindowOver: 0 },
        });
        expect(
            detectAutoCompactTriggers(
                facts({ systemContextChanged: true, sinceLastRequestMs: 60 * MIN, windowRatio: 0.99 }),
                cfg,
            ),
        ).toEqual([]);
    });

    it("每个理由都有中文说明（UI 提示与账本注释同一处文案）", () => {
        for (const t of ["manual", "systemContextChanged", "cacheExpired", "contextWindowOver"] as const) {
            expect(TRIGGER_TEXT[t].length).toBeGreaterThan(0);
        }
        expect(TRIGGER_TEXT.systemContextChanged).toContain("作废");
        expect(TRIGGER_TEXT.cacheExpired).toContain("过期");
    });
});

describe("normalizeAutoCompact：初版紧凑、扩展松散", () => {
    it("空 → 默认（notify + 三个触发开）+ **自动压默认 = 目标式预算 3KB**", () => {
        const c = normalizeAutoCompact(undefined);
        expect(c).toEqual(DEFAULT_AUTO_COMPACT);
        expect(c.mode).toBe("notify");
        expect(c.policy).toEqual(DEFAULT_AUTO_COMPACT.policy);
    });

    it("非法 mode/比例回落；0 是合法值（关闭该触发）", () => {
        expect(normalizeAutoCompact({ mode: "nope" }).mode).toBe("notify");
        expect(normalizeAutoCompact({ triggers: { contextWindowOver: 5 } }).triggers.contextWindowOver).toBe(0.8);
        expect(normalizeAutoCompact({ triggers: { contextWindowOver: 0 } }).triggers.contextWindowOver).toBe(0);
    });

    it("默认策略 → 压缩策略输入：目标式预算 3KB", () => {
        // 策略**直接复用真源形状**（含 summary），不再经扁平形状转一道
        const p = autoCompactPolicyInput(DEFAULT_AUTO_COMPACT);
        expect(p).toEqual(DEFAULT_AUTO_COMPACT.policy);
        expect(normalizePolicy(p)).toEqual(p);
    });
});

describe("配置文件层：真源落盘（不是 localStorage）", () => {
    const fp = () => autoCompactFile(diyHome());
    afterAll(() => rmSync(fp(), { force: true }));

    it("缺失 → 默认 notify；写回后再读得到（含手改 YAML 的宽松归一）", () => {
        rmSync(fp(), { force: true });
        expect(loadAutoCompact(diyHome()).mode).toBe("notify");

        saveAutoCompact(diyHome(), { mode: "auto", triggers: { contextWindowOver: 0.6 } });
        const c = loadAutoCompact(diyHome());
        expect(c.mode).toBe("auto");
        expect(c.triggers.contextWindowOver).toBe(0.6);
        // 未给的字段用默认补（初版紧凑）
        expect(c.policy).toEqual(DEFAULT_AUTO_COMPACT.policy);
    });

    it("坏文件 → 默认 + 出声（不崩、不用坏数据）", () => {
        writeFileSync(fp(), "mode: [不是对象\n", "utf-8");
        expect(loadAutoCompact(diyHome()).mode).toBe("notify");
    });
});

// ─── 端到端：mode=auto 时真的压，且账本记下 trigger ────────

describe("自动压缩执行（真会话 + 桩模型）", () => {
    it("mode=auto + 窗口超限 → chat() 之前自动压一次，账本 by=auto / trigger=contextWindowOver", async () => {
        const { createProject } = await import("../../src/main/core/project");
        const { createTask } = await import("../../src/main/core/task");
        const { writeFileSync } = await import("node:fs");
        const { compactFile, opsFile } = await import("../../src/main/services/local-agent");
        const { parseCompactLog } = await import("../../src/shared/context/compaction");
        const { readFileSync } = await import("node:fs");
        const { MockLanguageModelV3 } = await import("ai/test");
        const { LocalAgentManager } = await import("../../src/main/services/local-agent");
        type LM = import("ai").LanguageModel;

        const pid = createProject(join(diyHome(), "auto-work"));
        const uri = createTask({ title: "自动压缩", project: pid });
        // 三轮会话落盘（每轮 user + assistant 文本 + tool）
        const lines: string[] = [];
        const pushes = (o: unknown) => lines.push(JSON.stringify(o));
        for (let i = 1; i <= 3; i++) {
            const t = `t${7000 + i}`;
            pushes({ op: "start", id: t, kind: "turn" });
            pushes({ op: "start", id: `${t}_u`, kind: "text", parent: t, meta: { role: "user" } });
            pushes({ op: "delta", id: `${t}_u`, fields: { content: `第 ${i} 句` } });
            pushes({ op: "stop", id: `${t}_u` });
            pushes({ op: "start", id: `${t}_s1`, kind: "step", parent: t });
            pushes({ op: "start", id: `${t}_c`, kind: "tool", parent: `${t}_s1`, meta: { tool: "bash" } });
            pushes({ op: "patch", id: `${t}_c`, fields: { args: { command: "ls" }, status: "done", output: Array.from({ length: 120 }, (_, k) => `row ${k}`).join("\n") } });
            pushes({ op: "stop", id: `${t}_c` });
            pushes({ op: "stop", id: `${t}_s1` });
            pushes({ op: "stop", id: t });
        }
        writeFileSync(opsFile(uri), lines.join("\n") + "\n", "utf-8");
        // 造一条用量账：窗口占用走**实测**口径（最后一步用量 / contextLimit）。
        // 阈值判定要确定性，故不依赖真实模型：给一个足够大的 total（≈10% 窗口）。
        const { localDir, keyOf } = await import("../../src/main/core/local-paths");
        writeFileSync(
            join(localDir(), `${keyOf(uri)}.usage.jsonl`),
            JSON.stringify({
                ts: new Date().toISOString(),
                turnId: "t7003",
                step: 1,
                model: "mimo-v2.6-flash",
                apiFace: "chat",
                usage: {
                    inputTokens: 100000,
                    inputTokenDetails: { noCacheTokens: 100000, cacheReadTokens: 0, cacheWriteTokens: null },
                    outputTokens: 10,
                    outputTokenDetails: { textTokens: 10, reasoningTokens: 0 },
                    totalTokens: 100010,
                },
            }) + "\n",
            "utf-8",
        );

        // mode=auto，阈值 1%（实测占用 ≈9.5% → 必触发；且不依赖真实模型）
        saveAutoCompact(diyHome(), {
            mode: "auto",
            triggers: { contextWindowOver: 0.01, systemContextChanged: false, cacheExpired: false },
        });

        const stream = {
            stream: new ReadableStream({
                start(c) {
                    for (const p of [
                        { type: "stream-start", warnings: [] },
                        { type: "text-start", id: "t" },
                        { type: "text-delta", id: "t", delta: "答复" },
                        { type: "text-end", id: "t" },
                        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
                    ])
                        c.enqueue(p as never);
                    c.close();
                },
            }),
        };
        const model = new MockLanguageModelV3({ provider: "stub", modelId: "stub", doStream: () => Promise.resolve(stream as never) });
        const mgr = new LocalAgentManager(() => model as unknown as LM);
        for await (const _op of mgr.chat(uri, "自动压之后问一句")) void _op;

        const events = parseCompactLog(readFileSync(compactFile(uri), "utf-8"));
        const c = events.find((e) => e.kind === "compact") as unknown as Record<string, any>;
        expect(c).toBeTruthy();
        expect(c.by).toBe("auto");
        expect(c.trigger).toBe("contextWindowOver");
        // 自动压用的是默认策略：目标式预算 3KB
        expect(c.policy).toEqual(DEFAULT_AUTO_COMPACT.policy);
        // 旧历史仍在（压缩只改投递）
        expect(readFileSync(opsFile(uri), "utf-8")).toContain("第 1 句");
    });
});
