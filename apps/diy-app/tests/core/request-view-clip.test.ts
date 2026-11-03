// 压缩预览的「展示预算」——##406 刀 1
//
// 背景：`CompactSessionPanel` 对 base / mod 两份**完整请求**做节点级 diff 再全量渲染 DOM。
// ##401 那种 4.95 MB 请求 ⇒ 数万行 diff + 数万个节点 ⇒ 渲染进程卡死（用户实测「一进去就卡住」）。
// 修法是「只在展示副本上裁」：本文件钉住它的四条不变量。

import { describe, expect, it } from "vitest";
import { clipForPreview } from "../../src/shared/context/request-view";
import { diffValues } from "../../src/shared/yaml-lines";

describe("clipForPreview —— 展示副本的裁剪", () => {
    it("短字符串原样返回，不计入裁剪量", () => {
        const r = clipForPreview("hello", { maxChars: 10 });
        expect(r.value).toBe("hello");
        expect(r.stats).toEqual({ droppedChars: 0, droppedItems: 0 });
    });

    it("超长字符串保头保尾，占位里写清裁掉多少 / 原文多长", () => {
        const s = "A".repeat(1000) + "B".repeat(1000); // 2000 字符
        const r = clipForPreview(s, { maxChars: 100 });
        const out = r.value as string;
        expect(out.startsWith("A")).toBe(true); // 头在
        expect(out.endsWith("B")).toBe(true); // 尾在
        expect(out).toContain("预览已裁掉 1900 字符，原文 2000 字符");
        expect(r.stats.droppedChars).toBe(1900);
        // 关键：输出**有界**（原本 2000），否则「裁剪」等于没裁
        expect(out.length).toBeLessThan(100 + 60);
    });

    it("超长数组头尾各留一半 + 一条占位，顺序不乱", () => {
        const arr = Array.from({ length: 10 }, (_, i) => `item${i}`);
        const r = clipForPreview(arr, { maxItems: 4 });
        const out = r.value as unknown[];
        expect(out).toHaveLength(5); // 2 + 占位 + 2
        expect(out[0]).toBe("item0");
        expect(out[1]).toBe("item1");
        expect(out[3]).toBe("item8");
        expect(out[4]).toBe("item9");
        expect((out[2] as Record<string, string>)["…"]).toContain("预览已裁掉 6 项（共 10 项）");
        expect(r.stats.droppedItems).toBe(6);
    });

    it("递归进对象 / 嵌套数组，且**不修改入参**", () => {
        const inner = "x".repeat(500);
        const obj = { a: { b: [inner, "short"] } };
        const r = clipForPreview(obj, { maxChars: 50 });
        expect((r.value as any).a.b[1]).toBe("short");
        expect((r.value as any).a.b[0]).toContain("预览已裁掉");
        expect(inner).toHaveLength(500); // 原对象一个字都没被动
        expect(obj.a.b[0]).toBe(inner);
    });

    it("对称性：同样的内容裁出同样的结果（不会因为裁剪本身制造假 diff）", () => {
        const same = { msg: "y".repeat(8000), list: Array.from({ length: 500 }, (_, i) => i) };
        const a = clipForPreview(same, { maxChars: 100, maxItems: 10 });
        const b = clipForPreview(structuredClone(same), { maxChars: 100, maxItems: 10 });
        expect(a.value).toEqual(b.value);
        // 对称裁剪后两侧仍然「全 same」——这才是「裁剪不制造差异」的硬证据
        const rows = diffValues(a.value, b.value);
        expect(rows.every((r) => r.t === "same")).toBe(true);
    });

    it("真实差异在裁剪后仍然标得出（裁剪不能把该看见的差异吃掉）", () => {
        const base = { tool: "bash", result: "OK".repeat(4000) };
        const mod = { tool: "bash", result: "OK".repeat(4000) + "\nERROR: boom" };
        const rows = diffValues(
            clipForPreview(base, { maxChars: 200 }).value,
            clipForPreview(mod, { maxChars: 200 }).value,
        );
        expect(rows.some((r) => r.t !== "same")).toBe(true);
    });
});
