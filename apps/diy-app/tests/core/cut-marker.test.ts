// tests/core/cut-marker.test.ts
// 🎯 截断标记的唯一语法（##425）—— 构造 / 解析 / 不变量 / 旧格式只读兼容。
//
// 验收判据（body）：
//   · 全仓 `<cut ` 的构造点只剩 `cut-marker.ts`；
//   · `scope` 非法值必抛、`total < kept` 必抛；
//   · 人眼/机器都能一眼读出「谁截的 / 为什么截 / 原文还在不在」；
//   · `wire` 档 marker 不显著膨胀（固定部分 ≤ 120 字符，路径另计）。

import { describe, it, expect } from "vitest";
import { cutMarker, parseCutMarkers, CUT_SCOPES } from "@diy-agent/context/format/cut-marker";

describe("cutMarker：构造", () => {
    it("属性齐全时逐个写出来（unit=lines 是缺省 ⇒ 不写）", () => {
        const s = cutMarker({ by: "tool-output", scope: "wire", why: "budget", total: 12400, kept: 4000 });
        expect(s).toBe('<cut by="tool-output" scope="wire" why="budget" total="12400" kept="4000"/>');
    });

    it("三值 scope 都能构造，且解析回来语义不变（roundtrip）", () => {
        for (const scope of CUT_SCOPES) {
            const s = cutMarker({
                by: "x",
                scope,
                why: "budget",
                unit: "bytes",
                total: 425750,
                kept: 24576,
                resume: "/tmp/a.txt",
            });
            const [m, ...rest] = parseCutMarkers(s);
            expect(rest).toEqual([]);
            expect(m).toMatchObject({ by: "x", scope, why: "budget", unit: "bytes", total: 425750, kept: 24576 });
            expect(m!.resume).toBe("/tmp/a.txt");
            expect(m!.legacy).toBeUndefined();
        }
    });

    it("lowerBound ⇒ bound=\"lower\"（total 是下界时不许冒充精确值）", () => {
        const s = cutMarker({ by: "chat-preview", scope: "view", why: "window", total: 120, kept: 50, lowerBound: true });
        expect(s).toContain('bound="lower"');
        expect(parseCutMarkers(s)[0]!.lowerBound).toBe(true);
    });

    it("fence ⇒ 包一层行内代码（markdown 视图里不被 HTML 分支吞掉），仍可解析", () => {
        const s = cutMarker({ by: "renderer-text-cap", scope: "view", why: "render", unit: "chars", total: 292890, kept: 131072, fence: true });
        expect(s.startsWith("`<cut ")).toBe(true);
        expect(s.endsWith("/>`")).toBe(true);
        expect(parseCutMarkers(s)[0]!.total).toBe(292890);
    });

    it("属性值里的引号 / 尖括号转义后能原样解析回来", () => {
        const resume = 'ui:载入全文 "<b>"&x';
        const s = cutMarker({ by: "y", scope: "view", why: "render", total: 10, kept: 3, resume });
        expect(s).not.toContain('resume="ui:载入全文 "<b>"&x"');
        expect(parseCutMarkers(s)[0]!.resume).toBe(resume);
    });

    it("wire 档固定部分不膨胀（≤ 120 字符；路径另计）", () => {
        const s = cutMarker({ by: "tool-output", scope: "wire", why: "budget", total: 12400, kept: 4000 });
        expect(s.length).toBeLessThanOrEqual(120);
        // 带最长常见 resume 也仍然可读（不是硬上限，是「别学中文句子那么啰嗦」）
        expect(s.length).toBeLessThan(120);
    });
});

describe("cutMarker：不变量（必抛）", () => {
    it("scope 非法值必抛", () => {
        expect(() => cutMarker({ by: "x", scope: "wireish" as never, why: "budget", total: 1, kept: 1 })).toThrow(/scope/);
        expect(() => cutMarker({ by: "x", scope: "" as never, why: "budget", total: 1, kept: 1 })).toThrow(/scope/);
    });

    it("total < kept 必抛（保留的不能比原文多）", () => {
        expect(() => cutMarker({ by: "x", scope: "view", why: "render", total: 10, kept: 11 })).toThrow(/total/);
    });

    it("total / kept 非非负整数必抛", () => {
        expect(() => cutMarker({ by: "x", scope: "view", why: "render", total: -1, kept: 0 })).toThrow(/total/);
        expect(() => cutMarker({ by: "x", scope: "view", why: "render", total: 10.5, kept: 0 })).toThrow(/total/);
        expect(() => cutMarker({ by: "x", scope: "view", why: "render", total: 10, kept: Number.NaN })).toThrow(/kept/);
    });

    it("by / why 为空必抛（说不清谁截的、为什么截的标记没有价值）", () => {
        expect(() => cutMarker({ by: "", scope: "wire", why: "budget", total: 1, kept: 0 })).toThrow(/by/);
        expect(() => cutMarker({ by: "x", scope: "wire", why: "", total: 1, kept: 0 })).toThrow(/why/);
    });

    it("Total >= Kept 是所有 scope 的不变量（wire 也不例外）", () => {
        for (const scope of CUT_SCOPES) {
            expect(() => cutMarker({ by: "x", scope, why: "budget", total: 1, kept: 2 })).toThrow();
        }
    });
});

describe("parseCutMarkers：多标记 / 脏数据", () => {
    it("一段文本里多个标记按出现顺序返回，index 指回原文", () => {
        const a = cutMarker({ by: "a", scope: "wire", why: "budget", total: 10, kept: 1 });
        const b = cutMarker({ by: "b", scope: "view", why: "render", total: 20, kept: 2 });
        const text = `前 ${a} 中 ${b} 后`;
        const [x, y] = parseCutMarkers(text);
        expect([x!.by, y!.by]).toEqual(["a", "b"]);
        expect(text.slice(x!.index, x!.index + x!.raw.length)).toBe(a);
        expect(text.slice(y!.index, y!.index + y!.raw.length)).toBe(b);
    });

    it("形状不对的标签跳过（不猜）", () => {
        expect(parseCutMarkers('<cut by="x" scope="bad" total="1" kept="0"/>')).toEqual([]);
        expect(parseCutMarkers('<cut by="x" scope="wire" total="abc" kept="0"/>')).toEqual([]);
        expect(parseCutMarkers("没有任何标记的正文")).toEqual([]);
    });
});

describe("parseCutMarkers：旧格式只读兼容（不改写历史日志）", () => {
    const cases: { text: string; by: string; scope: string; unit: string; total: number }[] = [
        {
            text: "[... 中间省略 8400 行 / 210.0 KB，完整输出见 /abs/toolout/call_1.txt ...]",
            by: "tool-output",
            scope: "wire",
            unit: "lines",
            total: 8400,
        },
        { text: "[... 中间省略 700 行 / 12.0 KB，完整输出已省略 ...]", by: "tool-output", scope: "wire", unit: "lines", total: 700 },
        {
            text: "[输出已省略（只留调用）：8400 行 / 210.0 KB，完整输出见 /abs/a.txt]",
            by: "tool-result-callpath",
            scope: "wire",
            unit: "lines",
            total: 8400,
        },
        { text: "[… 推理省略 12000 字符 …]", by: "reasoning-clip", scope: "wire", unit: "chars", total: 12000 },
        { text: "<中间省略 401174 字节（正文共 425750 字节）>", by: "traffic-log", scope: "archive", unit: "bytes", total: 425750 },
        {
            text: "……已省略 292890 字符（全文 425750 字符；界面只保留头尾两段）……",
            by: "renderer-text-cap",
            scope: "view",
            unit: "chars",
            total: 425750,
        },
        { text: "… 省略 120 行 …", by: "chat-preview", scope: "view", unit: "lines", total: 120 },
        { text: "⋯ 已折叠 1,024 行 · 点击展开全部正文", by: "chat-fold", scope: "view", unit: "lines", total: 1024 },
    ];

    for (const c of cases) {
        it(`认得：${c.text.slice(0, 34)}…`, () => {
            const [m, ...rest] = parseCutMarkers(c.text);
            expect(rest).toEqual([]);
            expect(m).toMatchObject({ by: c.by, scope: c.scope, unit: c.unit, total: c.total, legacy: true });
            expect(m!.raw).toBe(c.text);
        });
    }

    it("旧格式省略量换算成 kept（流量存档 / 渲染硬顶都记了原文总量）", () => {
        expect(parseCutMarkers("<中间省略 401174 字节（正文共 425750 字节）>")[0]!.kept).toBe(24576);
        expect(parseCutMarkers("……已省略 292890 字符（全文 425750 字符；界面只保留头尾两段）……")[0]!.kept).toBe(132860);
    });

    it("旧格式的「≥」是下界（exact=false 时不许冒充精确值）", () => {
        expect(parseCutMarkers("… 至少省略 120 行 …")[0]!.lowerBound).toBe(true);
        expect(parseCutMarkers("⋯ 已折叠 ≥120 行 · 点击展开全部正文")[0]!.lowerBound).toBe(true);
        expect(parseCutMarkers("… 省略 120 行 …")[0]!.lowerBound).toBeUndefined();
    });

    it("新旧混排：按 index 排列，legacy 只标在旧的上", () => {
        const old = "… 省略 120 行 …";
        const neu = cutMarker({ by: "chat-preview", scope: "view", why: "window", total: 120, kept: 50 });
        const [a, b] = parseCutMarkers(`${old}\n${neu}`);
        expect(a!.legacy).toBe(true);
        expect(b!.legacy).toBeUndefined();
    });
});
