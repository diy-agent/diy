// tests/core/chat-fold.test.ts — 轮次折叠语义（显示什么、按什么序、实时区给谁）
//
// 这些是**用户看得见的语义**，不是样式：顺序错一次就是"助理消息跑到用户消息上面"
//（2026-10-04 现象），实时区判错一次就是"步骤一完就空白"或"同一句出现两遍"（review P1-1）。
// 故钉在这里，组件只管画。
import { describe, expect, it } from "vitest";
import {
    DEFAULT_TURN_LEVEL,
    TURN_DETAIL_LAYER,
    TURN_LEVEL_MAX,
    clampLines,
    contentItems,
    cycleTurnLevel,
    foldedItems,
    isProc,
    isTurnLevel,
    isUserText,
    conclusionOf,
    composeTail,
    endReasonOf,
    leadUsers,
    sceneTailOf,
    turnEndNote,
    leavesOf,
    levelOfTurn,
    liveSlotIndex,
    liveTailOf,
    planOfLevel,
    turnLevelLabel,
} from "../../src/renderer_solid/lib/chat-fold";
import type { BlockNode } from "../../src/main/services/local-blocks";

function n(
    tag: string,
    id: string,
    attrs: Record<string, unknown> = {},
    children: BlockNode[] = [],
    stopped = true,
): BlockNode {
    return { tag, id, stopped, touched: 0, attrs, children };
}
const user = (id: string) => n("text", id, { role: "user", content: id });
const say = (id: string, stopped = true) => n("text", id, { content: id }, [], stopped); // 助理正文
const think = (id: string, stopped = true) => n("think", id, { content: "…" }, [], stopped);
const tool = (id: string, stopped = true, status = "done") =>
    n("tool", id, { tool: "bash", title: id, status }, [], stopped);
const err = (id: string) => n("error", id, { source: "llm", message: id });
const step = (id: string, kids: BlockNode[]) => n("step", id, {}, kids);
const turn = (...kids: BlockNode[]) => n("turn", "t1", {}, kids);

describe("leavesOf：文档序拉平", () => {
    it("step 是纯容器，DFS 顺序 = 时间顺序", () => {
        const t = turn(step("s1", [user("u1"), think("k1")]), step("s2", [say("a1")]));
        expect(leavesOf(t).map((x) => x.id)).toEqual(["u1", "k1", "a1"]);
    });

    it("嵌套容器（旧日志的嵌套 turn）也向下递归，不整段丢", () => {
        const t = turn(user("u1"), turn(think("k1"), say("a1")));
        expect(leavesOf(t).map((x) => x.id)).toEqual(["u1", "k1", "a1"]);
    });
});

describe("foldedItems：折叠态 = 严格文档序，不重排", () => {
    it("插话（文档序在轮中）就地渲染，不被拽到轮首", () => {
        // 用户开场 → 助理① → 助手工具 → 【用户插话】 → 助理②（最后一条）
        const t = turn(
            user("u1"),
            say("a1"),
            tool("x1"),
            user("u2"),
            say("a2"),
        );
        // 旧实现（userTexts → delta → lastText）会给出 [u1, u2, a2]，
        // 把 u2 提到 a1 前面 —— 与它后面那条 a2 的相对关系仍然错。
        expect(foldedItems(t).map((x) => x.id)).toEqual(["u1", "u2", "a2"]);
    });

    it("用户发言恒显、更早的助理正文一律收起、只留最后一条", () => {
        const t = turn(user("u1"), say("a1"), tool("x1"), think("k1"), say("a9"));
        expect(foldedItems(t).map((x) => x.id)).toEqual(["u1", "a9"]);
    });

    it("error 块恒显（否则报错轮次折叠起来与成功轮次长得一模一样）", () => {
        const t = turn(user("u1"), err("e1"), say("a1"));
        const ids = foldedItems(t).map((x) => x.id);
        expect(ids).toContain("e1");
        expect(ids).toEqual(["u1", "e1", "a1"]);
    });

    it("没有助理正文时只留用户发言（不凭空造一条）", () => {
        const t = turn(user("u1"), tool("x1", false));
        expect(foldedItems(t).map((x) => x.id)).toEqual(["u1"]);
        expect(conclusionOf(t)).toBeNull();
    });
});

describe("leadUsers：轮首用户发言（渲染在轮次头之前）", () => {
    it("轮首连续的用户发言是 lead（IM 顺序：用户先说、助理的身份行再接）", () => {
        const t = turn(user("u1"), say("a1"), tool("x1"));
        expect(leadUsers(t).map((x) => x.id)).toEqual(["u1"]);
    });

    it("只取**开头连续**的：轮中插话不算 lead（提前 = 又一次重排）", () => {
        const t = turn(user("u1"), say("a1"), user("u2"), say("a2"));
        expect(leadUsers(t).map((x) => x.id)).toEqual(["u1"]);
    });

    it("助理先开口（无用户发言）时 lead 为空，轮次头仍在最上", () => {
        expect(leadUsers(turn(think("k1"), say("a1")))).toEqual([]);
    });

    it("lead 与折叠体互补：lead ∪ foldBody = foldedItems，无重复", () => {
        const t = turn(user("u1"), say("a1"), tool("x1"), user("u2"), say("a9"));
        const head = leadUsers(t);
        const body = foldedItems(t).filter((n) => !head.includes(n));
        const all = [...head, ...body].map((x) => x.id);
        expect(all).toEqual(["u1", "u2", "a9"]);
        expect(new Set(all).size).toBe(all.length);
    });
});

describe("liveTailOf：活动块（就地画在文档序里）", () => {
    it("非直播轮次没有活动块", () => {
        expect(liveTailOf(turn(user("u1"), tool("x1", false)), false)).toBeNull();
    });

    it("一步在跑 → 就是它（渲染侧看 stopped=false ⇒ 实时刷）", () => {
        const t = turn(user("u1"), tool("x1", false));
        expect(liveTailOf(t, true)).toBe(leavesOf(t)[1]);
        expect(liveTailOf(t, true)!.stopped).toBe(false);
    });

    it("一步跑完、后面还没有内容 → **仍然返回它**（冻结：框不消失，等下一步替换）", () => {
        const t = turn(user("u1"), tool("x1"));
        expect(liveTailOf(t, true)!.id).toBe("x1");
        expect(liveTailOf(t, true)!.stopped).toBe(true);
    });

    it("**正文也是「收取中的数据」**：text 一生效，活动块就是它（2026-10-11 口径修正）", () => {
        // 旧规则（R17）活动块只认过程叶子 ⇒ 正文流在框**下面**，正文流完再遇到工具时
        // 又整段跳回框上面（用户实测的"消失跳位"）。新口径：中间载体装**所有**收取中的东西。
        const t = turn(tool("x1"), say("a1", ));
        expect(liveTailOf(t, true)!.id).toBe("a1");
    });

    it("跑完后的用户插话不改变判据（位置由 liveSlotIndex 管）", () => {
        const t = turn(tool("x1"), user("u2"));
        expect(liveTailOf(t, true)!.id).toBe("x1");
    });

    it("还没有任何助理内容 → 没有活动块（那段时间交给「等待响应」loading）", () => {
        expect(liveTailOf(turn(user("u1")), true)).toBeNull();
    });

    it("取的是**文档序最后一个非用户叶子**（think/tool/text 混排也一样）", () => {
        const t = turn(think("k1"), tool("x1"), think("k2", false));
        expect(liveTailOf(t, true)!.id).toBe("k2");
        const t2 = turn(think("k1"), tool("x1"), say("a1", ));
        expect(liveTailOf(t2, true)!.id).toBe("a1");
    });
});

describe("liveSlotIndex：活动块插回文档序原位", () => {
    it("活动块就是最后一个叶子 → 插在末尾", () => {
        const t = turn(user("u1"), think("k1", false));
        const its = contentItems(t, (n) => n === leavesOf(t)[1]);
        expect(liveSlotIndex(t, its, leavesOf(t)[1]!)).toBe(its.length);
    });

    it("活动块后面还有收尾正文 → 插在**那条正文之前**（不能一律挂末尾）", () => {
        // think → tool → 正文 是标准时序：活动块（tool）排到正文后面就与文档序相反
        const t = turn(think("k1"), tool("x1"), say("a9"));
        const live = leavesOf(t).find((n) => n.id === "x1")!;
        const its = contentItems(t, (n) => n === live);
        expect(its.map((i) => i.key)).toEqual(["k1", "a9"]);
        expect(liveSlotIndex(t, its, live)).toBe(1); // 在 a9 之前
    });

    it("活动块在一段连续过程的**末尾** → 整段（已剔掉它）仍在它之前", () => {
        // 轮首u1 由 leadUsers 单独渲染（不在中间区里），故项从 k1 起
        const t = turn(user("u1"), think("k1"), tool("x1"), think("k2", false), say("a9"));
        const live = leavesOf(t).find((n) => n.id === "k2")!;
        const its = contentItems(t, (n) => n === live);
        expect(its.map((i) => i.key)).toEqual(["k1", "a9"]);
        expect(liveSlotIndex(t, its, live)).toBe(1);
    });

    it("节点已经取不到（正被移除）→ 排末尾，不抛错", () => {
        const t = turn(tool("x1"), say("a9"));
        const its = contentItems(t);
        expect(liveSlotIndex(t, its, tool("gone"))).toBe(its.length);
    });
});

describe("isUserText / isProc", () => {
    it("按 role 判用户发言，按 tag 判过程块", () => {
        expect(isUserText(user("u"))).toBe(true);
        expect(isUserText(say("a"))).toBe(false);
        expect(isProc(think("k"))).toBe(true);
        expect(isProc(tool("x"))).toBe(true);
        expect(isProc(say("a"))).toBe(false);
    });
});

describe("foldedItems：1-2 级的内容（结论恒在其中）", () => {
    it("1 级压摘要、2 级给全文，**两者看见的条目完全一样**（只差截断）", () => {
        // 判据只有一条：末条正文恒在。用户 2026-10-11 口径：「1 级也要看得见结论」——
        // 上一版那个 `{ conclusion: false }`（全收缩）已随"1 级 = 只有一行头"一起取消。
        const t = turn(user("u1"), err("e1"), say("a1"));
        expect(foldedItems(t).map((x) => x.id)).toEqual(["u1", "e1", "a1"]);
    });
});

describe("展开级别：循环 1→2→3→4→1", () => {
    it("逐级上升，到头回到 1（点完最深层回最浅层）", () => {
        let l = DEFAULT_TURN_LEVEL;
        const seen: number[] = [];
        for (let i = 0; i < 4; i++) {
            l = cycleTurnLevel(l);
            seen.push(l);
        }
        expect(seen).toEqual([4, 1, 2, 3]); // 从默认 3 出发
    });

    it("脏值不入级别（isTurnLevel 是唯一判据）", () => {
        for (const bad of [0, 5, -1, 2.5, "3", null, undefined, NaN]) {
            expect(isTurnLevel(bad), String(bad)).toBe(false);
        }
        for (const good of [1, 2, 3, 4]) expect(isTurnLevel(good)).toBe(true);
    });

    it("每级各有一句人话（tip/aria 用，不写死在组件里）", () => {
        expect([1, 2, 3, 4].map((l) => turnLevelLabel(l as 1 | 2 | 3 | 4))).toEqual([
            "摘要结论",
            "完整结论",
            "全部正文",
            "逐条过程",
        ]);
    });

    it("第 5 层（单条过程内容）不在这条循环里：MAX 就是 4，循环永远到不了 5", () => {
        expect(TURN_LEVEL_MAX).toBe(4);
        expect(TURN_DETAIL_LAYER).toBe(TURN_LEVEL_MAX + 1);
        let l = DEFAULT_TURN_LEVEL;
        const touched: number[] = [];
        for (let i = 0; i < 12; i++) touched.push((l = cycleTurnLevel(l)));
        expect(Math.max(...touched)).toBe(TURN_LEVEL_MAX);
    });
});

describe("levelOfTurn：单轮只有「收拢 / 展开」两态（循环归顶部按钮）", () => {
    it("没动过 → 完全跟全局（全局按成 1 = 整体全收缩，不能被单轮逻辑顶回 2）", () => {
        for (const g of [1, 2, 3, 4] as const) expect(levelOfTurn(undefined, g)).toBe(g);
    });

    it("收拢 = 1；展开 = 跟随全局", () => {
        expect(levelOfTurn(true, 3)).toBe(1);
        expect(levelOfTurn(false, 3)).toBe(3);
        expect(levelOfTurn(false, 4)).toBe(4);
        expect(levelOfTurn(false, 2)).toBe(2);
    });

    it("全局为 1 时「展开」给到 2：点了必须看得见变化（否则像坏了）", () => {
        expect(levelOfTurn(true, 1)).toBe(1);
        expect(levelOfTurn(false, 1)).toBe(2);
    });
});

describe("planOfLevel：每一级看得见什么", () => {
    it("1 级：结论压成摘要（中间区不出）", () => {
        expect(planOfLevel(1)).toEqual({ conclusionClamped: true, mid: false, midExpanded: false });
    });
    it("2 级：结论给全文（中间区仍不出）", () => {
        expect(planOfLevel(2)).toEqual({ conclusionClamped: false, mid: false, midExpanded: false });
    });
    it("3 级：中间区可见（正文逐条 + 过程 bar，bar 不铺开）", () => {
        expect(planOfLevel(3)).toEqual({ conclusionClamped: false, mid: true, midExpanded: false });
    });
    it("4 级：过程 bar 铺开成逐条", () => {
        expect(planOfLevel(4)).toEqual({ conclusionClamped: false, mid: true, midExpanded: true });
    });
    it("级别单调：往上一级只会多显示（摘要只会变全文），不会少", () => {
        for (let l = 1; l < TURN_LEVEL_MAX; l++) {
            const a = planOfLevel(l as 1 | 2 | 3 | 4);
            const b = planOfLevel((l + 1) as 1 | 2 | 3 | 4);
            // 摘要 → 全文是"放宽"，所以用"不增"表示不会又截回去
            expect(Number(b.conclusionClamped)).toBeLessThanOrEqual(Number(a.conclusionClamped));
            expect(Number(b.mid)).toBeGreaterThanOrEqual(Number(a.mid));
            expect(Number(b.midExpanded)).toBeGreaterThanOrEqual(Number(a.midExpanded));
        }
    });
});

describe("contentItems：3 级起的中间区（正文逐条 + 连续过程一行 bar）", () => {
    /** 视图：正文/用户/error 取 id，过程段取「首叶子 id + 段内 id 表」 */
    const view = (its: ReturnType<typeof contentItems>) =>
        its.map((i) =>
            i.kind === "proc"
                ? { proc: i.key, parts: i.parts.map((n) => n.id) }
                : { kind: i.kind, id: i.node.id },
        );

    it("正文各自成项（不折行），连续过程折成一行 bar —— 文档序原样", () => {
        // 思考+工具 → 正文① → 思考+工具 → 正文②（②是末条，也照样各自成项）
        const t = turn(think("k1"), tool("x1"), say("a1"), think("k2"), tool("x2"), say("a2"));
        expect(view(contentItems(t))).toEqual([
            { proc: "k1", parts: ["k1", "x1"] },
            { kind: "text", id: "a1" },
            { proc: "k2", parts: ["k2", "x2"] },
            { kind: "text", id: "a2" },
        ]);
    });

    it("顺序 = 文档序：「思考 → 正文」在界面上就是思考的 bar 在前（旧版把正文提到工具前，用户实测踩到）", () => {
        const t = turn(think("k1"), say("a1"));
        expect(view(contentItems(t))).toEqual([
            { proc: "k1", parts: ["k1"] },
            { kind: "text", id: "a1" },
        ]);
    });

    it("用户插话与 error 就地单独成项，并**切断**过程段（两侧的过程不并成一行）", () => {
        const t = turn(user("u1"), think("k1"), say("a1"), user("u2"), err("e1"), think("k2"), say("a9"));
        expect(view(contentItems(t))).toEqual([
            { proc: "k1", parts: ["k1"] },
            { kind: "text", id: "a1" },
            { kind: "user", id: "u2" },
            { kind: "error", id: "e1" },
            { proc: "k2", parts: ["k2"] },
            { kind: "text", id: "a9" },
        ]);
    });

    it("轮首用户发言交给 leadUsers 单独画（此处排除，避免同一句画两遍）", () => {
        const t = turn(user("u1"), say("a1"));
        expect(view(contentItems(t))).toEqual([{ kind: "text", id: "a1" }]);
    });

    it("skip 掉活动块那个节点：它带定高展开体单独画，留在文档序里就是同一块画两遍", () => {
        const t = turn(think("k1"), tool("x1", false), say("a1"));
        const live = leavesOf(t)[1];
        expect(view(contentItems(t, (n) => n === live))).toEqual([
            { proc: "k1", parts: ["k1"] },
            { kind: "text", id: "a1" },
        ]);
    });

    it("段整个被 skip 掉时**不出空段**（否则界面上多一条空白 bar）", () => {
        const t = turn(think("k1"), say("a1"));
        const live = leavesOf(t)[0];
        expect(view(contentItems(t, (n) => n === live))).toEqual([{ kind: "text", id: "a1" }]);
    });

    it("段的 key = 段内首个叶子 id（供 <For> / pin 复用，跨帧稳定）", () => {
        const t = turn(think("k1"), tool("x1"), think("k2"), say("a1"));
        expect(contentItems(t)[0]!.key).toBe("k1");
    });
});

describe("conclusionOf：结论 = 文档序**最后一个叶子**恰好是助理正文", () => {
    it("模型说完就停（正文在末尾）→ 是结论", () => {
        const t = turn(user("u1"), think("k1"), tool("x1"), say("a9"));
        expect(conclusionOf(t)!.id).toBe("a9");
    });

    it("中途被打断（末叶子是工具）→ **没有结论**（旧判据会把中间那句过程话当结论，用户报的 bug）", () => {
        const t = turn(user("u1"), say("a1"), tool("x1", false));
        expect(conclusionOf(t)).toBeNull();
        // 折叠态于是只剩用户发言 —— 不再伪造一条"像结论"的假话
        expect(foldedItems(t).map((x) => x.id)).toEqual(["u1"]);
    });

    it("末叶子是 think / error 同样没有结论", () => {
        expect(conclusionOf(turn(say("a1"), think("k1", false)))).toBeNull();
        expect(conclusionOf(turn(say("a1"), err("e1")))).toBeNull();
    });

    it("末叶子是用户插话 → 正文仍是结论（插话不等于助理说了新话）", () => {
        const t = turn(say("a1"), user("u2"));
        expect(conclusionOf(t)!.id).toBe("a1");
    });
});

describe("sceneTailOf / composeTail：异常结束的「现场」", () => {
    const ended = (type: string, kids: BlockNode[], data: Record<string, unknown> = {}): BlockNode =>
        n("turn", "t1", { endReason: { type, data } }, kids);

    it("completed / max-tokens → 无现场（正文即结论，notice 已说清）", () => {
        expect(sceneTailOf(ended("completed", [tool("x1")]))).toBeNull();
        expect(sceneTailOf(ended("max-tokens", [say("a1")]))).toBeNull();
    });

    it("aborted / interrupted / error / max-steps + 末叶子不是正文 → 末叶子就是现场", () => {
        for (const ty of ["aborted", "interrupted", "error", "max-steps"]) {
            const t = ended(ty, [say("a1"), tool("x1", false)]);
            expect(sceneTailOf(t)!.id, ty).toBe("x1");
        }
    });

    it("异常结束但**末叶子是正文** → 不另开现场（那本就是结论，避免同一句画两遍）", () => {
        expect(sceneTailOf(ended("aborted", [tool("x1"), say("a1")]))).toBeNull();
    });

    it("旧日志（无 endReason）用 attrs.interrupted 兜底", () => {
        const t = n("turn", "t1", { interrupted: true }, [tool("x1", false)]);
        expect(sceneTailOf(t)!.id).toBe("x1");
        expect(sceneTailOf(n("turn", "t1", {}, [tool("x1", false)]))).toBeNull();
    });

    it("composeTail：末叶子是 error → 红条压顶 + 主体取它前一个非 error 叶子", () => {
        const t = ended("error", [tool("x1", false), err("e1")]);
        const sc = composeTail(t, sceneTailOf(t))!;
        expect(sc.error!.id).toBe("e1");
        expect(sc.body!.id).toBe("x1");
    });

    it("composeTail：普通末叶子 → 主体就是它、无错误条", () => {
        const t = ended("aborted", [tool("x1", false)]);
        expect(composeTail(t, sceneTailOf(t))).toEqual({ body: leavesOf(t)[0], error: null });
        expect(composeTail(t, null)).toBeNull();
    });

    it("error 前面没有内容 → 主体为 null（只出红条，不造空体）", () => {
        const t = ended("error", [err("e1")]);
        expect(composeTail(t, sceneTailOf(t))).toEqual({ body: null, error: leavesOf(t)[0] });
    });
});

describe("turnEndNote：结束原因翻成人话（所有级别恒显）", () => {
    const ended = (type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
        n("turn", "t1", { endReason: { type, data }, ...extra });

    it("每个值域都有一句（不给 UI 留 undefined）", () => {
        for (const ty of ["completed", "max-steps", "max-tokens", "aborted", "error", "interrupted"]) {
            const note = turnEndNote(ended(ty, { limit: 60, maxOutputTokens: 4000, source: "abort", message: "x" }));
            if (ty === "completed" || ty === "error") expect(note, ty).toBeNull();
            else expect(note, ty).toBeTruthy();
        }
    });

    it("notice（含限制值的那句）优先于兜底文案", () => {
        expect(turnEndNote(ended("max-steps", { limit: 60 }, { notice: "达到 maxSteps=60 步上限…" }))).toBe(
            "达到 maxSteps=60 步上限…",
        );
    });

    it("max-steps 没带 notice 也能说清（限制值来自 endReason.data）", () => {
        expect(turnEndNote(ended("max-steps", { limit: 8 }))).toContain("8");
    });

    it("消费端断开（detached）与用户停止（abort）分开说", () => {
        expect(turnEndNote(ended("aborted", { source: "detached" }))).toContain("消费端断开");
        expect(turnEndNote(ended("aborted", { source: "abort" }))).toContain("被中断");
    });

    it("error 的细节由 error 块/现场说 —— 这一行不重复", () => {
        expect(turnEndNote(ended("error", { source: "stream", message: "x" }))).toBeNull();
    });

    it("旧日志（无 endReason）：沿用 attrs.interrupted / notice", () => {
        expect(turnEndNote(n("turn", "t1", { interrupted: true }))).toContain("本轮未完成");
        expect(turnEndNote(n("turn", "t1", { notice: "截断了" }))).toBe("截断了");
        expect(turnEndNote(n("turn", "t1", {}))).toBeNull();
    });

    it("endReasonOf 挡住脏值", () => {
        expect(endReasonOf(n("turn", "t1", { endReason: "completed" }))).toBeNull();
        expect(endReasonOf(n("turn", "t1", { endReason: { type: "completed", data: {} } }))).toEqual({
            type: "completed",
            data: {},
        });
    });
});

describe("clampLines：1 级摘要按行截断", () => {
    it("行数不超上限 → 原样，omitted=0（短结论不该显示「已折叠 0 行」）", () => {
        expect(clampLines("a\nb", 3)).toEqual({ text: "a\nb", omitted: 0 });
    });

    it("超出 → 只留前 N 行，并报出被藏起来的行数", () => {
        expect(clampLines("a\nb\nc\nd", 2)).toEqual({ text: "a\nb", omitted: 2 });
    });

    it("按行切而不是按字符切：代码块/列表不会被切在中间", () => {
        expect(clampLines("```\nx=1\n```\ntail", 3).text).toBe("```\nx=1\n```");
    });
});
