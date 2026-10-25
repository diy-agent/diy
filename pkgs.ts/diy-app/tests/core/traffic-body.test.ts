// tests/core/traffic-body.test.ts
// 🎯 流量存档的正文还原（##425）—— 存档没存（`archive`）必须与「正文被截」（`wire`）长得不一样。
//
// 复现原始误判（`projects/1/tasks/10` 第 2 轮 step 4）：425,750 字节的请求正文在流量页只显示
// head/tail，旧标记 `<中间省略 401174 字节（正文共 425750 字节）>` 被读成「任务 body 被塞了 425 KB」。
// 真相是**存档没存**（`capture-off`：没开「记录完整请求内容」），原文完整、发给模型的一个字没少。

import { describe, it, expect } from "vitest";
import { bodyValue, type BodyCapture } from "../../src/renderer_solid/lib/traffic-body";
import { parseCutMarkers } from "../../src/shared/cut-marker";

const capture = (over: Partial<BodyCapture> = {}): BodyCapture => ({
    head: "HEAD",
    tail: "TAIL",
    headBytes: 8 * 1024,
    tailBytes: 16 * 1024,
    totalBytes: 425_750,
    truncated: true,
    ...over,
});

describe("bodyValue：未截断", () => {
    it("能解析成 JSON ⇒ 给结构（不是字符串）", () => {
        expect(bodyValue(capture({ truncated: false, head: '{"a":1}', tail: "", totalBytes: 7 }), null)).toEqual({ a: 1 });
    });

    it("不是 JSON ⇒ 原样给文本", () => {
        expect(bodyValue(capture({ truncated: false, head: "not json", tail: "", totalBytes: 8 }), null)).toBe("not json");
    });

    it("没有正文 ⇒ 给调用方的说明（GET 请求等）", () => {
        expect(bodyValue(null, "（GET 请求无 body）")).toBe("（GET 请求无 body）");
        expect(bodyValue(null, null)).toBe("（无正文）");
    });
});

describe("bodyValue：被存档截断（archive，不是 wire）", () => {
    it("插一条 `<cut scope=\"archive\">`，两个数字都如实（total / kept）", () => {
        const v = String(bodyValue(capture(), null));
        const [m, ...rest] = parseCutMarkers(v);
        expect(rest).toEqual([]);
        expect(m).toMatchObject({
            by: "traffic-log",
            scope: "archive",
            why: "capture-off",
            unit: "bytes",
            total: 425_750,
            kept: 8 * 1024 + 16 * 1024,
        });
        expect(m!.resume).toBeUndefined(); // 原文没存在别处：不做「能取回」的假承诺
    });

    it("头尾原样保留（marker 只插在中间，不许静默拼成看起来连续的文本）", () => {
        const v = String(bodyValue(capture({ head: "前段", tail: "后段" }), null));
        expect(v.startsWith("前段\n")).toBe(true);
        expect(v.endsWith("\n后段")).toBe(true);
    });

    it("scope 不是 wire：同一段文本里读不出「线上被裁」的语义（原始误判的根）", () => {
        const v = String(bodyValue(capture(), null));
        expect(v).not.toContain('scope="wire"');
        expect(parseCutMarkers(v)[0]!.scope).toBe("archive");
    });
});
