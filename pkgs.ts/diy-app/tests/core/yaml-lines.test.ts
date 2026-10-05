// tests/core/yaml-lines.test.ts
// 🎯 请求 YAML 预览的纯逻辑：序列化 / 折叠 / 对齐 diff / 默认折叠态
import { describe, it, expect } from "vitest";
import {
    defaultCollapsed,
    diffYamlRows,
    toYamlLines,
    visibleDiffRows,
    visibleLineIndexes,
    yamlText,
    type YamlLine,
} from "../../src/shared/yaml-lines";
import { layerFacts, messageLayerBytes, type RequestView } from "../../src/shared/context/request-view";

describe("toYamlLines", () => {
    it("对象：键序保持、缩进 2 空格一层", () => {
        const lines = toYamlLines({ a: 1, b: { c: "x" } });
        expect(lines.map((l) => [l.indent, l.text])).toEqual([
            [0, "a: 1"],
            [0, "b:"],
            [1, 'c: "x"'],
        ]);
    });

    it("多行字符串 → 块标量 `|`，每行缩进", () => {
        const lines = toYamlLines({ s: "l1\nl2" });
        expect(lines[0]).toMatchObject({ indent: 0, text: "s: |", foldable: true });
        expect(lines[1]).toMatchObject({ indent: 1, text: "  l1" });
        expect(lines[2]).toMatchObject({ indent: 1, text: "  l2" });
    });

    it("数组：标量 `- v`、对象首键与 `-` 同行", () => {
        const lines = toYamlLines([1, { k: "v" }]);
        expect(lines[0]).toMatchObject({ indent: 0, text: "- 1" });
        expect(lines[1]).toMatchObject({ indent: 0, text: '- k: "v"' });
    });

    it("空容器：`{}` / `[]`，不可折叠", () => {
        const lines = toYamlLines({ o: {}, a: [] });
        expect(lines[0]).toMatchObject({ text: "o: {}", foldable: false });
        expect(lines[1]).toMatchObject({ text: "a: []", foldable: false });
    });

    it("折叠标记：容器头 foldable，标量行不折叠", () => {
        const lines = toYamlLines({ msgs: [{ role: "user" }] });
        expect(lines[0]).toMatchObject({ text: "msgs:", foldable: true });
        expect(lines[1]).toMatchObject({ text: '- role: "user"', foldable: false });
    });
});

describe("折叠", () => {
    const lines: YamlLine[] = [
        { indent: 0, text: "root:", foldable: true, path: "/root" },
        { indent: 1, text: "child:", foldable: true, path: "/root/child" },
        { indent: 2, text: "leaf: 1", foldable: false, path: "/root/child/leaf" },
        { indent: 1, text: "other: 2", foldable: false, path: "/root/other" },
    ];
    it("折叠头 → 隐藏其后更深缩进的行，同级恢复", () => {
        expect(visibleLineIndexes(lines, new Set([1]))).toEqual([0, 1, 3]);
        expect(visibleLineIndexes(lines, new Set([0]))).toEqual([0]);
    });
    it("不折叠 = 全显示", () => {
        expect(visibleLineIndexes(lines, new Set())).toEqual([0, 1, 2, 3]);
    });
});

describe("diffYamlRows", () => {
    const base = toYamlLines({ messages: [{ role: "user", content: "旧" }] });
    const mod = toYamlLines({ messages: [{ role: "user", content: "新" }] });
    it("文本相同的行 → same；不同的行 → del/add", () => {
        const rows = diffYamlRows(base, mod);
        const same = rows.filter((r) => r.t === "same").map((r) => r.left?.text ?? r.right?.text);
        expect(same).toContain("messages:");
        // 同行改动 → change（左右都有）
        expect(rows.some((r) => r.t === "change" && r.left?.text.includes("旧") && r.right?.text.includes("新"))).toBe(true);
    });

    it("mod 少了一整块 → 该块成 del 行（压缩丢轮）", () => {
        const b = toYamlLines({ messages: [{ role: "user" }, { role: "user" }] });
        const m = toYamlLines({ messages: [{ role: "user" }] });
        const rows = diffYamlRows(b, m);
        expect(rows.filter((r) => r.t === "del").length).toBeGreaterThan(0);
    });
});

describe("defaultCollapsed", () => {
    it("折叠「无变化」的节，变化路径保持展开", () => {
        const base = toYamlLines({ a: { x: 1 }, b: { y: 1 } });
        const mod = toYamlLines({ a: { x: 1 }, b: { y: 2 } });
        const rows = diffYamlRows(base, mod);
        const collapsed = defaultCollapsed(rows);
        const visible = visibleDiffRows(rows, collapsed);
        const texts = visible.map((i) => rows[i]!.right?.text ?? rows[i]!.left?.text);
        // b/y 的变化行可见；a 节被折叠（表头仍在，子行隐藏）
        expect(texts.some((t) => t?.includes("y: 2"))).toBe(true);
        expect(texts.some((t) => t?.includes("x: 1"))).toBe(false);
    });
});

describe("layerFacts（事实表）", () => {
    const view = (msgs: unknown[], toolsBytes = 100): RequestView => ({
        model: "m",
        system: "sys",
        tools: [],
        messages: msgs,
        toolsBytes,
    });
    it("分层字节 → token（字节/4）；总输入 = 各层之和", () => {
        const base = view([
            { role: "user", content: "abcd" }, // 4B → 1 tok
            { role: "assistant", content: [{ type: "text", text: "ab" }] },
            { role: "tool", content: [{ type: "tool-result", output: { value: "abcdef" } }] },
        ]);
        const rows = layerFacts(base, base, 1);
        const total = rows[0]!;
        const sum = rows.slice(1).reduce((a, r) => a + r.newTokens, 0);
        expect(total.newTokens).toBe(sum);
        expect(rows.find((r) => r.key === "user")!.newTokens).toBe(1);
        expect(rows.find((r) => r.key === "tool.result")!.newTokens).toBe(2); // 6B/4 → 1.5 → round 2
    });
    it("金额差：按输入单价算，缩减为负（省）", () => {
        const big = view([{ role: "tool", content: [{ type: "tool-result", output: { value: "x".repeat(4000) } }] }]);
        const small = view([{ role: "tool", content: [{ type: "tool-result", output: { value: "x" } }] }]);
        const rows = layerFacts(big, small, 0.14);
        expect(rows[0]!.costDelta).toBeLessThan(0);
    });
});

describe("messageLayerBytes", () => {
    it("按 role/part 类型归集；字符串 content 归 user/assistant.text", () => {
        const b = messageLayerBytes([
            { role: "user", content: "aa" },
            { role: "assistant", content: "bb" },
            { role: "assistant", content: [{ type: "tool-call", input: { command: "ls" } }] },
            { role: "tool", content: [{ type: "tool-result", output: { value: "cc" } }] },
        ]);
        expect(b.user).toBe(2);
        expect(b.assistantText).toBe(2);
        expect(b.assistantTool).toBe(JSON.stringify({ command: "ls" }).length);
        expect(b.toolResult).toBe(2);
    });
});
