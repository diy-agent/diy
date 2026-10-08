// tests/core/yaml-lines.test.ts
// 🎯 请求 YAML 预览的纯逻辑：序列化 / 折叠 / 对齐 diff / 默认折叠态
import { describe, it, expect } from "vitest";
import {
    collapsedAtLevel,
    defaultCollapsed,
    diffValues,
    foldDepths,
    foldLevelCount,
    subtreeChanges,
    toYamlLines,
    visibleDiffRows,
    visibleLineIndexes,
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

describe("diffValues（两级 diff：先节点、再文本）", () => {
    it("节点相同 → 整棵 same；不重复渲染", () => {
        const v = { messages: [{ role: "user", content: "x" }] };
        const rows = diffValues(v, v);
        expect(rows.every((r) => r.t === "same")).toBe(true);
    });

    it("数组丢元素 → **整棵子树全 del**（不再半白半红）", () => {
        const b = { messages: [{ role: "user", content: "第1轮" }, { role: "assistant", content: "答复" }, { role: "user", content: "第2轮" }] };
        const m = { messages: [{ role: "user", content: "第2轮" }] };
        const rows = diffValues(b, m);
        // 第1轮与答复：其所有行都是 del（含 `- role:` 头行）
        const delTexts = rows.filter((r) => r.t === "del").map((r) => r.left?.text ?? "");
        expect(delTexts.some((t) => t.includes("第1轮"))).toBe(true);
        expect(delTexts.some((t) => t.includes("- role:"))).toBe(true);
        // 保留的第2轮及其所有行都是 same（不出现「同一元素里有的白有的红」）
        const keepRows = rows.filter((r) => (r.right?.text ?? "").includes("第2轮"));
        expect(keepRows.every((r) => r.t === "same")).toBe(true);
    });

    it("对象同 key 标量变 → change（左右都有）", () => {
        const rows = diffValues({ messages: [{ role: "user", content: "旧" }] }, { messages: [{ role: "user", content: "新" }] });
        expect(rows.some((r) => r.t === "change" && r.left?.text.includes("旧") && r.right?.text.includes("新"))).toBe(true);
        // `- role: "user"` 未变 → same
        expect(rows.some((r) => r.t === "same" && r.left?.text.includes('role: "user"'))).toBe(true);
    });

    it("工具输出（多行块标量）变 → 只在块内逐行 diff，外层结构仍 same", () => {
        const out = (n: number) => Array.from({ length: n }, (_, i) => `row ${i}`).join("\n");
        const clipped = ["row 0", "row 1", "row 2", "[... 中间省略 ...]", "row 27", "row 28", "row 29"].join("\n");
        const b = { messages: [{ role: "tool", content: [{ type: "tool-result", output: { type: "text", value: out(30) } }] }] };
        const m = { messages: [{ role: "tool", content: [{ type: "tool-result", output: { type: "text", value: clipped } }] }] };
        const rows = diffValues(b, m);
        // 头 3 行保留 → same
        expect(rows.some((r) => r.t === "same" && r.left?.text.trim() === "row 0")).toBe(true);
        expect(rows.some((r) => r.t === "same" && r.left?.text.trim() === "row 29")).toBe(true);
        // 中间被删 → del
        expect(rows.some((r) => r.t === "del" && r.left?.text.includes("row 3"))).toBe(true);
        // 外层 key 未变 → same（说明没把整条消息标红）
        expect(rows.some((r) => r.t === "same" && r.left?.text.includes('role: "tool"'))).toBe(true);
    });

    it("数组前插一个元素（摘要）→ 该元素 add，其余 same", () => {
        const b = { messages: [{ role: "user", content: "A" }] };
        const m = { messages: [{ role: "user", content: "<summary>…</summary>" }, { role: "user", content: "A" }] };
        const rows = diffValues(b, m);
        expect(rows.some((r) => r.t === "add" && r.right?.text.includes("summary"))).toBe(true);
        expect(rows.some((r) => r.t === "same" && r.left?.text.includes("A"))).toBe(true);
    });
});

describe("defaultCollapsed", () => {
    it("折叠「无变化」的节，变化路径保持展开", () => {
        const rows = diffValues({ a: { x: 1 }, b: { y: 1 } }, { a: { x: 1 }, b: { y: 2 } });
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

describe("逐级展开（foldDepths / collapsedAtLevel）+ 变更点", () => {
    // 构造「可折叠深度跳级」的场景：可折叠行在 indent 0 与 2（没有 1）
    const rows = diffValues({ a: { b: { c: 1 } }, d: 2 }, { a: { b: { c: 9 } }, d: 2 });

    it("foldDepths 用实际存在的折叠深度（去重升序），不是连续整数", () => {
        const depths = foldDepths(rows);
        expect(depths).toEqual([...new Set(depths)].sort((a, b) => a - b));
        expect(depths).toContain(0);
        expect(depths).toContain(1); // `a:` 的子键 `b:` 在 indent1
    });

    it("每一档展开都必然多露出内容（不存在「点了没反应」的空档）", () => {
        const n = foldLevelCount(rows);
        expect(n).toBeGreaterThan(1);
        let prev = -1;
        for (let lv = 0; lv <= n; lv++) {
            const vis = visibleDiffRows(rows, collapsedAtLevel(rows, lv)).length;
            expect(vis).toBeGreaterThan(prev); // 严格递增
            prev = vis;
        }
        // 最高档 = 全展开
        expect(collapsedAtLevel(rows, n).size).toBe(0);
    });

    it("subtreeChanges：折叠节点带出子树内的增减计数；无变化的节点为 0", () => {
        const ch = subtreeChanges(rows);
        // a 的子树含变更（c: 1 → c: 9）
        const aIdx = rows.findIndex((r) => (r.right?.text ?? r.left?.text ?? "") === "a:");
        expect(ch.get(aIdx)!.add + ch.get(aIdx)!.del).toBeGreaterThan(0);
        // d 无变化
        const dIdx = rows.findIndex((r) => (r.right?.text ?? r.left?.text ?? "") === "d: 2");
        expect(ch.get(dIdx)?.add ?? 0).toBe(0);
        expect(ch.get(dIdx)?.del ?? 0).toBe(0);
    });
});
