// tests/local-find.test.ts
// ═══════════════════════════════════════════════════════════════
// 会话数据层检索（##389 第 2 项）的**纯逻辑**判据 —— 不启 Electron，直接对 ops.jsonl 扫。
//
// 为什么必须有这一层：检索的正确性全在「怎么读盘」上，而 UI 测试只能看到结果项。
// 这里钉住四条真会翻车的口径：
//   1. **按轮折好再找**：正文是逐 token 一条 delta 追加的 ⇒ 一个词被切成两条 delta 时，
//      扫原始行的实现会**漏**（`{content:"止"}` + `{content:"扰"}`）。本用例专门造这个形状。
//   2. **`at` 必须是该轮 start 行的字节偏移**：段跳（`historyAt`）拿它当锚，
//      偏一个字节 `isTurnStartAt` 就判失效 ⇒ 定位功能整体哑掉。
//   3. **范围开关**：推理默认不搜（量最大、与结论重复度最高），工具默认搜。
//   4. **「已压缩」标注**：`at` 早于最近一次压缩的保留边界 ⇒ 该轮不投递给模型，但原文可搜。
//      （压缩"不搬文件、不 rm"，所以能搜到；标出来是为了让人知道它不在上下文里了。）
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findInOpsFile } from "../src/main/services/local-find";
import { isTurnStartAt } from "../src/main/services/local-ops-seek";

/** 三轮：① 正文跨 delta 被切开 + 工具输出；② 推理独有词；③ 普通正文 */
const T1 = "t1700000000001";
const T2 = "t1700000000002";
const T3 = "t1700000000003";

let fp = "";
let atT1 = 0;
let atT3 = 0;

beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "diy-find-"));
    fp = join(dir, "ops.jsonl");
    const lines: string[] = [];
    const offsets: number[] = [];
    let pos = 0;
    const push = (o: Record<string, unknown>, at?: number) => {
        if (at !== undefined) offsets.push(pos);
        const line = JSON.stringify(o) + "\n";
        lines.push(line);
        pos += Buffer.byteLength(line, "utf-8");
    };
    // ① 用户发言被切成两条 delta：`止` + `扰` —— 原始行里**没有**连续的"止扰"
    push({ op: "start", id: T1, kind: "turn", meta: { model: "test" } }, 0);
    push({ op: "start", id: `${T1}_u`, kind: "text", parent: T1, meta: { role: "user" } });
    push({ op: "delta", id: `${T1}_u`, fields: { content: "麻烦处理一下 ##387 发来的止" } });
    push({ op: "delta", id: `${T1}_u`, fields: { content: "扰请求，别让它继续插话。" } });
    push({ op: "stop", id: `${T1}_u` });
    // 工具块：输出里带一个独有词（默认范围里要能搜到）
    push({ op: "start", id: `${T1}_t1`, kind: "tool", parent: T1, meta: { tool: "bash", title: "跑测试" } });
    push({ op: "delta", id: `${T1}_t1`, fields: { input: "npm test" } });
    push({ op: "delta", id: `${T1}_t1`, fields: { output: "ok 3 passed deep-scan-token" } });
    push({ op: "stop", id: `${T1}_t1` });
    push({ op: "stop", id: T1 });

    // ② 一轮只有推理里提到"局部变量缓存"（推理默认关：不该被搜到）
    push({ op: "start", id: T2, kind: "turn", meta: { model: "test" } }, 1);
    push({ op: "start", id: `${T2}_k1`, kind: "think", parent: T2 });
    push({ op: "delta", id: `${T2}_k1`, fields: { content: "先做个局部变量缓存会更稳" } });
    push({ op: "stop", id: `${T2}_k1` });
    push({ op: "start", id: `${T2}_a`, kind: "text", parent: T2, meta: { role: "assistant" } });
    push({ op: "delta", id: `${T2}_a`, fields: { content: "这一轮正文里没有那个词。" } });
    push({ op: "stop", id: `${T2}_a` });
    push({ op: "stop", id: T2 });

    // ③ 普通正文（用于 maxTurns / 压缩边界两条用例）
    push({ op: "start", id: T3, kind: "turn", meta: { model: "test" } }, 2);
    push({ op: "start", id: `${T3}_a`, kind: "text", parent: T3, meta: { role: "assistant" } });
    push({ op: "delta", id: `${T3}_a`, fields: { content: "止扰处理完毕。" } });
    push({ op: "stop", id: `${T3}_a` });
    push({ op: "stop", id: T3 });

    mkdirSync(join(dir), { recursive: true });
    writeFileSync(fp, lines.join(""), "utf-8");
    // 用 JSON 行首反推偏移：与被测实现独立算一遍，免得"自己验自己"
    const text = lines.join("");
    atT1 = offsets[0]!;
    atT3 = offsets[2]!;
    expect(text.length).toBeGreaterThan(0);
});

describe("findInOpsFile：会话数据层检索", () => {
    it("跨 delta 被切开的词能搜到（按轮折好再找，不是扫原始行）", async () => {
        const r = await findInOpsFile(fp, { query: "止扰" });
        // 两轮命中：① 用户那句被切成两条 delta 的、③ 完整写在一行里的
        expect(r.turns).toBe(2);
        expect(r.hits.map((h) => h.turnId)).toEqual([T1, T3]);
        expect(r.hits[0]!.hit).toBe("止扰");
        // 上下文各 ~40 字：前后都要有内容，且不能把整轮塞进来
        expect(r.hits[0]!.pre).toContain("##387");
        expect(r.hits[0]!.post).toContain("请求");
    });

    it("`at` 是该轮 start 行的字节偏移（段跳的锚；偏一字节就判失效）", async () => {
        const r = await findInOpsFile(fp, { query: "止扰" });
        const at = new Map(r.hits.map((h) => [h.turnId, h.at]));
        expect(at.get(T1)).toBe(atT1);
        expect(at.get(T3)).toBe(atT3);
        // 与 main 侧的字节级复核同一判据：定位之所以能跳，全靠这两个事实
        expect(isTurnStartAt(fp, at.get(T1)!)).toBe(true);
        expect(isTurnStartAt(fp, at.get(T3)!)).toBe(true);
        expect(isTurnStartAt(fp, at.get(T3)! + 1)).toBe(false);
    });

    it("范围开关：工具默认搜、推理默认不搜", async () => {
        const tool = await findInOpsFile(fp, { query: "deep-scan-token" });
        expect(tool.hits).toHaveLength(1);
        expect(tool.hits[0]!.scope).toBe("tool");
        expect(tool.hits[0]!.label).toBe("跑测试"); // 结果项显示的是工具标题，不是"tool"

        const thinkOff = await findInOpsFile(fp, { query: "局部变量缓存" });
        expect(thinkOff.hits).toHaveLength(0); // 默认关：推理里的词不出现
        const thinkOn = await findInOpsFile(fp, { query: "局部变量缓存", scopes: { think: true } });
        expect(thinkOn.hits).toHaveLength(1);
        expect(thinkOn.hits[0]!.scope).toBe("think");
    });

    it("「已压缩」标注：早于压缩保留边界的轮命中带 compacted", async () => {
        const r = await findInOpsFile(fp, { query: "止扰", compactedBefore: atT3 });
        expect(r.hits.find((h) => h.turnId === T1)!.compacted).toBe(true);
        expect(r.hits.find((h) => h.turnId === T3)!.compacted).toBe(false);
        // 旧账没有字节偏移时按轮序兜底（keptFromTurnId）：边界轮**之后**才算保留
        const byTurn = await findInOpsFile(fp, { query: "止扰", compactedFromTurnId: T3 });
        expect(byTurn.hits.find((h) => h.turnId === T1)!.compacted).toBe(true);
        expect(byTurn.hits.find((h) => h.turnId === T3)!.compacted).toBe(false);
    });

    it("组数上限：撞到 maxTurns 即停并报 more（面板的「还有更多」靠它）", async () => {
        const one = await findInOpsFile(fp, { query: "止扰", maxTurns: 1 });
        expect(one.turns).toBe(1);
        expect(one.more).toBe(true);
        expect(one.hits.every((h) => h.turnId === T1)).toBe(true);

        const all = await findInOpsFile(fp, { query: "止扰", maxTurns: 10 });
        expect(all.turns).toBe(2);
        expect(all.more).toBe(false);
    });

    it("取消：signal 一断就收手（打字时每次换查询都会取消上一次）", async () => {
        const ctl = new AbortController();
        ctl.abort();
        await expect(findInOpsFile(fp, { query: "止扰", signal: ctl.signal })).rejects.toMatchObject({
            name: "AbortError",
        });
    });

    it("空查询 / 无日志：0 命中且不抛（面板不必为「还没打字」写特例）", async () => {
        expect((await findInOpsFile(fp, { query: "   " })).hits).toHaveLength(0);
        expect((await findInOpsFile(join(fp, "..", "nope.jsonl"), { query: "x" })).hits).toHaveLength(0);
    });
});
