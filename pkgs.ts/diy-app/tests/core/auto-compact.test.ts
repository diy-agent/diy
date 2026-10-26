// tests/core/auto-compact.test.ts
// 🎯 自动压缩：配置契约 + 触发判定（##269 D7）—— 纯函数，无网络无 Electron
//
// 核心契约：
//   ① 判据全是**确定事实**（系统上下文变 / 缓存过期 / 窗口超限），不含任何"划不划算"的预测
//      （那正是 230#25 放弃的评估；两者不冲突，别混为一谈）；
//   ② 默认 `notify` —— **不静默改用户的会话**（静默丢历史与 rule.no-silent-catch 同族）；
//   ③ 触发按**紧急度排序**（撞墙最急）；返回数组以便账本如实记下全部理由；
//   ④ 【##370】写漏必填键**不再整份静默作废** —— 逐键回落缺省 + **出声**（`loadAutoCompactDetailed`
//      的 `issues`，供 plan get / UI 展示）。理由：这份 yaml 是手写/LLM 写的**全局配置**，
//      "静默回退 + 只见结果不见因"与 ##338 同族。

import { describe, it, expect, afterAll } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import {
    DEFAULT_AUTO_COMPACT,
    DEFAULT_WINDOW_OVER_TOKENS,
    autoCompactPolicyInput,
    detectAutoCompactTriggers,
    normalizeAutoCompact,
    TRIGGER_TEXT,
    type AutoCompactConfig,
    type AutoCompactFacts,
} from "../../src/shared/context/auto-compact";
import { effectiveTtl, ttlBoundsFrom } from "../../src/shared/context/cache-ttl";
import {
    loadAutoCompact,
    loadAutoCompactDetailed,
    saveAutoCompact,
    autoCompactFile,
} from "../../src/main/core/auto-compact-config";
import { diyHome } from "../../src/main/core/state";
import { DEFAULT_HEADTAIL, normalizePolicy, toolResultOf } from "../../src/shared/context/compaction";
import { DEFAULT_HISTORY_LIMIT_TOKENS, normalizeHistoryLimit } from "../../src/shared/context/history-limit";

/** 配置里生效的**历史上限**（唯一旋钮；读侧宽松归一后取） */
const limitOf = (c: import("../../src/shared/context/auto-compact").AutoCompactConfig): number =>
    normalizeHistoryLimit(c.history?.limit).limitTokens;

const MIN = 60_000;
/** 已知 TTL：(30min, 45min] —— 30 分钟内一定活着，超过 45 分钟一定过期 */
const TTL = effectiveTtl(ttlBoundsFrom([{ gapMs: 30 * MIN, hit: true, samePrefix: true }, { gapMs: 45 * MIN, hit: false, samePrefix: true }]), 60 * MIN);

const facts = (over: Partial<AutoCompactFacts> = {}): AutoCompactFacts => ({
    systemContextChanged: false,
    sinceLastRequestMs: 5 * MIN,
    ttl: TTL,
    windowTokens: 10_000,
    retainedTokens: null,
    boundary: null,
    compactionCount: 0,
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
            facts({ windowTokens: 50_000, systemContextChanged: true, sinceLastRequestMs: 60 * MIN }),
            DEFAULT_AUTO_COMPACT,
        );
        expect(tr).toEqual(["contextWindowOver", "systemContextChanged", "cacheExpired"]);
    });

    it("阈值边界：等于上限即触发（>=）；未知（null）不触发", () => {
        expect(detectAutoCompactTriggers(facts({ windowTokens: DEFAULT_WINDOW_OVER_TOKENS }), DEFAULT_AUTO_COMPACT)).toEqual([
            "contextWindowOver",
        ]);
        expect(detectAutoCompactTriggers(facts({ windowTokens: null }), DEFAULT_AUTO_COMPACT)).toEqual([]);
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
                facts({ systemContextChanged: true, sinceLastRequestMs: 60 * MIN, windowTokens: 999_999 }),
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

    it("非法 mode 回落；token 阈值原样保留；0 = 关闭；旧**比例**值（0,1）→ 出声回落默认", () => {
        expect(normalizeAutoCompact({ mode: "nope" }).mode).toBe("notify");
        expect(normalizeAutoCompact({ triggers: { contextWindowOver: 20480 } }).triggers.contextWindowOver).toBe(20480);
        expect(normalizeAutoCompact({ triggers: { contextWindowOver: 0 } }).triggers.contextWindowOver).toBe(0);
        // 旧单位（比例 0~1）与 token 域冲突：0.8 绝不能当 0.8 token 用（会每轮都压）→ 回落默认 38400
        expect(normalizeAutoCompact({ triggers: { contextWindowOver: 0.8 } }).triggers.contextWindowOver).toBe(
            DEFAULT_WINDOW_OVER_TOKENS,
        );
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

        saveAutoCompact(diyHome(), { mode: "auto", triggers: { contextWindowOver: 20480 } });
        const c = loadAutoCompact(diyHome());
        expect(c.mode).toBe("auto");
        expect(c.triggers.contextWindowOver).toBe(20480);
        // 未给的字段用默认补（初版紧凑）
        expect(c.policy).toEqual(DEFAULT_AUTO_COMPACT.policy);
    });

    it("坏文件 → 默认 + 出声（不崩、不用坏数据）", () => {
        writeFileSync(fp(), "mode: [不是对象\n", "utf-8");
        expect(loadAutoCompact(diyHome()).mode).toBe("notify");
    });
});

// ─── ##370：写漏必填键 ⇒ 逐键回落缺省 + **出声**（不再整份静默作废）────────
//
// 病：`auto-compact.yaml` 漏**任一**必填键 ⇒ `safeParse` 失败 ⇒ `return DEFAULT_AUTO_COMPACT`（整份），
// 而 `plan get` 的 `raw` 仍是原文、`source` 已是 `default` —— **看得见原文、看不见因**（原因只在应用日志一行）；
// 用户精心写的 `history.limit` 一并「不见了」。
// 修法：严格 schema 只当**探测器**（它才说得出缺了哪个必填键），值走 `normalizeAutoCompact`
// （本就是为缺字段/越界写的宽松归一，旧代码把它挡在严格校验之后 ⇒ 缺键场景**永远跑不到** = 死代码），
// 归一改过的地方进 `issues` 出声。
describe("##370 缺必填键：逐键回落缺省 + 出声", () => {
    const fp = () => autoCompactFile(diyHome());
    afterAll(() => rmSync(fp(), { force: true }));

    /** 一份**全合法**的配置（基线）：漏谁都不能牵连别人 —— 这正是本任务要钉的语义 */
    const base = (): Record<string, unknown> => ({
        mode: "auto",
        triggers: { systemContextChanged: false, cacheExpired: true, contextWindowOver: 12345 },
        policy: {
            mode: "budget",
            modeData: {
                toolResult: { render: "headtail", renderData: { head: 1, tail: 2, maxLineChars: 111, maxKeepBytes: 1000 } },
            },
            summary: true,
        },
        history: { limit: { limitTokens: 12345, summary: { enabled: true } } },
    });
    /** 删掉点号路径上的那个键 —— 造「漏一个必填键」的现场 */
    const without = (path: string): Record<string, unknown> => {
        const o = base();
        const parts = path.split(".");
        let cur: Record<string, unknown> = o;
        for (const k of parts.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
        delete cur[parts.at(-1)!];
        return o;
    };
    const read = (doc: unknown) => {
        writeFileSync(fp(), yaml.dump(doc), "utf-8");
        return loadAutoCompactDetailed(diyHome());
    };

    /** 逐键一例（body 的必填键清单）：漏掉它 ⇒ 它回落缺省，**其余全部保留** + 出声报出它 */
    const cases: Array<{ path: string; check: (c: AutoCompactConfig) => void }> = [
        // policy 支
        {
            path: "policy.summary",
            check: (c) => {
                expect(c.policy.summary).toBe(false);
                expect(limitOf(c)).toBe(12345); // 用户写的上限没被牵连
            },
        },
        {
            path: "history.limit.limitTokens",
            check: (c) => {
                expect(limitOf(c)).toBe(DEFAULT_HISTORY_LIMIT_TOKENS);
                expect(normalizeHistoryLimit(c.history?.limit).summary.enabled).toBe(true);
            },
        },
        {
            path: "policy.modeData.toolResult",
            check: (c) => {
                expect(toolResultOf(c.policy)).toEqual(DEFAULT_AUTO_COMPACT.policy.modeData.toolResult);
                expect(limitOf(c)).toBe(12345);
            },
        },
        {
            path: "policy.modeData.toolResult.renderData.maxLineChars",
            check: (c) => {
                // 只缺一个私有参数 ⇒ 只有它回落（head/tail 是用户写的 1/2），不是整包换掉
                expect(toolResultOf(c.policy)).toEqual({
                    render: "headtail",
                    renderData: { head: 1, tail: 2, maxLineChars: DEFAULT_HEADTAIL.maxLineChars, maxKeepBytes: 1000 },
                });
            },
        },
        {
            path: "policy.mode",
            check: (c) => {
                expect(c.policy.mode).toBe("budget");
                expect(limitOf(c)).toBe(12345);
            },
        },
        { path: "policy", check: (c) => expect(c.policy).toEqual(DEFAULT_AUTO_COMPACT.policy) },
        // triggers 支
        {
            path: "triggers.systemContextChanged",
            check: (c) => {
                expect(c.triggers.systemContextChanged).toBe(true);
                expect(c.triggers.contextWindowOver).toBe(12345);
            },
        },
        { path: "triggers.cacheExpired", check: (c) => expect(c.triggers.cacheExpired).toBe(true) },
        {
            path: "triggers.contextWindowOver",
            check: (c) => expect(c.triggers.contextWindowOver).toBe(DEFAULT_WINDOW_OVER_TOKENS),
        },
        // 顶层
        {
            path: "mode",
            check: (c) => {
                expect(c.mode).toBe("notify");
                expect(limitOf(c)).toBe(12345);
            },
        },
    ];

    for (const cs of cases) {
        it(`漏 \`${cs.path}\` ⇒ 该键回落缺省 + 出声，其余原样`, () => {
            rmSync(fp(), { force: true });
            const { config, issues } = read(without(cs.path));
            // 出声：报出**哪一层**，且必须说清「回落成什么」
            const hit = issues.find((i) => i.path === cs.path);
            expect(hit, `issues=${JSON.stringify(issues)}`).toBeTruthy();
            expect(hit!.message).toContain("已回落");
            // 该键回落缺省
            cs.check(config);
            // 🔑 其余全部保留（旧行为：整份作废 —— 这正是用户「配置不见了」的现场）
            if (!cs.path.startsWith("history.limit")) {
                // 历史上限是**一个整体**（limitTokens / summary 同属一个对象）：改了其中一项，
                // 落盘形状就是补齐后的那份 —— 唯一不变量是「其它键（mode / triggers / policy）没被牵连」
                expect(limitOf(config)).toBe(12345);
                expect(normalizeHistoryLimit(config.history?.limit).summary.enabled).toBe(true);
            }
        });
    }

    it("合法配置 / 文件不存在 ⇒ **无出声**（出声只报真问题，不制造噪音）", () => {
        rmSync(fp(), { force: true });
        expect(loadAutoCompactDetailed(diyHome()).issues).toEqual([]); // 不存在 = 正常态
        const { config, issues } = read(base());
        expect(issues).toEqual([]);
        expect(config.mode).toBe("auto");
        expect(limitOf(config)).toBe(12345);
        expect(limitOf(config)).toBe(12345);
    });

    it("YAML 语法坏 ⇒ 整份缺省 + 出声（这条口径**保留**：不崩、不用坏数据）", () => {
        rmSync(fp(), { force: true });
        writeFileSync(fp(), "mode: [不是对象\n", "utf-8");
        const { config, issues } = loadAutoCompactDetailed(diyHome());
        expect(config).toEqual(DEFAULT_AUTO_COMPACT);
        expect(issues).toHaveLength(1);
        expect(issues[0]!.message).toContain("YAML 解析失败");
        expect(loadAutoCompact(diyHome())).toEqual(DEFAULT_AUTO_COMPACT);
    });

    it("**值**被归一也要出声（旧比例单位）—— 归一不再静默", () => {
        rmSync(fp(), { force: true });
        const doc = base();
        (doc.triggers as Record<string, unknown>).contextWindowOver = 0.8;
        const { config, issues } = read(doc);
        expect(config.triggers.contextWindowOver).toBe(DEFAULT_WINDOW_OVER_TOKENS);
        expect(issues.map((i) => i.path)).toContain("triggers.contextWindowOver");
        // mode/预算照用（schema 层没失败，只有归一改了一处）
        expect(config.mode).toBe("auto");
        expect(limitOf(config)).toBe(12345);
    });

    it("`history.keep` 已删除 ⇒ 忽略并出声，其余（含上限）原样", () => {
        rmSync(fp(), { force: true });
        const doc = base();
        // 旧配置残留的级列表：不认识、也不该牵连别的键
        doc.history = { limit: { limitTokens: 12345, summary: { enabled: true } }, keep: [{ type: "nope" }] };
        const { config, issues } = read(doc);
        expect(config.mode).toBe("auto");
        expect(limitOf(config)).toBe(12345);
        expect(issues.map((i) => i.path)).toContain("history.keep");
    });
});

// ─── 端到端：mode=auto 时真的压，且账本记下 trigger ────────

describe("自动压缩执行（真会话 + 桩模型）", () => {
    it("mode=auto + 窗口超限 → chat() 之前自动压一次，账本 by=auto / trigger=contextWindowOver", async () => {
        const { createProject } = await import("../../src/main/core/project");
        const { createTask } = await import("../../src/main/core/task");
        const { writeFileSync } = await import("node:fs");
        const { compactFile } = await import("../../src/main/services/local-agent");
    const { opsFile } = await import("../../src/main/core/local-paths");
        const { parseCompactLog } = await import("../../src/shared/context/compaction");
        const { readFileSync } = await import("node:fs");
        const { MockLanguageModelV3 } = await import("ai/test");
        const { LocalAgentManager } = await import("../../src/main/services/local-agent");
        type LM = import("ai").LanguageModel;

        const pid = createProject(join(diyHome(), "auto-work"));
        const uri = createTask({ title: "自动压缩", project: pid });
        // 十轮会话落盘（每轮 user + assistant 文本 + tool）。
        // ⚠️ 必须**够大**才谈得上「压出东西」（##343 M1 后缺省预算 20KB、最近 6 步保底 `clip: full`）：
        //    非保底的旧轮若本来就装得进预算、又没被裁，压缩就是**空操作**（noop 不写账）——
        //    那是设计（见 compact 的 noop 判据），不是 bug。这里每轮 400 行输出 ⇒ 旧轮必被 headtail 裁。
        const lines: string[] = [];
        const pushes = (o: unknown) => lines.push(JSON.stringify(o));
        for (let i = 1; i <= 10; i++) {
            const t = `t${7000 + i}`;
            pushes({ op: "start", id: t, kind: "turn" });
            pushes({ op: "start", id: `${t}_u`, kind: "text", parent: t, meta: { role: "user" } });
            pushes({ op: "delta", id: `${t}_u`, fields: { content: `第 ${i} 句` } });
            pushes({ op: "stop", id: `${t}_u` });
            pushes({ op: "start", id: `${t}_s1`, kind: "step", parent: t });
            pushes({ op: "start", id: `${t}_c`, kind: "tool", parent: `${t}_s1`, meta: { tool: "bash" } });
            pushes({ op: "patch", id: `${t}_c`, fields: { args: { command: "ls" }, status: "done", output: Array.from({ length: 400 }, (_, k) => `row ${k}`).join("\n") } });
            pushes({ op: "stop", id: `${t}_c` });
            pushes({ op: "stop", id: `${t}_s1` });
            pushes({ op: "stop", id: t });
        }
        writeFileSync(opsFile(uri), lines.join("\n") + "\n", "utf-8");
        // 造一条用量账：窗口占用走**实测**口径（最后一步用量 token 数）。
        // 阈值判定要确定性，故不依赖真实模型：给一个足够大的 total（100010 token）。
        const { sessionFile } = await import("../../src/main/core/local-paths");
        writeFileSync(
            sessionFile(uri, "usage"),
            JSON.stringify({
                ts: new Date().toISOString(),
                turnId: "t7010",
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

        // mode=auto，**token** 阈值：实测占用 = 最后一步用量 100010 token ≥ 38400 → 必触发
        // （用量账已手工写死，不依赖真实模型）
        saveAutoCompact(diyHome(), {
            mode: "auto",
            triggers: { contextWindowOver: DEFAULT_WINDOW_OVER_TOKENS, systemContextChanged: false, cacheExpired: false },
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
        // 自动压用的是默认策略：目标式预算 20KB（##343 M1 与生产 auto-compact.yaml 对齐）
        expect(c.policy).toEqual(DEFAULT_AUTO_COMPACT.policy);
        // 旧历史仍在（压缩只改投递）
        expect(readFileSync(opsFile(uri), "utf-8")).toContain("第 1 句");
    });
});

describe("##432 review B1：history.limit 残缺/超界不许抛（宽松归一 + 出声）", () => {
    it("只写 limitTokens（缺 summary）⇒ 不抛，summary.enabled 缺省 false，并出声", () => {
        const issues: { path: string; message: string }[] = [];
        const cfg = normalizeAutoCompact(
            { history: { limit: { limitTokens: 8_000 } } },
            issues as unknown as Parameters<typeof normalizeAutoCompact>[1],
        );
        expect(cfg.history?.limit?.limitTokens).toBe(8_000);
        expect(cfg.history?.limit?.summary.enabled).toBe(false);
        expect(issues.some((i) => i.path.startsWith("history.limit"))).toBe(true);
    });
    it("limitTokens 超下限 ⇒ 夹到 4000（不拒绝）", () => {
        const cfg = normalizeAutoCompact({ history: { limit: { limitTokens: 0, summary: { enabled: false } } } });
        expect(cfg.history?.limit?.limitTokens).toBe(4_000);
    });
    it("limit 整个是个字符串（写坏了）⇒ 回落缺省（20000），不抛", () => {
        const cfg = normalizeAutoCompact({ history: { limit: "8000" } });
        expect(cfg.history?.limit?.limitTokens).toBe(20_000);
    });
});
