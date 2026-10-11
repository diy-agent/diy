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
    lastAssistantText,
    leadUsers,
    leavesOf,
    levelOfTurn,
    liveAreaOf,
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
const say = (id: string) => n("text", id, { content: id }); // 助理正文
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
        expect(lastAssistantText(t)).toBeNull();
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

describe("liveAreaOf：轮尾实时区", () => {
    it("非直播轮次没有实时区", () => {
        expect(liveAreaOf(turn(user("u1"), tool("x1", false)), false)).toBeNull();
    });

    it("一步在跑 → active（给展开体）", () => {
        const t = turn(user("u1"), tool("x1", false));
        expect(liveAreaOf(t, true)).toEqual({ node: leavesOf(t)[1], active: true });
    });

    it("一步跑完、后面还没有助理内容 → 不消失（waiting + ⋯）", () => {
        const t = turn(user("u1"), tool("x1"));
        const a = liveAreaOf(t, true);
        expect(a?.active).toBe(false);
        expect(isProc(a!.node)).toBe(true);
    });

    it("跑完后的用户插话不算「助理内容」，仍然 waiting（否则空白期又回来了）", () => {
        const t = turn(tool("x1"), user("u2"));
        expect(liveAreaOf(t, true)?.active).toBe(false);
    });

    it("后面已有助理内容在流 → 让位（那块内容本身就是当前活动）", () => {
        expect(liveAreaOf(turn(tool("x1"), say("a1")), true)).toBeNull();
        expect(liveAreaOf(turn(tool("x1"), err("e1")), true)).toBeNull();
    });

    it("还没有任何过程块 → 没有实时区（那段时间交给「等待响应」loading）", () => {
        expect(liveAreaOf(turn(user("u1")), true)).toBeNull();
    });

    it("取的是最后一个过程块（think/tool 混排也一样）", () => {
        const t = turn(think("k1"), tool("x1"), think("k2", false));
        expect(liveAreaOf(t, true)?.node.id).toBe("k2");
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

    it("skip 掉实时区那个节点：它画在轮尾，留在文档序里就是同一块画两遍", () => {
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
