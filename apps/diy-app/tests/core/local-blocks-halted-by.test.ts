// tests/core/local-blocks-halted-by.test.ts
// 🎯 ##522：整轮被输出上限截断（finish_reason=length）时，本轮的 tool 调用**一次都没执行**
// （ai-sdk `isToolExecutionAllowedFinishReason` 只放行 stop / tool-calls，length 直接 return），
// 所以连「tool-call + 已中断」这一对也不进历史 —— 与 dsh 同口径，不拿伪造的 result 喂模型。
//
// 两个方向都钉住：
//   ① max-tokens 轮：块上有 haltedBy ⇒ 投影里既没有 tool-call 也没有 tool-result；
//   ② 用户按停止（没有 haltedBy）⇒ 照旧成对进历史（那种可能真执行过，绝不能丢）。
import { describe, it, expect } from "vitest";
import {
    BlockStore,
    blocksToMessages,
    interruptedToolPatchesOfTurn,
    type Op,
} from "../../src/main/services/local-blocks";

/** 造一个「一轮 + 一步 + 一条参数完整但没执行的 tool 调用」 */
function seed(): { store: BlockStore; apply: (ops: Op[]) => void } {
    const store = new BlockStore();
    const apply = (ops: Op[]) => ops.forEach((op) => store.apply(op));
    apply([
        { op: "start", id: "t1", kind: "turn" },
        { op: "start", id: "t1_s1", kind: "step", parent: "t1" },
        { op: "start", id: "call_A", kind: "tool", parent: "t1_s1", meta: { tool: "read", status: "streaming" } },
        { op: "patch", id: "call_A", fields: { input: '{"path":"/a.ts"}', args: { path: "/a.ts" }, status: "running" } },
    ]);
    return { store, apply };
}

const toolParts = (msgs: ReturnType<typeof blocksToMessages>) =>
    msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter(
        (p) => p.type === "tool-call" || p.type === "tool-result",
    );

describe("##522 输出上限截断轮的 tool 调用不进历史", () => {
    it("haltedBy=max-tokens ⇒ 整条 tool 调用不投影（既不提交 tool-call，也不伪造 result）", () => {
        const { store, apply } = seed();
        apply(interruptedToolPatchesOfTurn(store, "t1", { haltedBy: "max-tokens" }));
        // 块的终态仍然写入（UI 要显示「这条被截断了」），只是不交给模型
        const block = store.blocks.get("call_A")!;
        expect(block.status).toBe("interrupted");
        expect(block.haltedBy).toBe("max-tokens");
        expect(toolParts(blocksToMessages(store))).toEqual([]);
    });

    it("用户按停止（不带 haltedBy）⇒ 照旧成对进历史：tool-call + 「已中断」结果", () => {
        const { store, apply } = seed();
        apply(interruptedToolPatchesOfTurn(store, "t1"));
        const parts = toolParts(blocksToMessages(store));
        expect(parts.map((p) => p.type)).toEqual(["tool-call", "tool-result"]);
        expect(store.blocks.get("call_A")!.status).toBe("interrupted");
        expect(store.blocks.get("call_A")!.haltedBy).toBeUndefined();
    });

    it("已执行完（status=done、有结果）的调用不受影响 —— 截断发生在它之后也一样进历史", () => {
        const { store, apply } = seed();
        apply([
            { op: "patch", id: "call_A", fields: { status: "done", output: "内容" } },
            { op: "stop", id: "call_A" },
        ]);
        // 收轮时对已终态块不会再发 patch（幂等），haltedBy 也就不会落到它身上
        apply(interruptedToolPatchesOfTurn(store, "t1", { haltedBy: "max-tokens" }));
        const parts = toolParts(blocksToMessages(store));
        expect(parts.map((p) => p.type)).toEqual(["tool-call", "tool-result"]);
        expect(store.blocks.get("call_A")!.haltedBy).toBeUndefined();
    });
});
