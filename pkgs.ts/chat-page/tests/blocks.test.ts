import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@diy-agent/session";
import { toBlocks, wireOf } from "../src/blocks.js";
import type { Block } from "../src/shared.js";

function dataOf(block: Block): Record<string, unknown> {
    return block.data;
}

describe("toBlocks（core 事件 → Block）", () => {
    it("相邻 text-delta 合并成一个 text 块", () => {
        const blocks = toBlocks([
            { type: "text-delta", text: "你" },
            { type: "text-delta", text: "好" },
        ]);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toMatchObject({ kind: "text", id: "b0", data: { text: "你好" } });
    });

    it("相邻 reasoning-delta 合并成 think 块，收尾标 done", () => {
        const blocks = toBlocks([
            { type: "reasoning-delta", text: "想" },
            { type: "reasoning-delta", text: "一下" },
            { type: "text-delta", text: "答案" },
        ]);
        expect(blocks.map((block) => block.kind)).toEqual(["think", "text"]);
        expect(dataOf(blocks[0]!).done).toBe(true);
        expect(dataOf(blocks[0]!).text).toBe("想一下");
    });

    it("tool-call 生成 running 块，tool-result 就地更新（不新增一行）", () => {
        const blocks = toBlocks([
            { type: "tool-call", id: "t1", name: "read", args: { path: "/a" } },
            { type: "tool-result", id: "t1", content: "第一行\n第二行" },
        ]);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toMatchObject({
            kind: "tool",
            data: { name: "read", state: "ok", summary: "第一行 第二行" },
        });
        expect(dataOf(blocks[0]!).output).toBe("第一行\n第二行");
    });

    it("error 事件 → tool 块 state=error", () => {
        const blocks = toBlocks([{ type: "error", message: "炸了" }]);
        expect(blocks[0]).toMatchObject({ kind: "tool", data: { state: "error", summary: "炸了" } });
    });

    it("不认识的 core 事件丢弃（不往 UI 传）", () => {
        const blocks = toBlocks([{ type: "mystery-event", foo: 1 }]);
        expect(blocks).toEqual([]);
    });
});

describe("wireOf（session 消息 → Block 消息线）", () => {
    it("普通正文 → text 块", () => {
        const messages = wireOf([
            { role: "user", text: "你好" },
            { role: "assistant", text: "在" },
        ]);
        expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(messages[0]?.blocks[0]).toMatchObject({ kind: "text", data: { text: "你好" } });
    });

    it("tool-call 消息 → tool 块；随后的 tool-result 消息更新它而不是单开一行", () => {
        const history: ChatMessage[] = [
            { role: "user", text: "读文件" },
            {
                role: "assistant",
                type: "tool-call",
                data: { tool: { id: "c1", name: "read", args: { path: "/a" } } },
            },
            { role: "tool", type: "tool-result", text: "文件内容" },
            { role: "assistant", text: "读完了" },
        ];
        const messages = wireOf(history);
        expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
        const tool = messages[1]!.blocks[0]!;
        expect(tool).toMatchObject({ kind: "tool", data: { name: "read", state: "ok", output: "文件内容" } });
        expect(messages[2]?.blocks[0]).toMatchObject({ kind: "text", data: { text: "读完了" } });
    });

    it("system 消息不过桥", () => {
        expect(wireOf([{ role: "system", text: "你是助手" }])).toEqual([]);
    });
});
