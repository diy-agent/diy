// tests/core/chat-fold.test.ts — 轮次折叠语义（显示什么、按什么序、实时区给谁）
//
// 这些是**用户看得见的语义**，不是样式：顺序错一次就是"助理消息跑到用户消息上面"
//（2026-10-04 现象），实时区判错一次就是"步骤一完就空白"或"同一句出现两遍"（review P1-1）。
// 故钉在这里，组件只管画。
import { describe, expect, it } from "vitest";
import {
    DEFAULT_TURN_LEVEL,
    TURN_LEVEL_MAX,
    clampLines,
    cycleTurnLevel,
    foldedItems,
    isProc,
    isTurnLevel,
    isUserText,
    lastAssistantText,
    leadUsers,
    leavesOf,
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

describe("foldedItems：1 级（全收缩）连结论也收起", () => {
    it("conclusion:false → 只留用户发言与 error，末条正文不出现", () => {
        const t = turn(user("u1"), err("e1"), say("a1"));
        expect(foldedItems(t, { conclusion: false }).map((x) => x.id)).toEqual(["u1", "e1"]);
    });

    it("默认（不传）仍是「用户 + error + 末条正文」——2 级沿用同一判据", () => {
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
            "全收缩",
            "结论",
            "全部正文",
            "逐条过程",
        ]);
    });
});

describe("planOfLevel：每一级看得见什么", () => {
    it("1 级什么都没有（连结论都收）", () => {
        expect(planOfLevel(1)).toEqual({ conclusion: false, allTexts: false, stripRows: false });
    });
    it("2 级只有结论", () => {
        expect(planOfLevel(2)).toEqual({ conclusion: true, allTexts: false, stripRows: false });
    });
    it("3 级全部正文 + 图标条（不铺开）", () => {
        expect(planOfLevel(3)).toEqual({ conclusion: true, allTexts: true, stripRows: false });
    });
    it("4 级把图标条铺开成逐条", () => {
        expect(planOfLevel(4)).toEqual({ conclusion: true, allTexts: true, stripRows: true });
    });
    it("级别单调：往上一级只会多显示，不会少", () => {
        for (let l = 1; l < TURN_LEVEL_MAX; l++) {
            const a = planOfLevel(l as 1 | 2 | 3 | 4);
            const b = planOfLevel((l + 1) as 1 | 2 | 3 | 4);
            expect(Number(b.conclusion)).toBeGreaterThanOrEqual(Number(a.conclusion));
            expect(Number(b.allTexts)).toBeGreaterThanOrEqual(Number(a.allTexts));
            expect(Number(b.stripRows)).toBeGreaterThanOrEqual(Number(a.stripRows));
        }
    });
});

describe("clampLines：2 级摘要按行截断", () => {
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
