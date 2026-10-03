// tests/core/task-store.test.ts — 任务树刷新的并发安全
//
// 场景：watch 的 task-change 连发（CLI 建任务、agent 批量改、删除目录…）会触发并发
// loadTree；RPC 响应乱序时**旧响应后到**，若照单 setNodes 树就回退成旧快照 ——
// 树「短暂回退」会让下游按树 diff 的逻辑（如删除任务后摘 tab）误判任务消失。
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
} as Storage;

const h = vi.hoisted(() => ({ loadTaskTree: vi.fn() }));
vi.mock("../../src/renderer_solid/lib/rpc", () => ({
    diyService: { diy: { loadTaskTree: h.loadTaskTree } },
}));

/** 每个用例一份全新 store 单例（模块级 signal 只初始化一次） */
async function freshStore() {
    vi.resetModules();
    return (await import("../../src/renderer_solid/store/taskStore")).taskStore;
}

beforeEach(() => {
    store.clear();
    h.loadTaskTree.mockReset();
});

describe("loadTree —— 并发响应不回退", () => {
    it("顺序完成的 loadTree 正常生效", async () => {
        const taskStore = await freshStore();
        h.loadTaskTree.mockResolvedValueOnce({ data: [{ uri: "projects/1/tasks/1" }] });
        await taskStore.loadTree();
        expect(taskStore.nodes.map((n) => n.uri)).toEqual(["projects/1/tasks/1"]);
    });

    it("旧响应后到 → 丢弃，不覆盖新树（修复前：nodes 被覆盖成旧快照）", async () => {
        const taskStore = await freshStore();
        let resolveOld!: (v: unknown) => void;
        let resolveNew!: (v: unknown) => void;
        h.loadTaskTree
            .mockReturnValueOnce(new Promise((r) => (resolveOld = r)))
            .mockReturnValueOnce(new Promise((r) => (resolveNew = r)));

        const p1 = taskStore.loadTree(); // 旧请求（在途）
        const p2 = taskStore.loadTree(); // 新请求（更新）
        resolveNew({ data: [{ uri: "projects/1/tasks/new" }] });
        await p2;
        resolveOld({ data: [{ uri: "projects/1/tasks/old" }] });
        await p1;

        expect(taskStore.nodes.map((n) => n.uri)).toEqual(["projects/1/tasks/new"]);
    });
});
