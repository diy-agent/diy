// tests/core/local-blocks-compact.test.ts
// 🎯 compactOps（会话折叠）—— 判据只有一条：**块树等价**。
//
// 折叠把逐 token 落盘的 op 碎片压成「每块 start + 终值 patch + stop」：消费端（渲染端 /
// CLI）拿到的东西一模一样，但一次 74MB / 877,050 op 的会话只剩 ~15MB / 1.8 万 op。
// 这里把容易出错、且**真实日志里出现过**的形态逐个钉住：
//   · 逐 token delta（Text）→ 一次终值；List 追加 / 点分路径；
//   · Flag 字段收到 delta 被忽略（终值取 meta，折叠后不许把它写回去）；
//   · 未闭合残留（崩溃被杀）、交叉闭合（非 LIFO stop）、重复 start、孤儿 parent；
//   · **root 不该被前一棵未闭合子树认领** —— 这是「parent 省字段 + 隐式栈顶」的经典陷阱，
//     折叠流里无父块必须显式写 `parent: null`（undefined 在 JSON 里会整字段消失）。
import { describe, it, expect } from "vitest";
import { BlockStore, compactOps, replay, toForest, type Op } from "../../src/main/services/local-blocks";

/** 块树快照：只取**语义**（结构 + 终值字段），不含 touched（fold 的时序号，重放会重编） */
function snapshot(store: BlockStore) {
    const STRUCT = new Set(["id", "kind", "parent", "children", "stopped", "touched"]);
    return {
        roots: store.roots().map((r) => r.id),
        blocks: [...store.blocks.values()]
            .map((b) => ({
                id: b.id,
                kind: b.kind,
                parent: b.parent ?? null,
                children: [...b.children],
                stopped: b.stopped,
                fields: Object.fromEntries(
                    Object.entries(b)
                        .filter(([k]) => !STRUCT.has(k))
                        .sort(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0)),
                ),
            }))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    };
}

/** 等价断言：① 折叠后重放 ≡ 原树；② 再折一次不变（幂等） */
function expectEquivalent(src: Op[]): Op[] {
    const store = replay(src);
    const compacted = compactOps(store);
    expect(snapshot(replay(compacted))).toEqual(snapshot(store));
    expect(compactOps(replay(compacted))).toEqual(compacted);
    return compacted;
}

/** 从折叠流里取某块的 patch 字段（取不到返回 undefined） */
function patchFields(compacted: Op[], id: string): Record<string, unknown> | undefined {
    const o = compacted.find((x) => x.op === "patch" && x.id === id);
    return o && o.op === "patch" ? o.fields : undefined;
}

const TURN: Op[] = [
    { op: "start", id: "t1", kind: "turn", meta: { model: "m", status: "running" } },
    { op: "start", id: "t1_s1", kind: "step", parent: "t1" },
    { op: "start", id: "t1_a1", kind: "text", parent: "t1_s1", meta: { role: "assistant" } },
    { op: "delta", id: "t1_a1", fields: { content: "三" } },
    { op: "delta", id: "t1_a1", fields: { content: "体" } },
    { op: "delta", id: "t1_a1", fields: { content: "叠加" } },
    { op: "stop", id: "t1_a1" },
    { op: "stop", id: "t1_s1" },
    { op: "patch", id: "t1", fields: { status: "done", durationMs: 12 } },
    { op: "stop", id: "t1" },
];

describe("compactOps — 基本等价与减量", () => {
    it("逐 token delta 折成一次终值 patch，块树不变", () => {
        const compacted = expectEquivalent(TURN);
        expect(patchFields(compacted, "t1_a1")?.["content"]).toBe("三体叠加");
        expect(patchFields(compacted, "t1")?.["status"]).toBe("done");
        // a1 块：原 5 条（start + 3 delta + stop）→ 恰好 start + 1 patch + stop
        const a1Ops = compacted.filter((o) => o.id === "t1_a1");
        expect(a1Ops.map((o) => o.op)).toEqual(["start", "patch", "stop"]);
    });

    it("op 数大幅下降（每块最多 start+patch+stop）", () => {
        // 200 轮 × 每轮 1 text 块 × 100 delta ≈ 2 万条；折叠后 ≈ 每块 3 条
        const big: Op[] = [];
        for (let i = 0; i < 200; i++) {
            const t = `t${i}`;
            big.push({ op: "start", id: t, kind: "turn" });
            big.push({ op: "start", id: `${t}_a`, kind: "text", parent: t, meta: { role: "assistant" } });
            for (let k = 0; k < 100; k++) big.push({ op: "delta", id: `${t}_a`, fields: { content: "字" } });
            big.push({ op: "stop", id: `${t}_a` });
            big.push({ op: "stop", id: t });
        }
        const compacted = expectEquivalent(big);
        expect(big.length).toBeGreaterThan(20_000);
        expect(compacted.length).toBeLessThan(big.length / 10); // 每块 ≤3 条
        expect(patchFields(compacted, "t199_a")?.["content"]).toBe("字".repeat(100));
    });
});

describe("compactOps — 结构边界（真实日志里出现过的形态）", () => {
    it("未闭合残留（崩溃/被杀）照原样保留未 stop", () => {
        const src: Op[] = [
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "t1_a", kind: "text", parent: "t1", meta: { role: "assistant" } },
            { op: "delta", id: "t1_a", fields: { content: "说到一半" } },
            // 无 stop
        ];
        const compacted = expectEquivalent(src);
        expect(compacted.some((o) => o.op === "stop")).toBe(false);
        expect(replay(compacted).blocks.get("t1_a")!.stopped).toBe(false);
    });

    it("交叉闭合（非 LIFO stop）不改变父子关系", () => {
        const src: Op[] = [
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "t1_s1", kind: "step", parent: "t1" },
            { op: "start", id: "t1_a", kind: "text", parent: "t1_s1" },
            // 先停父（step）再停子（text）—— 允许的交叉闭合
            { op: "stop", id: "t1_s1" },
            { op: "stop", id: "t1_a" },
            { op: "stop", id: "t1" },
        ];
        const compacted = expectEquivalent(src);
        expect(replay(compacted).blocks.get("t1_a")!.parent).toBe("t1_s1");
    });

    it("重复 start：后者被忽略，折叠后仍只有一棵", () => {
        const src: Op[] = [
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "t1_a", kind: "text", parent: "t1" },
            { op: "start", id: "t1_a", kind: "text", parent: "t1" }, // 重复
            { op: "delta", id: "t1_a", fields: { content: "x" } },
        ];
        expectEquivalent(src);
    });

    it("孤儿 parent（指向不存在的块）仍成根，且折叠后不被栈顶认领", () => {
        const src: Op[] = [
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "t1_a", kind: "text", parent: "t1" },
            // t1 / t1_a 都没 stop → 重放折叠流时栈里有货
            { op: "start", id: "orphan", kind: "step", parent: "ghost" },
        ];
        const store = replay(src);
        expect(store.blocks.get("orphan")!.parent).toBeUndefined();
        expect(store.roots().map((r) => r.id)).toEqual(["t1", "orphan"]);

        const compacted = compactOps(store);
        expect(snapshot(replay(compacted))).toEqual(snapshot(store));
        // 关键：无父块必须写显式 null；写成 undefined（JSON 里消失）会被栈顶认领 → 挂到 t1_a 下
        const startOp = compacted.find((o) => o.op === "start" && o.id === "orphan");
        expect(startOp && startOp.op === "start" ? startOp.parent : "MISSING").toBeNull();
        expect(replay(compacted).blocks.get("orphan")!.parent).toBeUndefined();
    });

    it("显式 parent: null 与 turn 同样落成根（协议扩展的双向验证）", () => {
        const src: Op[] = [
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "t1_a", kind: "text", parent: "t1" },
            { op: "start", id: "later", kind: "step", parent: null }, // 显式无父
        ];
        const store = replay(src);
        expect(store.blocks.get("later")!.parent).toBeUndefined();
        expect(store.roots().map((r) => r.id)).toEqual(["t1", "later"]);
        expectEquivalent(src);
    });
});

describe("compactOps — 字段语义", () => {
    it("Flag 字段收到 delta 被忽略：终值取 meta，折叠不许写回 delta 值", () => {
        const src: Op[] = [
            { op: "start", id: "t1", kind: "turn", meta: { status: "running" } },
            { op: "delta", id: "t1", fields: { status: "done" } }, // Flag 拒 delta（issue，忽略）
            { op: "stop", id: "t1" },
        ];
        const store = replay(src);
        expect(store.blocks.get("t1")!["status"]).toBe("running");
        const compacted = expectEquivalent(src);
        expect(patchFields(compacted, "t1")?.["status"]).toBe("running");
    });

    it("List 追加与点分路径（plan.items / usage.in）", () => {
        const src: Op[] = [
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "t1_p", kind: "plan", parent: "t1" },
            { op: "delta", id: "t1_p", fields: { items: ["a"] } },
            { op: "delta", id: "t1_p", fields: { items: ["b", "c"] } },
            { op: "stop", id: "t1_p" },
            { op: "patch", id: "t1", fields: { "usage.in": 11, "usage.out": 22 } },
        ];
        const compacted = expectEquivalent(src);
        expect(patchFields(compacted, "t1_p")?.["items"]).toEqual(["a", "b", "c"]);
        const turn = replay(compacted).blocks.get("t1")!;
        expect((turn["usage"] as Record<string, unknown>)["in"]).toBe(11);
        expect((turn["usage"] as Record<string, unknown>)["out"]).toBe(22);
    });

    it("patch 覆盖 delta：终值 = 最后一次覆盖", () => {
        const src: Op[] = [
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "t1_a", kind: "text", parent: "t1" },
            { op: "delta", id: "t1_a", fields: { content: "草" } },
            { op: "patch", id: "t1_a", fields: { content: "定稿" } },
            { op: "delta", id: "t1_a", fields: { content: "!" } },
            { op: "stop", id: "t1_a" },
        ];
        const compacted = expectEquivalent(src);
        expect(patchFields(compacted, "t1_a")?.["content"]).toBe("定稿!");
    });
});

// ─── 渲染端增量并入：折叠流幂等 ⇒ 未变的轮次引用不变（<For> 只重建真正变化的那轮）───
//
// 这是「轮末不再全量重建」的**前提**：旧实现每轮 reload 都 new BlockStore() 全量 fold，
// 于是 toForest 的身份缓存失效 → 每一轮都被销毁重建（全量 Markdown re-parse = GC 风暴）。
// 折叠流幂等（start 重复忽略 / patch 值未变不写不 touch / stop 幂等），重复 apply 才安全。
describe("渲染端增量并入（幂等 ⇒ 身份复用）", () => {
    const oneTurn = (i: number): Op[] => [
        { op: "start", id: `t${i}`, kind: "turn" },
        { op: "start", id: `t${i}_a`, kind: "text", parent: `t${i}`, meta: { role: "assistant" } },
        { op: "delta", id: `t${i}_a`, fields: { content: "内容" + i } },
        { op: "stop", id: `t${i}_a` },
        { op: "stop", id: `t${i}` },
    ];

    it("对同一份折叠流重复 apply：块树不变，toForest 返回同一引用", () => {
        const store = replay([...oneTurn(1), ...oneTurn(2)]);
        const t1 = toForest(store);
        for (const op of compactOps(store)) store.apply(op); // 再喂一遍（模拟轮末 reload）
        const t2 = toForest(store);
        expect(t2).toEqual(t1);
        expect(t2[0]).toBe(t1[0]); // 关键：同引用 ⇒ <For> 不会销毁重建
        expect(t2[1]).toBe(t1[1]);
    });

    it("追加一轮后：老轮引用不变，只有新轮是新对象", () => {
        const store = replay(oneTurn(1));
        const before = toForest(store);
        const full = replay([...oneTurn(1), ...oneTurn(2)]);
        for (const op of compactOps(full)) store.apply(op); // 把"整份新流"并进来
        const after = toForest(store);
        expect(after.length).toBe(2);
        expect(after[0]).toBe(before[0]); // 老轮：引用不变
        expect(after[1]).not.toBe(before[1]); // 新轮：新对象
    });

    it("内容真的变了 → 引用必须更新（幂等不能退化成'永不更新'）", () => {
        const store = replay(oneTurn(1));
        const before = toForest(store);
        // 后到的 patch 改了 turn 的耗时（内容真变）
        store.apply({ op: "patch", id: "t1", fields: { durationMs: 99 } });
        const after = toForest(store);
        expect(after[0]).not.toBe(before[0]);
        expect((after[0]!.attrs as Record<string, unknown>)["durationMs"]).toBe(99);
    });

    it("stop 后到的补丁（如崩溃后补的收敛 stop）也会反映出来", () => {
        const store = replay([
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "t1_a", kind: "text", parent: "t1" },
        ]);
        expect(toForest(store)[0]!.stopped).toBe(false);
        store.apply({ op: "stop", id: "t1_a" });
        store.apply({ op: "stop", id: "t1" });
        expect(toForest(store)[0]!.stopped).toBe(true);
    });
});
