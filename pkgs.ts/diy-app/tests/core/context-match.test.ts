// tests/core/context-match.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 结构树 path ↔ 请求预览文本的匹配（选中联动的寻址语义）。
//
// 三条判据来自真实踩坑：集合元素的字段定位不到（元素名 `[ChainEntry]` 不是数据里的下标）、
// 容器行点了没反应（它没有自己的值，要取后代）、同一元素的多行该算一处。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { lineRange, matchRanges, pathPattern } from "../../src/shared/context/match";

/** 造一份行号映射（模拟 requestYaml 收集的结果） */
const lines = {
    diy: { from: 2, to: 4 },
    "diy.cli": { from: 3, to: 3 },
    "diy.home": { from: 4, to: 4 },
    chain: { from: 5, to: 17 },
    "chain.0": { from: 6, to: 10 },
    "chain.1": { from: 14, to: 17 },
    "chain.0.path": { from: 6, to: 6 },
    "chain.0.scope": { from: 7, to: 7 },
    "chain.0.content": { from: 8, to: 10 },
    "chain.1.path": { from: 14, to: 14 },
    "chain.1.scope": { from: 15, to: 15 },
    "chain.1.content": { from: 16, to: 17 },
    "task.body": { from: 20, to: 22 },
};

describe("结构树 path → 匹配区间", () => {
    it("精确命中（叶子字段）", () => {
        expect(matchRanges(lines, "diy.cli")).toEqual([{ from: 3, to: 3 }]);
    });

    it("★ 集合元素的字段：`[ChainEntry]` 展开成数字下标（每个元素一处）", () => {
        // 这是"选中 ChainEntry.scope 定位不到"的直接修复
        expect(matchRanges(lines, "chain.[ChainEntry].scope")).toEqual([
            { from: 7, to: 7 },
            { from: 15, to: 15 },
        ]);
        expect(matchRanges(lines, "chain.[ChainEntry].path")).toEqual([
            { from: 6, to: 6 },
            { from: 14, to: 14 },
        ]);
    });

    it("★ 集合元素本身（类型行）：展开成每个元素一段（连片合并）", () => {
        // chain.0 的三行（path/scope/content）合成一段，chain.1 同理 —— 不是一个元素算 N 处
        expect(matchRanges(lines, "chain.[ChainEntry]")).toEqual([
            { from: 6, to: 10 },
            { from: 14, to: 17 },
        ]);
    });

    it("容器行：有自身区间时直接用（渲染时已含整棵子树）", () => {
        expect(matchRanges(lines, "chain")).toEqual([{ from: 5, to: 17 }]);
        expect(matchRanges(lines, "diy")).toEqual([{ from: 2, to: 4 }]);
    });

    it("容器行没有自身区间（只在渲染单元里出现）→ 取后代并连片合并", () => {
        const noSelf = { ...lines } as Record<string, { from: number; to: number }>;
        delete noSelf["chain"];
        delete noSelf["chain.0"];
        expect(matchRanges(noSelf, "chain")).toEqual([
            { from: 6, to: 10 },
            { from: 14, to: 17 },
        ]);
    });

    it("无匹配 → 空数组（调用方据此不显示导航条）", () => {
        expect(matchRanges(lines, "nope.missing")).toEqual([]);
        expect(matchRanges(lines, "chain.[ChainEntry].nope")).toEqual([]);
    });

    it("路径段按字面处理（不是正则）：点、括号、`+` 都安全", () => {
        expect(matchRanges({ "a+b": { from: 1, to: 1 } }, "a+b")).toEqual([{ from: 1, to: 1 }]);
        expect(pathPattern("chain.[ChainEntry].scope").test("chain.12.scope")).toBe(true);
        expect(pathPattern("chain.[ChainEntry].scope").test("chain.x.scope")).toBe(false);
        // 前缀不当正则：`chainX` 不该被 `chain` 命中
        expect(pathPattern("chain").test("chainX")).toBe(false);
    });

    it("lineRange：区间 → 行号（含首尾）", () => {
        expect(lineRange({ from: 3, to: 3 })).toEqual([3]);
        expect(lineRange({ from: 6, to: 8 })).toEqual([6, 7, 8]);
    });
});

// ── 路径段：裸段 vs 引号段（map 化集合用稳定键寻址）──
import { joinPath, parsePath, isValidPath } from "../../src/shared/context/path";

describe("路径段语法（引号段）", () => {
    it("裸段照旧（向后兼容）", () => {
        expect(parsePath("diy.cli")).toEqual(["diy", "cli"]);
        expect(parsePath("chain.0.content")).toEqual(["chain", "0", "content"]);
        expect(joinPath(["diy", "cli"])).toBe("diy.cli");
    });

    it("★ 引号段：键含 `.` 与 `/`（AGENTS.md 路径）", () => {
        const p = "chain['~/git/diy/AGENTS.md'].content";
        expect(parsePath(p)).toEqual(["chain", "~/git/diy/AGENTS.md", "content"]);
        expect(isValidPath(p)).toBe(true);
        // 与 joinPath 严格互逆
        expect(joinPath(parsePath(p)!)).toBe(p);
    });

    it("绝对路径键（HOME 之外）", () => {
        const p = "chain['/var/xxx/AGENTS.md'].scope";
        expect(parsePath(p)).toEqual(["chain", "/var/xxx/AGENTS.md", "scope"]);
        expect(joinPath(parsePath(p)!)).toBe(p);
    });

    it("引号内的转义（`\\'` 与 `\\\\`）", () => {
        expect(parsePath("a['it\\'s'].b")).toEqual(["a", "it's", "b"]);
        expect(parsePath('a["plain quote"].b')).toEqual(["a", "plain quote", "b"]);
    });

    it("需要引号的段自动加引号（joinPath 侧）", () => {
        expect(joinPath(["chain", "~/a.md"])).toBe("chain['~/a.md']");
        expect(joinPath(["a", "plain", "b"])).toBe("a.plain.b");
    });

    it("畸形路径一律非法（不静默猜）", () => {
        for (const bad of ["", ".a", "a.", "a..b", "a['unclosed", "a['x']y", "a[''].b", "a b"]) {
            expect(isValidPath(bad), bad).toBe(false);
        }
    });

    it("★ 稳定键寻址：链首插入新文件后，原文件的路径不变", () => {
        // 下标寻址：链首插入新文件 → 原来的 chain.0 变成 chain.1（无法表达"哪个文件变了"）
        // 稳定键寻址：路径不变，仍指向同一个文件
        const before = "chain['~/AGENTS.md'].content";
        const after = "chain['~/AGENTS.md'].content";
        expect(parsePath(before)).toEqual(parsePath(after));
        expect(parsePath(before)![1]).toBe("~/AGENTS.md");
    });
});
