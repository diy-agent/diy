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
