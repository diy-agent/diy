// tests/core/output-ring.test.ts
// 🎯 ##408 刀 4 —— 输出环 + 双 cursor（`shared/output-ring.ts`）
//
// 本刀全是纯函数（零 IO、零 timer），故钉的是**显示正确性**：
//   ① 丢头保留尾部，且**必须**给出 droppedBytes（否则 UI 分不清「没输出」和「被截」）；
//   ② 切点合法：中文 / emoji 跨块边界时不许读出半个字符（下游 JSON/RPC 会崩）；
//   ③ 双 cursor 各带 id、各自推进，生命周期不同（live 随面板 / settle 随 run 收口）；
//   ④ cursor 存绝对偏移 —— 环丢头后能算出「我漏了多少字节」（lostBytes）。

import { describe, it, expect } from "vitest";
import {
    LIVE_RING_BYTES,
    SETTLE_RING_BYTES,
    appendRunOutput,
    appendRunText,
    appendText,
    appendToRing,
    createCursor,
    createOutputRing,
    createRunOutput,
    cursorAtEnd,
    cursorAtStart,
    freezeRunOutput,
    outputCursorId,
    readLive,
    readOutput,
    readSettle,
    ringEndOffset,
    tailOfRing,
    utf8HeadStart,
    utf8TailCut,
} from "../../src/shared/output-ring";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });

/** 断言文本里没有「替换字符」（= 半个字符被硬解出来的证据） */
function expectNoBrokenChars(text: string): void {
    expect(text.includes("\uFFFD")).toBe(false);
}

describe("环：丢头保留尾，且如实记账", () => {
    it("未超容量：全留，droppedBytes=0", () => {
        const r = appendText(createOutputRing(16), "abc");
        expect(dec.decode(r.bytes)).toBe("abc");
        expect(r.droppedBytes).toBe(0);
        expect(r.totalBytes).toBe(3);
        expect(r.baseOffset).toBe(0);
        expect(ringEndOffset(r)).toBe(3);
    });

    it("超容量：只留最后 cap 字节，丢多少就记多少（droppedBytes / baseOffset / totalBytes 三者自洽）", () => {
        let r = createOutputRing(8);
        for (const part of ["aaaa", "bbbb", "cccc"]) r = appendText(r, part);
        expect(dec.decode(r.bytes)).toBe("bbbbcccc"); // 尾部 8 字节
        expect(r.droppedBytes).toBe(4); // "aaaa" 被丢
        expect(r.baseOffset).toBe(4);
        expect(r.totalBytes).toBe(12);
        expect(r.baseOffset + r.bytes.length).toBe(r.totalBytes); // 恒等式
        expect(ringEndOffset(r)).toBe(12);
    });

    it("空 chunk 是 no-op（返回**同一个**对象，不白白造新数组）", () => {
        const r = createOutputRing(8);
        expect(appendToRing(r, new Uint8Array(0))).toBe(r);
    });

    it("tailOfRing：取尾部做新环，droppedBytes 继续累加（否则 settle 视图会把截断说成「一共就这么多」）", () => {
        let r = createOutputRing(1024);
        r = appendText(r, "0123456789");
        const tail = tailOfRing(r, 4);
        expect(dec.decode(tail.bytes)).toBe("6789");
        expect(tail.capBytes).toBe(4);
        expect(tail.baseOffset).toBe(6);
        expect(tail.droppedBytes).toBe(6);
        expect(tail.totalBytes).toBe(10);
    });
});

describe("UTF-8 边界：切点前退到码点，不许读出半个字符", () => {
    it("头部切在中文中间 ⇒ 跳过游离续字节，文本干净", () => {
        const text = "中文测试"; // 每字 3 字节，共 12
        const all = enc.encode(text);
        // 容量 10 ⇒ 丢头 2 字节（落在「中」的第 2、3 字节 [b8 ad] 上，环内首字节成了游离续字节）
        const r = appendToRing(createOutputRing(10), all);
        expect(r.droppedBytes).toBe(2);
        const read = readOutput(r, createCursor("live", "t1"));
        expectNoBrokenChars(read.text);
        expect(read.text).toBe("文测试");
        // 「中」的 3 个字节全不可用：2 字节在环外（丢头）+ 1 字节是游离续字节（对齐时跳过）
        expect(read.lostBytes).toBe(3);
    });

    it("头部切在 4 字节 emoji 中间 ⇒ 同样跳过残骸（不是只处理 3 字节字符）", () => {
        const text = "🙂🙂🙂"; // 每个 4 字节，共 12
        const all = enc.encode(text);
        for (const cap of [9, 10, 11, 12]) {
            const r = appendToRing(createOutputRing(cap), all);
            const read = readOutput(r, createCursor("live", "t2"));
            expectNoBrokenChars(read.text);
            expect("🙂🙂🙂".includes(read.text)).toBe(true);
            expect(read.text).toBe("🙂".repeat(Math.floor(cap / 4)));
            expect(read.lostBytes).toBe(12 - Math.floor(cap / 4) * 4);
        }
    });

    it("尾部半截序列：本轮**不读**（cursor 不前进），补齐后才读出完整字符", () => {
        const all = enc.encode("中"); // e4 b8 ad
        let r = appendToRing(createOutputRing(64), all.slice(0, 2));
        const cur = createCursor("live", "t3");
        const first = readOutput(r, cur);
        expect(first.text).toBe(""); // 半截不成字，先不吐
        expect(first.cursor.offset).toBe(0); // 也不许跳过它，否则字符永久丢失
        expect(first.bytes).toBe(0);

        r = appendToRing(r, all.slice(2));
        const second = readOutput(r, first.cursor);
        expect(second.text).toBe("中");
        expect(second.bytes).toBe(3);
        expect(second.cursor.offset).toBe(3);
    });

    it("chunk 切在 emoji 中间（流式常见）：先空后完整", () => {
        const all = enc.encode("a🙂b");
        const cut = 1 + 2; // 'a' + 🙂 的前两字节
        let r = appendToRing(createOutputRing(64), all.slice(0, cut));
        const cur = createCursor("live", "t4");
        const first = readOutput(r, cur);
        expect(first.text).toBe("a");
        expect(first.cursor.offset).toBe(1);
        r = appendToRing(r, all.slice(cut));
        expect(readOutput(r, first.cursor).text).toBe("🙂b");
    });

    it("utf8HeadStart / utf8TailCut 的直接判据（含非法首字节不许抛）", () => {
        const b = enc.encode("中文");
        expect(utf8HeadStart(b, 1)).toEqual({ at: 3, skipped: 2 });
        expect(utf8HeadStart(b, 0)).toEqual({ at: 0, skipped: 0 });
        expect(utf8TailCut(b, 0, 4)).toBe(3); // 第 2 个字只有 1 字节 ⇒ 退到 3
        expect(utf8TailCut(b, 0, 6)).toBe(6);
        // 非法字节（0xFF 不是合法 UTF-8 首字节）不许抛；当 1 字节处理
        expect(() => utf8HeadStart(new Uint8Array([0xff, 0x41]), 0)).not.toThrow();
        expect(() => utf8TailCut(new Uint8Array([0xff, 0x41]), 0, 2)).not.toThrow();
    });
});

describe("双 cursor：各自独立的 id + 各自推进", () => {
    it("id 带 kind 前缀，两种 kind 永不共用游标", () => {
        const live = createCursor("live", "run-1");
        const settle = createCursor("settle", "run-1");
        expect(live.id).toBe("live:run-1");
        expect(settle.id).toBe("settle:run-1");
        expect(outputCursorId("live", "run-1")).toBe(live.id);
        expect(live.id).not.toBe(settle.id);
        expect(live.kind).toBe("live");
        expect(settle.kind).toBe("settle");
    });

    it("live cursor 逐块追尾：每次只返回**新增**部分", () => {
        let out = createRunOutput();
        let cur = createCursor("live", "r1");
        out = appendRunText(out, "hello ");
        let read = readLive(out, cur);
        expect(read.text).toBe("hello ");
        cur = read.cursor;
        out = appendRunText(out, "world");
        read = readLive(out, cur);
        expect(read.text).toBe("world");
        expect(read.lostBytes).toBe(0);
        cur = read.cursor;
        // 没新输出 ⇒ 空、cursor 不动（面板据此停轮询）
        const idle = readLive(out, cur);
        expect(idle.text).toBe("");
        expect(idle.cursor.offset).toBe(cur.offset);
    });

    it("读 live **不会**推进 settle cursor（生命周期不同，不许互相牵连）", () => {
        let out = createRunOutput();
        out = appendRunText(out, "abc");
        const settleCur = createCursor("settle", "r2");
        const liveCur = createCursor("live", "r2");
        readLive(out, liveCur);
        expect(settleCur.offset).toBe(0);
        // run 未收口 ⇒ settle 环是空的：不许拿半个 live 冒充稳定快照
        const early = readSettle(out, settleCur);
        expect(early.text).toBe("");
        expect(out.frozen).toBe(false);
    });

    it("freeze 后 settle 从 0 读到快照；之后再来的 chunk 只进 live，settle 不变", () => {
        let out = createRunOutput();
        out = appendRunText(out, "before-settle\n");
        out = freezeRunOutput(out);
        const snap = readSettle(out, createCursor("settle", "r3"));
        expect(snap.text).toBe("before-settle\n");
        expect(snap.bytes).toBe(14); // "before-settle\n"

        out = appendRunText(out, "after-settle\n");
        const again = readSettle(out, createCursor("settle", "r3"));
        expect(again.text).toBe("before-settle\n"); // 稳定快照不被后续 chunk 改写
        expect(readLive(out, createCursor("live", "r3")).text).toBe("before-settle\nafter-settle\n");
    });

    it("freeze 幂等（收口路径被重试 / 重启恢复各碰一次，不许把快照越改越小）", () => {
        let out = appendRunText(createRunOutput(), "x".repeat(100));
        out = freezeRunOutput(out);
        const once = out.settle.bytes.length;
        out = appendRunText(out, "y".repeat(10));
        out = freezeRunOutput(out);
        expect(out.settle.bytes.length).toBe(once);
        expect(dec.decode(out.settle.bytes)).toBe("x".repeat(100));
    });

    it("settle 快照只留 16 KB 尾巴，且丢失量记在 droppedBytes 里", () => {
        let out = createRunOutput();
        out = appendRunText(out, "a".repeat(SETTLE_RING_BYTES * 2));
        out = freezeRunOutput(out);
        expect(out.settle.bytes.length).toBe(SETTLE_RING_BYTES);
        expect(out.settle.totalBytes).toBe(SETTLE_RING_BYTES * 2);
        expect(out.settle.droppedBytes).toBe(SETTLE_RING_BYTES);
        // live 容量更大，仍留着全部
        expect(out.live.bytes.length).toBe(SETTLE_RING_BYTES * 2);
    });
});

describe("丢头之后 cursor 的诚实交代（lostBytes）", () => {
    it("cursor 落后于环头 ⇒ 报 lostBytes，且**不**假装连续", () => {
        let r = createOutputRing(8);
        const cur = createCursor("live", "lost");
        r = appendText(r, "0123456789"); // 丢 "01"
        const read = readOutput(r, cur);
        expect(read.lostBytes).toBe(2);
        expect(read.text).toBe("23456789");
        expect(read.cursor.offset).toBe(10);
    });

    it("cursor 正好在环头（没漏）⇒ lostBytes = 0", () => {
        let r = createOutputRing(8);
        r = appendText(r, "0123456789");
        const read = readOutput(r, { ...createCursor("live", "ok"), offset: 2 });
        expect(read.lostBytes).toBe(0);
        expect(read.text).toBe("23456789");
    });

    it("丢头落在字符中间 ⇒ **环外字节 + 游离续字节**一起计入 lostBytes（不许少报）", () => {
        // "abc中文测试" = 3 + 12 = 15 字节；容量 10 ⇒ 丢头 5 字节
        // 丢掉的 5 字节 = "abc" 全 3 字节 + "中" 的前 2 字节 ⇒ 环内首字节是 "中" 的残骸（游离续字节）
        const r = appendToRing(createOutputRing(10), enc.encode("abc中文测试"));
        const read = readOutput(r, createCursor("live", "mid"));
        expect(read.text).toBe("文测试");
        expect(read.lostBytes).toBe(6); // 环外 5 + 对齐跳过 1
        expectNoBrokenChars(read.text);
    });

    it("cursor 跑到环尾之后（换环 / 旧快照的 cursor 读新环）⇒ reset=true，不许静默回退当成「没新输出」", () => {
        const r = appendText(createOutputRing(8), "abc");
        const lost = readOutput(r, { ...createCursor("settle", "stale"), offset: 99 });
        expect(lost.reset).toBe(true);
        expect(lost.text).toBe("");
        expect(lost.cursor.offset).toBe(3); // 夹到环尾
        // 正常追尾不置 reset（否则每次都当换环重建）
        expect(readOutput(r, createCursor("live", "ok")).reset).toBe(false);
    });

    it("cursorAtEnd / cursorAtStart 是**定位**不是「标记已读」：都不改环", () => {
        let r = createOutputRing(8);
        r = appendText(r, "abc");
        const c = createCursor("live", "pos");
        expect(cursorAtEnd(c, r).offset).toBe(3);
        expect(cursorAtStart(c, r).offset).toBe(0);
        expect(dec.decode(r.bytes)).toBe("abc");
    });
});

describe("容量常量就是设计值（别处不许再抄一份数字）", () => {
    it("live 256 KB / settle 16 KB", () => {
        expect(LIVE_RING_BYTES).toBe(256 * 1024);
        expect(SETTLE_RING_BYTES).toBe(16 * 1024);
        const out = createRunOutput();
        expect(out.live.capBytes).toBe(LIVE_RING_BYTES);
        expect(out.settle.capBytes).toBe(SETTLE_RING_BYTES);
    });

    it("appendRunOutput 接受任意 Uint8Array（fs 侧直接塞 chunk，不经字符串）", () => {
        const out = appendRunOutput(createRunOutput(), enc.encode("raw"));
        expect(dec.decode(out.live.bytes)).toBe("raw");
    });
});
