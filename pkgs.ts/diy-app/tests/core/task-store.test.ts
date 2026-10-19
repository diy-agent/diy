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

const h = vi.hoisted(() => ({ loadTaskTree: vi.fn(), getTask: vi.fn() }));
vi.mock("../../src/renderer_solid/lib/rpc", () => ({
    diyService: { diy: { loadTaskTree: h.loadTaskTree, getTask: h.getTask } },
}));

/** 每个用例一份全新 store 单例（模块级 signal 只初始化一次） */
async function freshStore() {
    vi.resetModules();
    return (await import("../../src/renderer_solid/store/taskStore")).taskStore;
}

const { getTaskVerdict } = await import("../../src/shared/task-load");

beforeEach(() => {
    store.clear();
    h.loadTaskTree.mockReset();
    h.getTask.mockReset();
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

describe("selectTask —— 「任务不存在」是显式终态（不再是静默 return）", () => {
    it("契约的「未找到」（status:error, data:null）→ selectedMissing=true、selectedTask=null", async () => {
        const taskStore = await freshStore();
        h.getTask.mockResolvedValueOnce({ status: "error", data: null });
        await taskStore.selectTask("projects/1/tasks/gone");
        expect(taskStore.selectedMissing).toBe(true);
        expect(taskStore.selectedTask).toBeNull();
        expect(taskStore.selectedUri).toBe("projects/1/tasks/gone");
    });

    it("正常返回 → selectedMissing 复位、selectedTask 是载荷", async () => {
        const taskStore = await freshStore();
        h.getTask.mockResolvedValueOnce({
            status: "ok",
            data: { uri: "projects/1/tasks/ok", updated: "2026-01-01T00:00:00.000Z" },
        });
        await taskStore.selectTask("projects/1/tasks/ok");
        expect(taskStore.selectedMissing).toBe(false);
        expect(taskStore.selectedTask?.uri).toBe("projects/1/tasks/ok");
    });

    it("切任务后迟到的「不存在」响应被丢弃（不污染新选中态）", async () => {
        const taskStore = await freshStore();
        let resolveSlow!: (v: unknown) => void;
        h.getTask.mockReturnValueOnce(new Promise((r) => (resolveSlow = r))); // A 的慢响应
        h.getTask.mockResolvedValueOnce({
            status: "ok",
            data: { uri: "projects/1/tasks/b", updated: "2026-01-01T00:00:00.000Z" },
        }); // B 的快响应
        const pa = taskStore.selectTask("projects/1/tasks/a");
        await taskStore.selectTask("projects/1/tasks/b");
        resolveSlow({ status: "error", data: null }); // A 已不在选中 → 丢弃
        await pa;
        expect(taskStore.selectedUri).toBe("projects/1/tasks/b");
        expect(taskStore.selectedMissing).toBe(false);
        expect(taskStore.selectedTask?.uri).toBe("projects/1/tasks/b");
    });
});

describe("treeLoaded —— 区分「树还没到」与「树里真没有」（剪枝判据用它）", () => {
    it("加载成功前置 false；成功一次后置 true", async () => {
        const taskStore = await freshStore();
        expect(taskStore.treeLoaded).toBe(false);
        h.loadTaskTree.mockResolvedValueOnce({ data: [] });
        await taskStore.loadTree();
        expect(taskStore.treeLoaded).toBe(true);
    });
});

describe("getTaskVerdict —— renderer「任务不存在」判定的唯一判据", () => {
    it("status:error / data:null / 空响应 一律 missing", () => {
        expect(getTaskVerdict({ status: "error", data: null })).toBe("missing");
        expect(getTaskVerdict({ status: "ok", data: null })).toBe("missing");
        expect(getTaskVerdict({ status: "ok" })).toBe("missing");
        expect(getTaskVerdict(null)).toBe("missing");
        expect(getTaskVerdict(undefined)).toBe("missing");
    });
    it("显式 ok + 载荷 才是 ok", () => {
        expect(getTaskVerdict({ status: "ok", data: { uri: "projects/1/tasks/1" } })).toBe("ok");
        expect(getTaskVerdict({ status: "weird", data: { uri: "x" } })).toBe("missing");
    });
});
