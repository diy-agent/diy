// tests/core/chat-scroll.test.ts — 聊天页两个滚动决策（##331 ①③）
//
// 这两个函数决定"用户看到哪一行"，全是**用户看得见**的语义：
//   · followPlan：新块刷出时视口落哪（钉到末行 = ① 的 bug；不动 = 用户以为没反应）
//   · anchorScrollTop：切走切回后回到哪一行（③ 的 bug 就是基准取错）
// 故与 chat-fold 同规格钉在这里；组件只管把结果写进 scrollTop。
import { describe, expect, it } from "vitest";
import { anchorScrollTop, anchorTick, clampScrollTop, followPlan, lastLeafId } from "../../src/renderer_solid/lib/chat-scroll";
import type { BlockNode } from "../../src/main/services/local-blocks";

function n(tag: string, id: string, attrs: Record<string, unknown> = {}, children: BlockNode[] = []): BlockNode {
    return { tag, id, stopped: true, touched: 0, attrs, children };
}
const say = (id: string) => n("text", id, { content: id });
const step = (id: string, kids: BlockNode[]) => n("step", id, {}, kids);
const turn = (id: string, ...kids: BlockNode[]) => n("turn", id, {}, kids);

describe("lastLeafId：滚动的「新块」判据", () => {
    it("取**文档序最后一片叶子**（跨轮；step 是纯容器，不参与）", () => {
        const trees = [turn("t1", step("t1_s1", [say("t1_u"), say("t1_a")])), turn("t2", step("t2_s1", [say("t2_u")]))];
        expect(lastLeafId(trees)).toBe("t2_u");
    });

    it("最后一轮还没有叶子 → 回退到上一轮的最后一片叶子（不是 null 也不算新块）", () => {
        const trees = [turn("t1", say("t1_a")), turn("t2")];
        expect(lastLeafId(trees)).toBe("t1_a");
    });

    it("没有轮 / 空树 → null", () => {
        expect(lastLeafId([])).toBeNull();
        expect(lastLeafId([n("error", "e1", { message: "x" })])).toBeNull();
    });
});

describe("clampScrollTop：滚动区间的唯一收口", () => {
    it("区间是 [0, scrollHeight-clientHeight]；内容不满一屏只能是 0", () => {
        expect(clampScrollTop(-30, 1000, 400)).toBe(0);
        expect(clampScrollTop(100, 1000, 400)).toBe(100);
        expect(clampScrollTop(9999, 1000, 400)).toBe(600);
        expect(clampScrollTop(50, 200, 400)).toBe(0);
    });

    it("NaN / 非有限值退 0（几何量还没量到时不留非法 scrollTop）", () => {
        expect(clampScrollTop(Number.NaN, 1000, 400)).toBe(0);
        expect(clampScrollTop(Number.POSITIVE_INFINITY, 1000, 400)).toBe(600);
    });
});

describe("followPlan：新内容刷出时视口落哪（##331 ①）", () => {
    const base = { stick: true, prevTailId: "t1_a", tailId: "t1_b", blockTop: 900, blockHeight: 1440, clientHeight: 800 };

    it("新块比视口**高** → 首行贴视口顶（不钉末行 —— 这就是 ① 的修法）", () => {
        expect(followPlan(base)).toEqual({ kind: "block-top", blockTop: 900 });
    });

    it("新块比视口**矮** → 跟到底（短块与 IM 直觉一致：新内容整体可见）", () => {
        expect(followPlan({ ...base, blockHeight: 300 })).toEqual({ kind: "bottom" });
        // 恰好一屏也算矮（不产生"最上面那行被切掉"）
        expect(followPlan({ ...base, blockHeight: 800 })).toEqual({ kind: "bottom" });
    });

    it("**同一块内**流式增长（末叶子 id 没变）→ 什么都不做，内容从屏幕下方长出", () => {
        expect(followPlan({ ...base, tailId: "t1_a" })).toEqual({ kind: "idle" });
    });

    it("用户在上方读历史（stick=false）→ 一律不动（既有语义：绝不打扰）", () => {
        expect(followPlan({ ...base, stick: false })).toEqual({ kind: "idle" });
        expect(followPlan({ ...base, stick: false, blockHeight: 100 })).toEqual({ kind: "idle" });
    });

    it("还没有末叶子（prevTailId=null，含「内容未上屏」那一帧）→ 不动", () => {
        // 切会话时块树会短暂为空树；这里若跟到底，切回来就会被自己滚走、顶掉 restore 的定位（③ 复发过）
        expect(followPlan({ ...base, prevTailId: null })).toEqual({ kind: "idle" });
        expect(followPlan({ ...base, prevTailId: null, blockHeight: 100 })).toEqual({ kind: "idle" });
    });

    it("没有任何叶子（tailId=null）→ 不动", () => {
        expect(followPlan({ ...base, tailId: null })).toEqual({ kind: "idle" });
    });
});

describe("anchorScrollTop：切走切回的锚点恢复（##331 ③）", () => {
    it("按「块顶 - 块内偏移」定位（offset ≤0 = 块顶在容器顶上方）", () => {
        // 块顶在内容 2000px 处，保存时块顶在容器顶上方 120px ⇒ 目标 scrollTop = 2120
        expect(anchorScrollTop(2000, -120, 5000, 800)).toBe(2120);
        // 块顶恰好齐容器顶
        expect(anchorScrollTop(1000, 0, 5000, 800)).toBe(1000);
    });

    it("超界由 clamp 收口（锚点之后的内容被删/变矮时不给出非法位置）", () => {
        expect(anchorScrollTop(100, 500, 5000, 800)).toBe(0); // 目标为负 → 收到 0
        expect(anchorScrollTop(9000, 0, 5000, 800)).toBe(4200);
    });
});

// ── anchorTick：切回后的连校单帧决策（review1 R1 钉在这） ────────────────────
//
// 背景：恢复锚点后要连校几帧（高度估算值换实测值会挪位置）。原实现在"发现用户在滚"这一帧
// 只更新基准、**没有 latch** ⇒ 下一帧基准已等于用户位置、`userScrolled` 为假 ⇒ 漂移校正
// 立刻把用户**推回锚点**，与注释「绝不抢」相反。下面第一条用例就是钉死这个回归。
describe("anchorTick：锚点连校（用户一旦动手就永不抢）", () => {
    const M = (scrollTop: number, blockOffset: number | null, extra: Partial<Parameters<typeof anchorTick>[0]> = {}) => ({
        scrollTop,
        blockOffset,
        offset: 0,
        scrollHeight: 1000,
        clientHeight: 400,
        quietFrames: 3,
        ...extra,
    });

    it("用户滚一下 → latch 收手；**下一帧停手时也不会被 drift 推回锚点**（R1 的 bug）", () => {
        let st = { lastSt: 400, quiet: 0, userLeft: false };

        // k：用户自己滚到 350（≠ 我们写下的 400）
        const k = anchorTick(M(350, 0), st);
        expect(k.stop).toBe(true); // 收手：把控制权交还用户
        expect(k.setTop).toBeNull(); // 绝不写 scrollTop
        expect(k.state.userLeft).toBe(true); // latch
        st = k.state;

        // k+1：用户停手，此刻 scrollTop === lastSt（正是旧实现误判"我们写的"、然后推回锚点的那一帧）
        const k1 = anchorTick(M(350, 0), st);
        expect(k1.setTop).toBeNull(); // 旧实现这里会 setTop=400（推回锚点）❌
        expect(k1.stop).toBe(true);
    });

    it("没人动 → 有漂移就校正到「块顶落在 offset 处」", () => {
        // 块顶现在比容器顶低 60px，但我们要求它压在容器顶（offset=0）⇒ 视口下滚 60
        const r = anchorTick(M(400, 60), { lastSt: 400, quiet: 0, userLeft: false });
        expect(r.setTop).toBe(460);
        expect(r.state.quiet).toBe(0);

        // 越界由 clampScrollTop 收口：要求滚到 1300 但底部只到 600
        const c = anchorTick(M(600, 700), { lastSt: 600, quiet: 0, userLeft: false });
        expect(c.setTop).toBe(600);

        // 块顶已被滚出容器顶 20px（offset 存的正是这个负值）⇒ 不能动
        const keep = anchorTick(M(400, -20, { offset: -20 }), { lastSt: 400, quiet: 0, userLeft: false });
        expect(keep.setTop).toBeNull();
    });

    it("块顶在 offset 处 → 不写 scrollTop，只累静默；满 quietFrames 即收手", () => {
        let st = { lastSt: 400, quiet: 0, userLeft: false };
        for (let i = 0; i < 2; i++) {
            const r = anchorTick(M(400, 0), st);
            expect(r.setTop).toBeNull();
            expect(r.stop).toBe(false);
            st = r.state;
        }
        const last = anchorTick(M(400, 0), st);
        expect(last.stop).toBe(true); // 第 3 帧静默 → 稳了
        expect(last.state.quiet).toBe(3);
    });

    it("锚点块不在 DOM（blockTop=null）→ 不动 scrollTop、帧预算交给调用点（R3 有界）", () => {
        const r = anchorTick(M(400, null), { lastSt: 400, quiet: 0, userLeft: false });
        expect(r.setTop).toBeNull();
        expect(r.stop).toBe(false);
    });
});
