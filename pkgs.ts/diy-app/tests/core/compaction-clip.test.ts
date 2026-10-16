// tests/core/compaction-clip.test.ts
// 🎯 裁剪能力轴（##343 M1）—— 每条取法可声明 `clip`：`full | path | headtail{…}`。
//
// 钉住两条验收：
//   ① **保底全量**：保底级（最近 N 步）声明 `clip: full` ⇒ 这几步的工具结果**字节保真**
//      （不被全局 headtail 裁）；其余旧消息照旧裁。
//   ② **先选中级生效**：一条消息被多级选中 → 取**先声明**它的那一级（后到的级改不动它）。
// 外加读侧兼容：无人声明 clip ⇒ 结果里不带 `clips` 字段。

import { describe, it, expect } from "vitest";
import {
    runPlan,
    plan,
    stage,
    exemptStage,
    byLadder,
    byRole,
    recentSteps,
    CLIP_FULL,
    DEFAULT_EXEMPT_STEPS,
    defaultBudgetPlan,
} from "../../src/main/services/compaction-plan";
import { blocksToMessages, BlockStore, type Op } from "../../src/main/services/local-blocks";
import type { LocalModelMessage } from "../../src/main/services/local-blocks";
import {
    makeDeliveryTransform,
    utf8Bytes,
    type ClipSpec,
    type CompactPolicy,
} from "../../src/shared/context/compaction";

const HEADTAIL: ClipSpec = { type: "headtail", data: { head: 1, tail: 1, maxLineChars: 100, maxKeepBytes: 200 } };

const user = (t: string, text: string, step?: string): LocalModelMessage => ({
    role: "user",
    content: text,
    turn: t,
    ...(step ? { step } : {}),
});

/** 成本口径：`full` 假装很贵（大），其余按消息字节 —— 只为验证「按级 clip 现算」这件事 */
const costOf = (m: LocalModelMessage, clip: ClipSpec | null): number =>
    clip?.type === "full" ? 100_000 : utf8Bytes(JSON.stringify(m));

describe("能力轴（runPlan 级）", () => {
    it("先选中级生效：同一消息被多级选中 → 取先声明者", () => {
        const all = [user("t1", "u1", "t1_s1")];
        const p = plan(
            1_000_000,
            exemptStage(recentSteps(1), { clip: CLIP_FULL }),
            exemptStage(byRole("user"), { clip: HEADTAIL }),
        );
        const s = runPlan(all, p, { costOf });
        expect(s.kept).toEqual([0]);
        expect(s.clips?.[0]).toEqual(CLIP_FULL); // 第二级的 HEADTAIL 改不动它
    });

    it("级声明了 clip、该消息却由**不声明 clip** 的级选中 ⇒ clips[i] = null（回落 defaultClip）", () => {
        const all = [user("t1", "u1", "t1_s1")];
        const p = plan(1_000_000, stage(byLadder()), exemptStage(recentSteps(1), { clip: CLIP_FULL }));
        const s = runPlan(all, p, { costOf });
        expect(s.kept).toEqual([0]);
        expect(s.clips?.[0]).toBeNull();
    });

    it("无人声明 clip ⇒ 不带 clips 字段（读侧兼容）", () => {
        const all = [user("t1", "u1")];
        const s = runPlan(all, plan(1_000, stage(byLadder())), { costOf });
        expect(s.clips).toBeUndefined();
    });

    it("成本按**该级**的 clip 现算：full 级的贵价不得被裁过的低价顶掉", () => {
        const all = [user("t1", "u1", "t1_s1")];
        // full 级成本 100_000 > 预算 1 ⇒ 托底（exempt）不花预算，故仍入选；换 count 级就该放不下
        const exempt = runPlan(all, plan(1, exemptStage(recentSteps(1), { clip: CLIP_FULL })), { costOf });
        expect(exempt.kept).toEqual([0]);
        const counted = runPlan(all, plan(1, stage(recentSteps(1), { clip: CLIP_FULL })), { costOf });
        expect(counted.kept).toEqual([]);
    });

    it("默认管道的保底步数 = 6（用户 2026-10-15 定）", () => {
        expect(DEFAULT_EXEMPT_STEPS).toBe(6);
        const stages = defaultBudgetPlan(1024, HEADTAIL).stages;
        expect(stages[0]!.budget).toBe("exempt");
        expect(stages[0]!.clip).toEqual(CLIP_FULL);
        // 阶梯级**不声明** clip ⇒ 渲染时回落 `defaultClip`（= HEADTAIL）——##344 M2 起缺省管道由
        // `DEFAULT_KEEP`（数据）生成，「未声明」与「显式写 defaultClip」在渲染上同一件事（`clip ?? defaultClip`）。
        expect(stages[1]!.clip).toBeUndefined();
    });
});

// ── 投递链路的端到端：块树 → 选择 → 渲染（clip 必须**带过两段**）──

/** 造 `turns` 轮，每轮一个 step + 一条 bash 调用，输出 `lines` 行 `T<i>-L<k>` */
function storeWithTurns(turns: number, lines: number): BlockStore {
    const s = new BlockStore();
    for (let i = 1; i <= turns; i++) {
        const t = `t${i}`;
        const ops: Op[] = [
            { op: "start", id: t, kind: "turn" },
            { op: "start", id: `${t}_u`, kind: "text", parent: t, meta: { role: "user" } },
            { op: "delta", id: `${t}_u`, fields: { content: `问 ${i}` } },
            { op: "stop", id: `${t}_u` },
            { op: "start", id: `${t}_s1`, kind: "step", parent: t },
            { op: "start", id: `call_${i}`, kind: "tool", parent: `${t}_s1`, meta: { tool: "bash", status: "running" } },
            // `args` 是 Flag 字段：只认 start 的 meta 与 patch（delta 会被忽略）——与真日志一致
            { op: "patch", id: `call_${i}`, fields: { tool: "bash", args: { command: `cat big${i}.txt` }, status: "running" } },
            {
                op: "delta",
                id: `call_${i}`,
                fields: { output: Array.from({ length: lines }, (_, k) => `T${i}-L${k + 1}`).join("\n") },
            },
            { op: "patch", id: `call_${i}`, fields: { status: "done" } },
            { op: "stop", id: `call_${i}` },
            { op: "stop", id: `${t}_s1` },
            { op: "stop", id: t },
        ];
        for (const op of ops) s.apply(op);
    }
    return s;
}

/** 全局策略 = headtail 1/1（裁得很狠：中间行必丢）——「保底全量」是否成立一眼可辨 */
const POLICY: CompactPolicy = {
    mode: "budget",
    modeData: {
        budgetBytes: 20 * 1024,
        toolResult: { render: "headtail", renderData: { head: 1, tail: 1, maxLineChars: 100, maxKeepBytes: 200 } },
    },
    summary: false,
};

const deliveryOpts = () => makeDeliveryTransform(POLICY, (id) => `local/toolout/${id}.txt`);

/** 投递出来的工具结果 value（按 toolCallId 取） */
function resultValue(msgs: LocalModelMessage[], toolCallId: string): string | undefined {
    for (const m of msgs) {
        if (m.role !== "tool" || typeof m.content === "string") continue;
        for (const p of m.content) {
            if (p.type === "tool-result" && p.toolCallId === toolCallId) return p.output.value;
        }
    }
    return undefined;
}

describe("端到端：保底最近 6 步 `clip: full` 字节保真（##343 M1 验收）", () => {
    const store = storeWithTurns(8, 20);

    it("预算清零：**一条不投**（0 = 用户口径的「清零」，保底不得把它改写）", () => {
        expect(blocksToMessages(store, { ...deliveryOpts(), budgetBytes: 0 })).toEqual([]);
    });

    it("预算极小（1 字节）：只剩保底的最近 6 步，且这 6 步的工具结果**逐字符全量**（含中段行）", () => {
        const msgs = blocksToMessages(store, { ...deliveryOpts(), budgetBytes: 1 });
        const ids = msgs.filter((m) => m.role === "tool").map((m) => (m.content as { toolCallId: string }[])[0]!.toolCallId);
        expect(ids.sort()).toEqual(["call_3", "call_4", "call_5", "call_6", "call_7", "call_8"]);
        // 中段行在 = 没被 headtail 裁（headtail 1/1 会只留首尾两行 + marker）
        for (const id of ids) {
            const v = resultValue(msgs, id)!;
            expect(v).toContain(`T${id.slice(5)}-L10`);
            expect(v).not.toContain("中间省略");
        }
    });

    it("预算充足：旧消息照旧按全局 headtail 裁（中段行丢、有 marker），保底 6 步仍全量", () => {
        const msgs = blocksToMessages(store, { ...deliveryOpts(), budgetBytes: 20 * 1024 });
        // 旧消息（t1）：被裁
        const old = resultValue(msgs, "call_1")!;
        expect(old).toContain("中间省略");
        expect(old).not.toContain("T1-L10");
        expect(old).toContain("local/toolout/call_1.txt"); // marker 给出原文路径
        // 保底消息（t8）：全量
        const kept = resultValue(msgs, "call_8")!;
        expect(kept).toContain("T8-L10");
        expect(kept).not.toContain("中间省略");
    });

    it("对照：全局策略 `asis` 也不该掐死级声明的 clip（更具体者赢）", () => {
        const asis: CompactPolicy = {
            mode: "budget",
            modeData: { budgetBytes: 20 * 1024, toolResult: { render: "asis" } },
            summary: false,
        };
        const msgs = blocksToMessages(store, {
            ...makeDeliveryTransform(asis, (id) => `local/toolout/${id}.txt`),
            budgetBytes: 1,
        });
        // asis 下保底级仍是 full（= asis 本身），字节保真
        expect(resultValue(msgs, "call_8")).toContain("T8-L10");
    });
});
