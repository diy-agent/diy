// ##406 刀 2：装配后的**出口硬上限**。
//
// 病灶（##401 实测）：`must` 级不占预算、`clip:full` 一字不裁 ⇒ 「预算 20 KB」与「实发 4.95 MB」
// 可以同时成立。`plan check` 的 1 MiB 兜底只在**离线量**里成立，运行时装配完没有闸。
// 本组用例就是那道闸的判据：装完超上限 ⇒ 降级（full→headtail / 按上限逐单元收 / 整段丢保底级），
// **绝不原样发**。
import { describe, expect, it } from "vitest";
import {
    runPlan,
    runPlanBounded,
    defaultBudgetPlan,
    recentSteps,
    exemptStage,
    plan,
} from "../../src/main/services/compaction-plan";
import type { LocalModelMessage } from "../../src/main/services/local-blocks";
import { utf8Bytes, type ClipSpec, type ReasoningClipSpec } from "../../src/shared/context/compaction";

const user = (t: string, text: string): LocalModelMessage => ({ role: "user", content: text, turn: t });
const call = (t: string, id: string, step: string): LocalModelMessage => ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "bash", input: {} }],
    turn: t,
    step,
});
const result = (t: string, id: string, v: string, step: string): LocalModelMessage => ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName: "bash", output: { type: "text", value: v } }],
    turn: t,
    step,
});

const HARD_TOOL_CAP = 100 * 1024;

/**
 * 成本口径（与 `local-blocks.costOfWith` 同形，但把"裁剪后还剩多少"简化为上限）：
 *   · `full` / 未声明 ⇒ 原始字节（保底级就是靠这个"不裁"）
 *   · `headtail`     ⇒ 至多 `HARD_TOOL_CAP`（= 单条工具结果硬顶，##406 刀 3）
 * 真实实现走 `clipToolResult`；这里只要「有界 vs 无界」这一件事，不引 IO。
 */
const costOf = (m: LocalModelMessage, clip: ClipSpec | null, _r?: ReasoningClipSpec | null): number => {
    const raw = utf8Bytes(JSON.stringify({ role: m.role, content: m.content }));
    if (clip === null || clip.type === "full") return raw;
    return Math.min(raw, HARD_TOOL_CAP);
};

/** 6 步、每步一条 5 MB 工具结果（= ##401 那类"几步就能撑爆"的会话） */
function hugeSession(): LocalModelMessage[] {
    const huge = "x".repeat(5_000_000);
    const all: LocalModelMessage[] = [user("t0", "旧的用户发言，应当尽可能保留")];
    for (let i = 1; i <= 6; i++) {
        const step = `s${i}`;
        all.push(call(`t${i}`, `c${i}`, step), result(`t${i}`, `c${i}`, `${i}:${huge}`, step));
    }
    return all;
}

describe("runPlanBounded：装配后硬上限（##406 刀 2）", () => {
    const all = hugeSession();
    const capBytes = 400 * 1024;

    it("反证：不加闸时 keptBytes 远超上限（这就是 ##401 的死锁机理）", () => {
        const base = runPlan(all, defaultBudgetPlan(20 * 1024), { costOf });
        expect(base.keptBytes).toBeGreaterThan(capBytes * 50); // 30 MB 量级
    });

    it("超上限 ⇒ 落进上限，且记录降级（clip 降级 / 按上限逐个收）", () => {
        const s = runPlanBounded(all, defaultBudgetPlan(20 * 1024), { costOf }, capBytes);
        expect(s.keptBytes).toBeLessThanOrEqual(capBytes);
        expect(s.hardCap?.withinCap).toBe(true);
        expect(s.hardCap?.capBytes).toBe(capBytes);
        const kinds = s.hardCap?.degradations.map((d) => d.kind) ?? [];
        expect(kinds.length).toBeGreaterThan(0);
        expect(kinds).toContain("clip");
        // 保底级被保留的那些消息，裁法必须是降级后的 headtail（不能再有 full）
        const mustClips = (s.clips ?? []).filter((c): c is ClipSpec => c !== null);
        expect(mustClips.length).toBeGreaterThan(0);
        expect(mustClips.every((c) => c.type === "headtail")).toBe(true);
    });

    it("配对铁律仍成立：保留下来的 tool-call 一定有它的 result，反之亦然", () => {
        const s = runPlanBounded(all, defaultBudgetPlan(20 * 1024), { costOf }, capBytes);
        const kept = new Set(s.kept);
        const idOf = (m: LocalModelMessage): string | undefined => {
            if (typeof m.content === "string") return undefined;
            const p = m.content[0] as { type: string; toolCallId?: string };
            return p.type === "tool-call" || p.type === "tool-result" ? p.toolCallId : undefined;
        };
        for (let i = 0; i < all.length; i++) {
            const m = all[i]!;
            const id = idOf(m);
            if (!id) continue;
            const otherRole = m.role === "assistant" ? "tool" : "assistant";
            const j = all.findIndex((x, k) => k !== i && x.role === otherRole && idOf(x) === id);
            expect(kept.has(i)).toBe(kept.has(j));
        }
    });

    it("上限小到连保底级都放不下 ⇒ 整段丢保底级（回到纯预算路径），并如实记录", () => {
        const s = runPlanBounded(all, defaultBudgetPlan(20 * 1024), { costOf }, 16 * 1024);
        expect(s.hardCap?.degradations.some((d) => d.kind === "drop-must")).toBe(true);
        expect(s.keptBytes).toBeLessThanOrEqual(16 * 1024);
    });

    it("不设上限（cap ≤ 0）⇒ 与 runPlan 逐字节相同（老调用点行为不变）", () => {
        const p = defaultBudgetPlan(20 * 1024);
        const a = runPlan(all, p, { costOf });
        const b = runPlanBounded(all, p, { costOf }, 0);
        expect(b.kept).toEqual(a.kept);
        expect(b.keptBytes).toBe(a.keptBytes);
        expect(b.hardCap?.degradations).toEqual([]);
        expect(b.hardCap?.withinCap).toBe(true);
    });

    it("runPlan 的 mustCapBytes：新的步先留、装不下就不留，但至少留第一个单元", () => {
        const all2 = [user("t0", "u"), call("t1", "c1", "s1"), result("t1", "c1", "x".repeat(200_000), "s1"),
            call("t2", "c2", "s2"), result("t2", "c2", "y".repeat(200_000), "s2")];
        const p = plan(20 * 1024, exemptStage(recentSteps(2), { clip: { type: "full" } }));
        const s = runPlan(all2, p, { costOf }, { mustCapBytes: 250 * 1024 });
        // 新的一步（s2）装进 250 KB，老的一步（s1）装不下 ⇒ 丢掉
        expect(s.kept).toEqual([3, 4]);
    });
});
