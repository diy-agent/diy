// tests/core/context-mind.test.ts
// 「大脑账本」的判据：信封文本 → 段（字节），以及多步形态。
//
// 最关键的回归是**块标量**：信封里的值（task.body / facts 的 value）是多行 md，
// 里面常有 `## 标题`、`1. xxx`，甚至 `resolvedBy: ""` 这种**同形状的行**——
// 不跟踪块标量就会把正文切碎（字节凭空多出来、段数翻倍），而这个错误在
// 「总数对得上」时看不出来（它会悄悄把一段拆成两段，各归一个桶）。
import { describe, expect, it } from "vitest";
import { analyzeMind, mindTrend, repeatReads, splitYamlBlocks, utf8Bytes, type MindGroup } from "../../src/shared/context/mind";
import type { StepMessage } from "../../src/shared/context/step-request";

function msg(role: string, text: string, index = 1): StepMessage {
    return { index, role, text, toolCalls: [], chars: text.length, bytes: utf8Bytes(text), tokens: 0 };
}

describe("splitYamlBlocks", () => {
    it("顶层键按 0 缩进切块", () => {
        const text = ["help: |", "  a", "system: |", "  b", "runtime:", "  facts: 1"].join("\n");
        expect(splitYamlBlocks(text, 0).map((b) => b.key)).toEqual(["help", "system", "runtime"]);
    });

    it("块标量正文里的「像键的行」不算新块", () => {
        // 正文里有 0 缩进的 `resolvedBy: ""`（真实信封里会出现：facts 的值被缩进渲染后仍可能顶格？）
        const text = ["task:", "  body: |", "    ## 目标", "    resolvedBy: \"\"", "  title: x"].join("\n");
        const blocks = splitYamlBlocks(text, 2);
        expect(blocks.map((b) => b.key)).toEqual(["body", "title"]);
        expect(blocks[0]!.text).toContain("resolvedBy");
    });

    it("列表项用值作名字（chain 的每个文件一段）", () => {
        const text = ["chain:", "  - path: /Users/ccc/AGENTS.md", "    content: |", "      x", "  - path: /tmp/b.md", "    content: |", "      y"].join("\n");
        expect(splitYamlBlocks(text, 2).map((b) => b.key)).toEqual(["/Users/ccc/AGENTS.md", "/tmp/b.md"]);
    });
});

describe("analyzeMind", () => {
    const systemMsg = msg(
        "system",
        [
            "help: |",
            "  about: 信封说明",
            "system:",
            "  chain:",
            "    - path: /Users/ccc/AGENTS.md",
            "      content: |",
            "        # root",
            "  rules: |",
            "    - 用中文",
        ].join("\n"),
    );
    const lastUser = msg(
        "user",
        [
            "runtime:",
            "  facts:",
            "    task:",
            "      a: 1",
            "  kb:",
            "    claims: 489",
            "user:",
            "  message: |",
            "    继续",
        ].join("\n"),
    );

    it("段粒度：chain 拆到每个文件、runtime 拆到二级键、user.message 单列 input", () => {
        const { segments } = analyzeMind([systemMsg, msg("assistant", "好的"), msg("tool", "输出"), lastUser]);
        expect(segments.map((s) => s.key)).toEqual(
            expect.arrayContaining(["help", "chain · /Users/ccc/AGENTS.md", "system.rules", "历史 · assistant（含工具调用参数）", "历史 · tool", "runtime.facts", "runtime.kb", "user"]),
        );
    });

    it("非信封的 user 消息在 input 组下不叫「历史」（标签与分组不许互相矛盾）", () => {
        // 实测踩点：一条 18759 B 的 user 消息落在 group=input，标签却写 `历史 · user`，
        // 读的人会以为分组算错了。标签前缀必须跟 roleGroup 走。
        const plain = analyzeMind([msg("user", "继续")]);
        expect(plain.segments[0]!.group).toBe("input");
        expect(plain.segments[0]!.key).toBe("输入 · user");
        // 多轮里的旧发言仍归 history，标签照旧
        const old = analyzeMind([msg("user", "上一轮的话"), msg("assistant", "好")]);
        expect(old.segments.filter((s) => s.group === "history").map((s) => s.key)).not.toContain("历史 · user");
    });

    it("分组求和 = 总字节（不多不少，否则账本自己就错了）", () => {
        const { segments, totalBytes, byGroup } = analyzeMind([systemMsg, msg("assistant", "好的"), lastUser]);
        expect(segments.reduce((n, s) => n + s.bytes, 0)).toBe(totalBytes);
        expect((Object.keys(byGroup) as MindGroup[]).reduce((n, k) => n + byGroup[k], 0)).toBe(totalBytes);
        expect(byGroup.system).toBeGreaterThan(0);
        expect(byGroup.input).toBeGreaterThan(0);
    });
});

describe("repeatReads / mindTrend", () => {
    it("同参数重复算重复读；不同参数不算", () => {
        const sig = repeatReads([
            { step: 1, toolCalls: [{ name: "read", argsPreview: '{"path":"a.ts"}'.slice(0, 20) }] },
            { step: 2, toolCalls: [{ name: "read", argsPreview: '{"path":"a.ts"}'.slice(0, 20) }] },
            { step: 3, toolCalls: [{ name: "read", argsPreview: '{"path":"b.ts"}'.slice(0, 20) }] },
        ]);
        expect(sig).toHaveLength(1);
        expect(sig[0]!.times).toBe(2);
        expect(sig[0]!.steps).toEqual([1, 2]);
    });

    it("历史占比过 70% 时指出是哪一步", () => {
        const t = mindTrend([
            { step: 1, reqBytes: 100, byGroup: { history: 20, system: 40, runtime: 30, input: 10, help: 0, tools: 0 } },
            { step: 2, reqBytes: 200, byGroup: { history: 180, system: 10, runtime: 5, input: 5, help: 0, tools: 0 } },
        ]);
        expect(t.historyHeavyAt).toBe(2);
        expect(t.historyShare).toBeCloseTo(0.9);
    });
});
