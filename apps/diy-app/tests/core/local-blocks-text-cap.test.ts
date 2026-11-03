// tests/core/local-blocks-text-cap.test.ts
// 🎯 ##93 D：Text 字段硬顶 —— 渲染端常驻内存与会话长度/单块长度解耦
//
// 判据（任务 93）：
//   ① 3.28 M 字符的单块，渲染端 store 里该字段常驻 < 200 KB（头 64 KB + 尾 64 KB + 标记）；
//   ② 裁剪**必须可见**：值里要有一行显式标注（不许静默拼成看起来连续的文本）；
//   ③ 计数必须准：`__cap.total` = 完整字符数、`omitted` = 被省掉的字符数 —— 后续 delta 继续累加，
//     patch 整体覆盖时按新值重算；
//   ④ 默认关：main 侧那份 store 是投递真源（`blocksToMessages` 靠全文重建 messages），裁了就是丢上下文。

import { describe, it, expect } from "vitest";
import { BlockStore, RENDER_TEXT_CAP, compactOps, displayText, toTree, type Op } from "../../src/main/services/local-blocks";
import { parseCutMarkers } from "@diy-agent/context/format/cut-marker";

const store = () => new BlockStore({ textCap: RENDER_TEXT_CAP });
const textOf = (s: BlockStore, id: string) => displayText(s.blocks.get(id));

describe("Text 硬顶（##93 D）", () => {
    it("默认关：main 侧 store 不裁（全文留给投递）", () => {
        const s = new BlockStore();
        const big = "x".repeat(300_000);
        s.apply({ op: "start", id: "t1", kind: "text" });
        s.apply({ op: "delta", id: "t1", fields: { content: big } });
        expect(textOf(s, "t1").length).toBe(300_000);
        expect(s.blocks.get("t1")!.__cap).toBeUndefined();
    });

    it("超顶即裁：常驻 ≤ head+tail+标记，且中间内容确实不在内存里", () => {
        const s = store();
        s.apply({ op: "start", id: "t1", kind: "text" });
        s.apply({ op: "delta", id: "t1", fields: { content: "A".repeat(64 * 1024) } });
        s.apply({ op: "delta", id: "t1", fields: { content: "MIDDLE-SHOULD-VANISH" } });
        s.apply({ op: "delta", id: "t1", fields: { content: "B".repeat(64 * 1024) } });
        const v = textOf(s, "t1");
        expect(v).not.toContain("MIDDLE-SHOULD-VANISH"); // 中段已被丢掉（真省内存，不是只改显示）
        expect(v.length).toBeLessThan(RENDER_TEXT_CAP.head + RENDER_TEXT_CAP.tail + 200);
        expect(v.startsWith("A")).toBe(true);
        expect(v.endsWith("B")).toBe(true);
        const cap = (s.blocks.get("t1")!.__cap as Record<string, { total: number; omitted: number }>).content!;
        expect(cap.total).toBe(64 * 1024 * 2 + "MIDDLE-SHOULD-VANISH".length);
        expect(cap.omitted).toBe(cap.total - RENDER_TEXT_CAP.head - RENDER_TEXT_CAP.tail);
    });

    it("裁剪可见：值里带显式标注（含省略/全文两个数字）—— ##425 起是 `<cut …/>`", () => {
        const s = store();
        s.apply({ op: "start", id: "t1", kind: "text" });
        s.apply({ op: "delta", id: "t1", fields: { content: "x".repeat(300_000) } });
        const v = textOf(s, "t1");
        // view 档：原文完整（盘上有），只是**这个视图**留了头尾两段；resume 指向 UI 的载入全文
        expect(parseCutMarkers(v).at(0)).toMatchObject({
            by: "renderer-text-cap",
            scope: "view",
            why: "render",
            unit: "chars",
            total: 300_000,
            kept: RENDER_TEXT_CAP.head + RENDER_TEXT_CAP.tail,
            resume: "ui:载入全文",
        });
    });

    it("后续 delta 持续累加计数（裁掉的长度不能凭当前值数出来）", () => {
        const s = store();
        s.apply({ op: "start", id: "t1", kind: "text" });
        s.apply({ op: "delta", id: "t1", fields: { content: "h".repeat(200_000) } });
        let appended = 0;
        for (let i = 0; i < 50; i++) {
            const piece = `chunk-${i};`;
            appended += piece.length;
            s.apply({ op: "delta", id: "t1", fields: { content: piece } });
        }
        const cap = (s.blocks.get("t1")!.__cap as Record<string, { total: number }>).content!;
        expect(cap.total).toBe(200_000 + appended);
        expect(textOf(s, "t1").length).toBeLessThan(RENDER_TEXT_CAP.head + RENDER_TEXT_CAP.tail + 200);
    });

    it("patch 覆盖：按新值的完整长度重算，不叠旧计数", () => {
        const s = store();
        s.apply({ op: "start", id: "t1", kind: "text" });
        s.apply({ op: "delta", id: "t1", fields: { content: "x".repeat(300_000) } });
        s.apply({ op: "patch", id: "t1", fields: { content: "y".repeat(10) } });
        expect(textOf(s, "t1")).toBe("y".repeat(10)); // 回到不裁状态
        expect(s.blocks.get("t1")!.__cap).toEqual({});
        s.apply({ op: "patch", id: "t1", fields: { content: "z".repeat(400_000) } });
        const cap = (s.blocks.get("t1")!.__cap as Record<string, { total: number }>).content!;
        expect(cap.total).toBe(400_000);
    });

    it("工具输出（tool.output）同样受硬顶保护", () => {
        const s = store();
        s.apply({ op: "start", id: "x1", kind: "tool", meta: { tool: "bash" } });
        s.apply({ op: "delta", id: "x1", fields: { output: "o".repeat(500_000) } });
        expect(textOf(s, "x1").length).toBeLessThan(RENDER_TEXT_CAP.head + RENDER_TEXT_CAP.tail + 200);
    });

    it("3.28 M 字符单块：store 里该字段常驻 < 200 KB（判据①②）", () => {
        const chunk = "0123456789\n".repeat(298); // ≈ 3289 字符/条
        const n = 997; // ≈ 3.28 M
        const ops: Op[] = [{ op: "start", id: "t1", kind: "text" }];
        for (let i = 0; i < n; i++) ops.push({ op: "delta", id: "t1", fields: { content: chunk } });
        const s = store();
        for (const op of ops) s.apply(op);
        const full = chunk.length * n;
        expect(full).toBeGreaterThan(3_200_000);
        const v = textOf(s, "t1");
        expect(v.length).toBeLessThan(200 * 1024);
        const cap = (s.blocks.get("t1")!.__cap as Record<string, { total: number }>).content!;
        expect(cap.total).toBe(full);
        // 导出的 attrs 里能看到计数（UI 靠它说「≥ N 行」/「按需加载」）
        const node = toTree(s, "t1");
        expect((node.attrs.__cap as Record<string, { total: number }>).content!.total).toBe(full);
    });

    it("裁剪计数不进折叠流（compactOps 不把 __cap 当块数据写出）", () => {
        const s = store();
        s.apply({ op: "start", id: "t1", kind: "text", parent: null });
        s.apply({ op: "delta", id: "t1", fields: { content: "x".repeat(300_000) } });
        const compact = compactOps(s);
        const fields = compact.find((o) => o.op === "patch")!.fields as Record<string, unknown>;
        expect(fields.__cap).toBeUndefined();
        expect(parseCutMarkers(String(fields.content)).at(0)?.by).toBe("renderer-text-cap");
    });

    // ── surrogate 边界（##8 的 agent review 里指出的真 bug：切在代理对中间 ⇒ U+FFFD 不可逆损坏）
    it("代理对边界：emoji 单字重复，切点必落在代理对中间也不许出 U+FFFD", () => {
        const s = store();
        s.apply({ op: "start", id: "t1", kind: "text" });
        // 每个 🎉 = 2 个 code unit ⇒ 64K 切点必然落在某个代理对中间
        s.apply({ op: "delta", id: "t1", fields: { content: "🎉".repeat(200_000) } });
        const v = textOf(s, "t1");
        expect(v).not.toContain("\uFFFD");
        // 头尾各自都是完整的 emoji 序列（不许出现孤立代理）
        expect(/^[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(v)).toBe(true);
        expect(/[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(v)).toBe(true);
        expect(parseCutMarkers(v).at(0)?.by).toBe("renderer-text-cap");
    });

    it("代理对边界：中文 + emoji 混排，尾切点落在低代理上也不许出 U+FFFD", () => {
        const s = store();
        s.apply({ op: "start", id: "t1", kind: "text" });
        let chunk = "";
        for (let i = 0; i < 40_000; i++) chunk += i % 7 === 0 ? "🎉😀" : "汉字";
        s.apply({ op: "delta", id: "t1", fields: { content: chunk } });
        s.apply({ op: "delta", id: "t1", fields: { content: chunk } });
        const v = textOf(s, "t1");
        expect(v).not.toContain("\uFFFD");
        expect(v).toContain("🎉");
        // 计数与显示值一致：省略数 = 总数 - 实际留下的字符数
        const cap = (s.blocks.get("t1")!.__cap as Record<string, { total: number; omitted: number }>).content!;
        const shown = v.replace(/\n\n`<cut [^>]*\/>`\n\n/, "");
        expect(cap.total).toBe(chunk.length * 2);
        expect(cap.omitted).toBe(cap.total - shown.length);
    });

    it("标记里的数字不依赖 ICU：同一段文本在任何 locale 下一致", () => {
        const s = store();
        s.apply({ op: "start", id: "t1", kind: "text" });
        s.apply({ op: "delta", id: "t1", fields: { content: "x".repeat(300_000) } });
        // 数字一律裸十进制（不受 locale / ICU 影响）：省略 168,928 = 300,000 - 131,072
        expect(textOf(s, "t1")).toContain('total="300000" kept="131072"');
    });

    it("浏览器环境（没有全局 Buffer）也能应用大块：本模块不依赖 Node 内置", () => {
        // 现场（##93 合入后）：renderer 里 `Buffer is not defined` → op 应用失败被跳过 →
        // 大块内容凭空消失（不报错、不显示）。这条用例把 Buffer 拿掉，模拟 renderer。
        const g = globalThis as { Buffer?: unknown };
        const saved = g.Buffer;
        try {
            delete g.Buffer;
            const s = store();
            s.apply({ op: "start", id: "t1", kind: "text" });
            s.apply({ op: "delta", id: "t1", fields: { content: "x".repeat(300_000) } });
            const v = textOf(s, "t1");
            expect(v.length).toBeGreaterThan(100_000);
            expect(v).not.toContain("\uFFFD");
        } finally {
            g.Buffer = saved;
        }
    });
});
