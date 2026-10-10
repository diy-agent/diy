// tests/core/context-steps.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 投递快照（step）与 diff：真发每轮落一条，UI 靠它回答两种变更。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { diffSteps, summarizeSteps, withIndex, type DeliveryStepRecord } from "../../src/shared/context/steps";
import { opsFile, readDeliverySteps } from "../../src/main/services/local-agent";

const rec = (over: Partial<DeliveryStepRecord> = {}): DeliveryStepRecord => ({
    ts: "2026-09-25T00:00:00.000Z",
    turnId: "t1",
    model: "m",
    wireVersion: "aaaa1111",
    systemPlaces: ["diy"],
    runtimePlaces: ["task.body"],
    valueHashes: { diy: "h1", "task.body": "b1" },
    systemText: "diy:\n  cli: /repo",
    runtimeText: 'task:\n  body: "一"',
    ...over,
});

describe("step diff", () => {
    it("只有 runtime 变（任务正文编辑）：changed 命中该 path，system 不算变", () => {
        const a = rec();
        const b = rec({
            valueHashes: { diy: "h1", "task.body": "b2" },
            runtimeText: 'task:\n  body: "二"',
        });
        const d = diffSteps(a, b);
        expect(d.changed).toEqual(["task.body"]);
        expect(d.systemDiffers).toBe(false);
        expect(d.runtimeDiffers).toBe(true);
        expect(d.runtimeDiff.some((l) => l.t === "+" && l.s.includes("二"))).toBe(true);
        expect(d.incomparable).toBe(false);
    });

    it("内容完全一致 → 两份都不算变（144：内容未变不发）", () => {
        const d = diffSteps(rec(), rec());
        expect(d.changed).toEqual([]);
        expect(d.systemDiffers).toBe(false);
        expect(d.runtimeDiffers).toBe(false);
        expect(d.systemDiff).toEqual([]);
    });

    it("wire 版本不同 → 标 incomparable（不是内容变了，而是不可比）", () => {
        const d = diffSteps(rec(), rec({ wireVersion: "bbbb2222" }));
        expect(d.incomparable).toBe(true);
    });

    it("值 hash 有增删（path 出现/消失）也算变化", () => {
        const d = diffSteps(rec(), rec({ valueHashes: { diy: "h1" }, runtimeText: "" }));
        expect(d.changed).toEqual(["task.body"]);
    });
});

describe("step 摘要列表", () => {
    const steps = [rec({ ts: "T1" }), rec({ ts: "T2", runtimeText: 'task:\n  body: "二"' }), rec({ ts: "T3", runtimeText: 'task:\n  body: "二"' })];

    it("首步 sincePrev = null（它是 baseline，没有上一步）", () => {
        const s = summarizeSteps(steps);
        expect(s[0]!.sincePrev).toBeNull();
        expect(s[1]!.sincePrev!.runtimeDiffers).toBe(true);
        expect(s[2]!.sincePrev!.runtimeDiffers).toBe(false);
    });

    it("limit 截尾但 index 仍对齐真实轮次（第 3 步就叫 3）", () => {
        const s = summarizeSteps(steps, { limit: 2 });
        expect(s.map((x) => x.index)).toEqual([2, 3]);
        // 第 2 步的 sincePrev 用真实的上一步（第 1 步）算，不受 limit 影响
        expect(s[0]!.sincePrev!.runtimeDiffers).toBe(true);
    });

    it("默认不下发行内容，只给统计；withDiff 才带行内容", () => {
        const plain = summarizeSteps(steps);
        expect(plain[1]!.diff).toBeUndefined();
        expect(plain[1]!.sincePrev!.runtimeSize.add).toBeGreaterThan(0);
        // sincePrev 里**没有**行内容（列表一条都别带几十 KB 的 diff）
        expect(Object.keys(plain[1]!.sincePrev!)).not.toContain("runtimeDiff");
        const full = summarizeSteps(steps, { withDiff: true });
        expect(full[1]!.diff!.runtime.length).toBeGreaterThan(0);
        expect(full[0]!.diff).toBeNull(); // 首步没有可比的
    });

    it("字节数按 UTF-8（中文一字 3 字节）", () => {
        const s = summarizeSteps([rec()]);
        expect(s[0]!.bytes.system).toBe(new TextEncoder().encode(rec().systemText).length);
    });
});

describe("withIndex", () => {
    it("按行序给 1 基序号", () => {
        expect(withIndex([rec(), rec()]).map((s) => s.index)).toEqual([1, 2]);
    });
});

describe("读侧兜底：缺字段的快照不打断渲染（review RV-12）", () => {
    it("steps.jsonl 缺 systemPlaces/runtimePlaces → 读出来是 []（不是 undefined）", () => {
        // 路径与 main 侧同一算法：借用 opsFile（同目录同 key），只换后缀 —— 不复制 key 算法
        const uri = "projects/99/tasks/1";
        const fp = opsFile(uri).replace(/\.ops\.jsonl$/, ".steps.jsonl");
        mkdirSync(dirname(fp), { recursive: true });
        writeFileSync(
            fp,
            JSON.stringify({
                ts: "2026-10-02T00:00:00.000Z",
                turnId: "t1",
                model: "m",
                wireVersion: "aaaa1111",
                valueHashes: {},
                systemText: "",
                runtimeText: "",
            }) + "\n",
        );
        const got = readDeliverySteps(uri);
        expect(got).toHaveLength(1);
        expect(got[0]!.systemPlaces).toEqual([]);
        expect(got[0]!.runtimePlaces).toEqual([]);
    });
});
