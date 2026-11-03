// tests/core/local-blocks-identity.test.ts
// 🎯 树导出的**身份稳定性**（任务 236 的治本点）：
//    未变的子树必须返回同一对象，否则 UI 的 `<For>`（按引用 diff）每帧销毁重建整棵树
//    —— 折叠态被清、点击像没反应、长回答全量 Markdown re-parse。
//
// 这些用例锁的是**契约**（引用相等 = 内容未变），不是实现细节：
// 换一种缓存实现也可以，但"未变 ⇒ 同引用"这条不能破。

import { describe, it, expect } from "vitest";
import { BlockStore, toTree, toForest, type Op } from "../../src/main/services/local-blocks";

/** 一段有代表性的事件流：turn → step → (user text, think, tool, text) */
function session(): BlockStore {
    const s = new BlockStore();
    const ops: Op[] = [
        { op: "start", id: "t1", kind: "turn" },
        { op: "start", id: "s1", kind: "step" },
        { op: "start", id: "u1", kind: "text", meta: { role: "user" } },
        { op: "delta", id: "u1", fields: { content: "你好" } },
        { op: "stop", id: "u1" },
        { op: "start", id: "k1", kind: "think" },
        { op: "delta", id: "k1", fields: { content: "想一下" } },
        { op: "stop", id: "k1" },
        { op: "start", id: "x1", kind: "tool", meta: { tool: "bash" } },
        { op: "patch", id: "x1", fields: { status: "done", output: "ok" } },
        { op: "stop", id: "x1" },
        { op: "start", id: "a1", kind: "text", meta: { role: "assistant" } },
        { op: "delta", id: "a1", fields: { content: "第一段" } },
        { op: "stop", id: "a1" },
        { op: "stop", id: "s1" },
    ];
    for (const op of ops) s.apply(op);
    return s;
}

const find = (root: ReturnType<typeof toTree>, id: string) => {
    const walk = (n: typeof root): typeof root | undefined => {
        if (n.id === id) return n;
        for (const c of n.children) {
            const r = walk(c);
            if (r) return r;
        }
        return undefined;
    };
    return walk(root)!;
};

describe("toTree 身份稳定性（未变 ⇒ 同引用）", () => {
    it("两次导出之间没有任何 op → 整棵树、逐层、连 attrs 都是同一对象", () => {
        const s = session();
        const a = toTree(s, "t1");
        const b = toTree(s, "t1");
        expect(b).toBe(a);
        expect(find(b, "s1")).toBe(find(a, "s1"));
        expect(find(b, "a1")).toBe(find(a, "a1"));
        expect(find(b, "a1").attrs).toBe(find(a, "a1").attrs);
    });

    it("深叶子追加 delta → 该叶子与**其祖先**换新引用，兄弟支原样复用", () => {
        const s = session();
        const before = toTree(s, "t1");
        const thinkBefore = find(before, "k1");
        const toolBefore = find(before, "x1");
        s.apply({ op: "start", id: "a2", kind: "text", meta: { role: "assistant" } });
        s.apply({ op: "delta", id: "a2", fields: { content: "第二段" } });
        const after = toTree(s, "t1");
        expect(after).not.toBe(before); // 根变了（子树多了一支）
        expect(find(after, "a2").attrs.content).toBe("第二段");
        expect(find(after, "k1")).toBe(thinkBefore); // 旁支连对象都不换
        expect(find(after, "x1")).toBe(toolBefore);
    });

    it("深层块追加 delta → 只有从该块到根的路径换引用", () => {
        const s = session();
        const before = toTree(s, "t1");
        const uBefore = find(before, "u1");
        const kBefore = find(before, "k1");
        s.apply({ op: "start", id: "a3", kind: "text", meta: { role: "assistant" } });
        const mid = toTree(s, "t1");
        s.apply({ op: "delta", id: "a3", fields: { content: "流式" } });
        const after = toTree(s, "t1");
        expect(find(after, "a3")).not.toBe(find(mid, "a3"));
        expect(find(after, "u1")).toBe(uBefore); // 前面完成的块原地不动
        expect(find(after, "k1")).toBe(kBefore);
    });

    it("**只**新增子块（父块自身没被 touch）也要让父换引用 —— 否则新内容整支看不见", () => {
        const s = new BlockStore();
        s.apply({ op: "start", id: "t1", kind: "turn" });
        const a = toTree(s, "t1");
        expect(a.children).toHaveLength(0);
        s.apply({ op: "start", id: "s1", kind: "step" }); // start 只 push 到父的 children，不 touch 父
        const b = toTree(s, "t1");
        expect(b).not.toBe(a);
        expect(b.children.map((c) => c.id)).toEqual(["s1"]);
    });

    it("stop 改变 stopped → 换引用（interrupted 标记随之消失）", () => {
        const s = new BlockStore();
        s.apply({ op: "start", id: "t1", kind: "turn" });
        s.apply({ op: "start", id: "a1", kind: "text", meta: { role: "assistant" } });
        const open = toTree(s, "t1");
        expect(find(open, "a1").attrs.interrupted).toBe(true);
        s.apply({ op: "stop", id: "a1" });
        const closed = toTree(s, "t1");
        expect(find(closed, "a1")).not.toBe(find(open, "a1"));
        expect(find(closed, "a1").attrs.interrupted).toBeUndefined();
        expect(find(closed, "a1").stopped).toBe(true);
    });

    it("patch 走 touched → 也换引用（用量页脚靠这条每步更新）", () => {
        const s = session();
        const a = toTree(s, "t1");
        s.apply({ op: "patch", id: "t1", fields: { usage: { inputTotal: 1 } } });
        const b = toTree(s, "t1");
        expect(b).not.toBe(a);
        expect(find(b, "t1").attrs.usage).toEqual({ inputTotal: 1 });
    });

    it("不同 store 之间不串缓存（各自独立导出）", () => {
        const s1 = session();
        const s2 = session();
        const n1 = toTree(s1, "t1");
        const n2 = toTree(s2, "t1");
        expect(n2).not.toBe(n1);
        expect(n2.attrs).not.toBe(n1.attrs);
    });

    it("toForest 与逐个 toTree 等价，且共用同一套缓存", () => {
        const s = session();
        s.apply({ op: "start", id: "t2", kind: "turn" });
        const forest = toForest(s);
        expect(forest.map((n) => n.id)).toEqual(["t1", "t2"]);
        expect(forest[0]).toBe(toTree(s, "t1")); // 同一缓存出口
    });

    it("悬挂 rootId 不再整棵树崩（返回占位节点并出声）", () => {
        const s = new BlockStore();
        const n = toTree(s, "不存在");
        expect(n.id).toBe("不存在");
        expect(n.tag).toBe("error");
    });
});
