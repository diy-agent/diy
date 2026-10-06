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
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel } from "ai";
import { diyHome } from "../../src/main/core/state";
import { createProject } from "../../src/main/core/project";
import { createTask } from "../../src/main/core/task";
import { getLocalAgent, compactFile, opsFile } from "../../src/main/services/local-agent";
import { parseCompactLog } from "../../src/shared/context/compaction";
import { UPSTREAM_PROVIDER } from "../../src/shared/models";
import { readFileSync } from "node:fs";

let PROJECT = "";
beforeAll(() => {
    process.env["OPENCODE_ZEN_API_KEY"] = "test-key";
    PROJECT = createProject(join(diyHome(), "ledger-work"));
});
let seq = 0;
const newUri = (): string => createTask({ title: `账本测试 ${++seq}`, project: PROJECT });

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
    it("全部清零 → after.turns = 0（旧实现会写 3）", () => {
        const uri = newUri();
        seedOps(uri);
        const pv = getLocalAgent().compactPreview(uri, { keepTurns: 0 });
        expect(pv.after.turns).toBe(0);
        expect(pv.after.messages).toBe(0);
        expect(pv.before.turns).toBe(3);
    });

    it("保留 1 轮 → after.turns = 1；保留全部 → = 3", () => {
        const uri = newUri();
        seedOps(uri);
        expect(getLocalAgent().compactPreview(uri, { keepTurns: 1 }).after.turns).toBe(1);
        expect(getLocalAgent().compactPreview(uri, { keepTurns: "all" }).after.turns).toBe(3);
    });

    it("content 裁内容但轮不动 → after.turns 仍是 3（轮在、内容少了）", () => {
        const uri = newUri();
        seedOps(uri);
        const pv = getLocalAgent().compactPreview(uri, { keepTurns: "all", content: "conclusion" });
        expect(pv.after.turns).toBe(3);
        expect(pv.after.messages).toBeLessThan(pv.before.messages);
    });
});

describe("② rates：provider = 谁服务的，source = 价目真源", () => {
    it("provider 不是 models.dev；source 才是；k 圆整", () => {
        const uri = newUri();
        seedOps(uri);
        // 用「真压一次」把账本写出来（预览不落账）
        const rec = getLocalAgent().compact(uri, { keepTurns: 1 }, "cli");
        const ev = rec as unknown as { rates?: { provider?: string; source?: string; k: number } };
        expect(ev.rates).toBeTruthy();
        expect(ev.rates!.provider).toBe(UPSTREAM_PROVIDER);
        expect(ev.rates!.provider).not.toContain("models.dev");
        expect(String(ev.rates!.source)).toContain("models.dev");
        // 圆整：不留浮点残渣（k 的真值因模型而异：mimo/deepseek=50、luna=10；
        // 关键是**圆整后是个干净的数**，且等于 round3(input/cacheRead)）
        const r = ev.rates as unknown as { input: number; cacheRead: number; k: number };
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

    it("真发一轮后 measure 落账，且**没有** predicted 键", async () => {
        const uri = newUri();
        seedOps(uri);
        getLocalAgent().compact(uri, { keepTurns: 1 }, "cli");
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
