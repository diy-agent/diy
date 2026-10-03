// tests/core/tab-ancestors.test.ts — 打开列表的**派生数据不落盘**契约
//
// 场景来源（165）：打开的任务父子节点被移动后，导航结构不变或损坏错乱，刷新页面
// 也不修。根因是 `diy_tabs_opened` 里存了打开那一刻的 taskAncestors 快照 ——
// 任务树变了，盘上还是旧祖先链（派生数据落盘 = 两个真相源）。
//
// 这里锁死三件事：
//   ① 落盘的只有真信息 { pageId, ctx }；key / parent / taskAncestors 一律不写
//   ② 旧数据里的派生字段读回时**主动丢弃**，改用当下的树现算
//   ③ 树一变（重新注入 resolver）→ 排序与缩进自动跟上，不需要额外的 reconcile 入口
import { beforeEach, describe, expect, it, vi } from "vitest";
import { taskIndentOf } from "../../src/shared/tab-order";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
} as Storage;

const A = "projects/1/tasks/a";
const C = "projects/1/tasks/c";
const X = "projects/1/tasks/x"; // 无关的顶级任务

/** 每个用例一份全新 store 单例（模块级 signal/memo 只初始化一次） */
async function freshStore() {
    vi.resetModules();
    return (await import("../../src/renderer_solid/store/tabStore")).tabStore;
}

const persisted = (): any[] => JSON.parse(store.get("diy_tabs_opened") ?? "[]");

describe("落盘内容 —— 只有真信息", () => {
    beforeEach(() => store.clear());

    it("open 后盘上只有 { pageId, ctx }（不写 key / parent / taskAncestors）", async () => {
        const tabStore = await freshStore();
        tabStore.setAncestorsResolver(() => [A]);
        tabStore.open("lab", C); // lab 是子页面（注册表 parentPage=task-run）

        expect(persisted()).toEqual([{ pageId: "lab", ctx: C }]);
        // 派生字段在**内存视图**里有，只是不落盘
        expect(tabStore.opened[0]!.key).toBe(`lab:${C}`);
        expect(tabStore.opened[0]!.parent).toBe(`task-run:${C}`);
        expect(tabStore.opened[0]!.taskAncestors).toEqual([A]);
    });

    it("旧数据里的派生字段被丢弃：taskAncestors 改用当下现算", async () => {
        store.set(
            "diy_tabs_opened",
            JSON.stringify([
                { key: "task-run:OLD", pageId: "task-run", ctx: C, parent: "task-run:ZZZ", taskAncestors: ["projects/1/tasks/gone"] },
            ]),
        );
        const tabStore = await freshStore();
        tabStore.setAncestorsResolver((ctx) => (ctx === C ? [A] : undefined));

        const t = tabStore.opened[0]!;
        expect(t.taskAncestors).toEqual([A]); // 不是盘上的 [".../gone"]
        expect(t.parent).toBeUndefined(); // 页面层次由注册表推（task-run 无父页面）
        expect(t.key).toBe(`task-run:${C}`); // 现算，不是盘上的 "task-run:OLD"
    });
});

describe("任务被移动 → 导航结构跟随（165 的回归点）", () => {
    beforeEach(() => store.clear());

    it("子任务改父后：顺序收拢到父之后，缩进从 0 变 1", async () => {
        const tabStore = await freshStore();
        // 初始：C 与 A 是各自独立的一级任务（C 没有祖先）
        let rel: Record<string, string[]> = {};
        tabStore.setAncestorsResolver((ctx) => rel[ctx]);

        tabStore.open("task-run", C);
        tabStore.open("task-run", A);
        expect(tabStore.opened.map((t) => t.ctx)).toEqual([C, A]);
        expect(taskIndentOf(tabStore.opened[0]!, tabStore.opened)).toBe(0);

        // 把 C 移动到 A 之下（树变了；App 通过 resolver 读到新树）
        rel = { [C]: [A] };
        tabStore.setAncestorsResolver((ctx) => rel[ctx]);

        expect(tabStore.opened.map((t) => t.ctx)).toEqual([A, C]); // 收拢：父在前、同族相邻
        const c = tabStore.opened.find((t) => t.ctx === C)!;
        expect(taskIndentOf(c, tabStore.opened)).toBe(1); // 缩进说真话
    });

    it("反复移动不丢 tab、不重复（顺序与内容都稳定）", async () => {
        const tabStore = await freshStore();
        let rel: Record<string, string[]> = { [C]: [A] };
        tabStore.setAncestorsResolver((ctx) => rel[ctx]);
        tabStore.open("task-run", C);
        tabStore.open("task-run", A);

        const moves: Array<Record<string, string[]>> = [{ [C]: [A] }, {}, { [C]: [A] }, {}];
        for (const next of moves) {
            rel = next;
            tabStore.setAncestorsResolver((ctx) => rel[ctx]);
            expect(new Set(tabStore.opened.map((t) => t.key)).size).toBe(2);
            expect(tabStore.opened).toHaveLength(2);
        }
        expect(persisted().map((e) => e.ctx).sort()).toEqual([A, C].sort()); // 盘上仍是两条真信息
    });
});

describe("关父 tab 后导航不挂错（226 的回归点）", () => {
    beforeEach(() => store.clear());

    /**
     * 场景还原（226 实测）：祖 P、父 B、子 C 都开着，无关的顶级 X 后开（队尾）。
     * 关掉 B 的 tab 后，C 的直接父不在列表，但 P 仍开着 —— C 必须紧跟 P，
     * 不得被兜底垫到 X 之后（那样视觉上就成了 X 的子任务）。
     */
    it("关父后：孤儿子任务紧跟仍开着的祖父，不挂到无关任务下", async () => {
        const tabStore = await freshStore();
        const P = "projects/1/tasks/p"; // 祖（148）
        const Buri = "projects/1/tasks/bt"; // 父（225，待关闭）
        const Curi = "projects/1/tasks/ct"; // 子（163）
        const X = "projects/1/tasks/xt"; // 无关根（222）
        const rel: Record<string, string[] | undefined> = {
            [P]: undefined, // 顶级
            [Buri]: [P],
            [Curi]: [P, Buri],
            [X]: undefined, // 无关的顶级任务
        };
        tabStore.setAncestorsResolver((ctx) => rel[ctx]);

        tabStore.open("task-run", P);
        tabStore.open("task-run", Buri);
        tabStore.open("task-run", Curi);
        tabStore.open("task-run", X); // 后开 → insertionIndex 队尾
        expect(tabStore.opened.map((t) => t.ctx)).toEqual([P, Buri, Curi, X]);

        tabStore.close(`task-run:${Buri}`); // 关父：任务层次不连带关子（C 留着）

        expect(tabStore.opened.map((t) => t.ctx)).toEqual([P, Curi, X]); // 实测（修复前）：[P, X, Curi]
        const c = tabStore.opened.find((t) => t.ctx === Curi)!;
        expect(taskIndentOf(c, tabStore.opened)).toBe(1); // P 开着 → 缩进 1 级
        // 缩进指着的必须是它上方那项（P），而不是无关的 X
        const ic = tabStore.opened.findIndex((t) => t.ctx === Curi);
        expect(tabStore.opened[ic - 1]?.ctx).toBe(P);
    });
});

describe("active 悬空回落 —— 启动不得指向不存在的 tab（白屏防线）", () => {
    beforeEach(() => store.clear());

    it("active 指向不在打开列表里的 tab → 启动回落 ''", async () => {
        store.set("diy_tabs_opened", JSON.stringify([{ pageId: "task-run", ctx: A }]));
        store.set("diy_tabs_active", "task-run:projects/1/tasks/gone");
        const tabStore = await freshStore();
        expect(tabStore.active).toBe("");
    });

    it("active 在打开列表里 → 原样保留", async () => {
        store.set("diy_tabs_opened", JSON.stringify([{ pageId: "task-run", ctx: A }]));
        store.set("diy_tabs_active", `task-run:${A}`);
        const tabStore = await freshStore();
        expect(tabStore.active).toBe(`task-run:${A}`);
    });

    it("列表为空 → active ''", async () => {
        store.set("diy_tabs_active", `task-run:${A}`);
        const tabStore = await freshStore();
        expect(tabStore.active).toBe("");
    });
});

describe("dropCtx —— 删除任务后的 tab 清理（226 关联：曾是零调用的死代码）", () => {
    beforeEach(() => store.clear());

    it("摘掉该任务的所有页面 tab（task-run 与 lab 同 ctx 一起走）", async () => {
        const tabStore = await freshStore();
        tabStore.setAncestorsResolver(() => undefined);
        tabStore.open("task-run", A);
        tabStore.open("lab", A); // 子页面，ctx 相同
        tabStore.open("task-run", C);
        expect(tabStore.opened.map((t) => t.key)).toEqual([`task-run:${A}`, `lab:${A}`, `task-run:${C}`]);

        tabStore.dropCtx(A);
        expect(tabStore.opened.map((t) => t.key)).toEqual([`task-run:${C}`]);
        expect(tabStore.active).toBe(`task-run:${C}`);
    });

    it("被摘的恰是 active → 激活原位右邻（不是列表第一个）", async () => {
        const tabStore = await freshStore();
        tabStore.setAncestorsResolver(() => undefined);
        tabStore.open("task-run", A);
        tabStore.open("task-run", C);
        tabStore.open("task-run", X);
        tabStore.activate(`task-run:${C}`); // active 在中间
        expect(tabStore.active).toBe(`task-run:${C}`);

        tabStore.dropCtx(C);
        expect(tabStore.active).toBe(`task-run:${X}`); // 右邻；旧实现跳 next[0] = A
        expect(tabStore.opened.map((t) => t.ctx)).toEqual([A, X]);
    });

    it("ctx 不在打开列表 → 无副作用", async () => {
        const tabStore = await freshStore();
        tabStore.setAncestorsResolver(() => undefined);
        tabStore.open("task-run", A);
        tabStore.dropCtx(C);
        expect(tabStore.opened.map((t) => t.ctx)).toEqual([A]);
        expect(tabStore.active).toBe(`task-run:${A}`);
    });
});
