// tests/core/chat-fold.test.ts — 轮次折叠语义（显示什么、按什么序、实时区给谁）
//
// 这些是**用户看得见的语义**，不是样式：顺序错一次就是"助理消息跑到用户消息上面"
//（2026-10-04 现象），实时区判错一次就是"步骤一完就空白"或"同一句出现两遍"（review P1-1）。
// 故钉在这里，组件只管画。
import { describe, expect, it } from "vitest";
import {
    foldedItems,
    isProc,
    isUserText,
    lastAssistantText,
    leavesOf,
    liveAreaOf,
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
