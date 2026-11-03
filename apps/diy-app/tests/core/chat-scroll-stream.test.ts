// tests/core/chat-scroll-stream.test.ts — 事件流（room 面板 / 房间页）的跟随态（##377 第 19 刀）
//
// 用户报的现象：「room 的会话根本无法翻越，会立即跳回到底部」。
// 根因不在渲染，而在**跟随判据**：取数后无条件钉底（取数 = 2.5s 一次的轮询）
// ⇒ 用户往上翻，最多 2.5 秒就被拽回底部（实测滚到中段 1.6s 后回到距底 0px）。
//
// 所以这条判据是**用户看得见**的语义，与 chat-scroll 其余部分同规格钉在这里：
// 只有"人滚的"才改跟随态；我们自己的钉底带出来的 scroll 事件**不算**。
import { describe, expect, it } from "vitest";
import {
    nearBottom,
    onStreamScroll,
    pinnedTo,
    streamFollowInit,
    type StreamFollowState,
} from "../../src/renderer_solid/lib/chat-scroll";

/** 造一份几何量（容器 500 高，内容 2000 ⇒ 底部位置 = 1500） */
const G = (scrollTop: number, scrollHeight = 2000, clientHeight = 500) => ({ scrollTop, scrollHeight, clientHeight });

describe("nearBottom：贴底判据", () => {
    it("底部与容差内算贴底", () => {
        expect(nearBottom(G(1500))).toBe(true);
        expect(nearBottom(G(1500 - 32))).toBe(true);
    });

    it("容差外不算（别让差 1px 永远跟不住）", () => {
        expect(nearBottom(G(1500 - 33))).toBe(false);
        expect(nearBottom(G(0))).toBe(false);
    });

    it("内容不满一屏（scrollHeight === clientHeight）⇒ 恒贴底", () => {
        expect(nearBottom(G(0, 300, 500))).toBe(true);
    });
});

describe("onStreamScroll：只有「人滚的」才改跟随态", () => {
    it("人往上滚 ⇒ 停手（此后取数不再把视口拽回去）", () => {
        const st = onStreamScroll(streamFollowInit, G(600));
        expect(st.stick).toBe(false);
        expect(st.progWrite).toBeNull();
    });

    it("人滚回底部 ⇒ 恢复跟随", () => {
        const up: StreamFollowState = { stick: false, progWrite: null };
        expect(onStreamScroll(up, G(1500)).stick).toBe(true);
    });

    it("**我们自己钉底**带出来的事件不改跟随态（豁免那一次）", () => {
        // 钉底后滚到底：事件里的位置 = 我们写下的位置
        const after = pinnedTo(1500);
        expect(after).toEqual({ stick: true, progWrite: 1500 });
        expect(onStreamScroll(after, G(1500)).stick).toBe(true);
        // 豁免是**一次性的**：紧随的第二次事件不再被豁免（此时位置在底部 ⇒ 仍是跟随）
        const once = onStreamScroll(after, G(1500));
        expect(once.progWrite).toBeNull();
    });

    it("反证：没有豁免位时，钉底路上的事件会被误判成「人滚的」（跟随被误关）", () => {
        // 钉底写入途中（位置还在半路）触发的事件：有豁免位 ⇒ 跟随保持；
        // 去掉豁免位（progWrite = null）⇒ 被当成用户在上滚 ⇒ stick=false ⇒ 之后再不跟随。
        const ours: StreamFollowState = { stick: true, progWrite: 1000 };
        expect(onStreamScroll(ours, G(1000)).stick).toBe(true); // 有豁免：保持
        const notOurs: StreamFollowState = { stick: true, progWrite: null };
        expect(onStreamScroll(notOurs, G(1000)).stick).toBe(false); // 无豁免：误判
    });

    it("人上滚之后又发生我们的钉底（用户滚轮与程序化写入交错）⇒ 仍认作人的位置", () => {
        // 位置与豁免位差得远 ⇒ 是人在滚，不是我们写的
        const st: StreamFollowState = { stick: false, progWrite: 1000 };
        const next = onStreamScroll(st, G(300));
        expect(next.stick).toBe(false);
        expect(next.progWrite).toBeNull();
    });
});

describe("pinnedTo / streamFollowInit", () => {
    it("初始态 = 跟随（打开房间/面板从最新看起）", () => {
        expect(streamFollowInit).toEqual({ stick: true, progWrite: null });
    });

    it("钉底 ⇒ 跟随态记为贴底 + 记下豁免位", () => {
        expect(pinnedTo(1234)).toEqual({ stick: true, progWrite: 1234 });
    });
});
