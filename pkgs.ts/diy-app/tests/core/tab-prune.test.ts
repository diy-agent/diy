// tests/core/tab-prune.test.ts — 「任务被删后该剪哪些 tab」的判据（##361）
//
// 为什么必须单测（##329 R1 的教训：UI 语义判据要有断言，不靠「界面看着对」）：
//   ① 只剪任务是 ctx 的 tab —— 剪宽了会把 labs/settings 之类别的 ctx 一起误伤；
//   ② 树**还没成功加载过**时一律不剪 —— 启动瞬间 nodes=[] 是「树还没到」，
//      照剪会把用户上次开着、被恢复出来的 tab 全部清光；
//   ③ 剪枝只认**最新那一份**树：旧响应后到时由 taskStore.loadTree 丢弃，
//      这里用一次真实并发请求证明「不会拿过期快照剪」。
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const h = vi.hoisted(() => ({ loadTaskTree: vi.fn() }));
vi.mock("../../src/renderer_solid/lib/rpc", () => ({
  diyService: { diy: { loadTaskTree: h.loadTaskTree } },
}));

const { staleTaskTabCtxs } = await import("../../src/shared/tab-prune");

const A = "projects/1/tasks/a";
const B = "projects/1/tasks/b";

beforeEach(() => {
  store.clear();
  h.loadTaskTree.mockReset();
});

describe("staleTaskTabCtxs —— 判据本身", () => {
  it("树还没加载过 → 一律不剪（空树是「树还没到」，不是「任务不存在」）", () => {
    expect(
      staleTaskTabCtxs({ opened: [{ pageId: "task-run", ctx: A }], aliveUris: [], treeLoaded: false }),
    ).toEqual([]);
  });

  it("任务 tab 不在树上 → 剪；在树上 → 留", () => {
    const opened = [
      { pageId: "task-run", ctx: A },
      { pageId: "task-run", ctx: B },
    ];
    expect(staleTaskTabCtxs({ opened, aliveUris: [A], treeLoaded: true })).toEqual([B]);
    expect(staleTaskTabCtxs({ opened, aliveUris: [A, B], treeLoaded: true })).toEqual([]);
  });

  it("非任务 ctx（lab 的别的 ctx / settings 无 ctx）不动", () => {
    const opened = [
      { pageId: "lab", ctx: "some-non-task-ctx" },
      { pageId: "settings", ctx: null },
    ];
    expect(staleTaskTabCtxs({ opened, aliveUris: [], treeLoaded: true })).toEqual([]);
  });

  it("同一任务的多个 tab（task-run + lab 子页面）只报一次 ctx", () => {
    const opened = [
      { pageId: "task-run", ctx: A },
      { pageId: "lab", ctx: A },
      { pageId: "ctxlab", ctx: A },
    ];
    expect(staleTaskTabCtxs({ opened, aliveUris: [], treeLoaded: true })).toEqual([A]);
  });
});

describe("剪枝挂在**最新**那份树上（过期快照不剪）", () => {
  it("旧响应后到被丢弃：alive 仍含 A → 不剪 A", async () => {
    vi.resetModules();
    const { taskStore } = await import("../../src/renderer_solid/store/taskStore");
    let resolveOld!: (v: unknown) => void;
    let resolveNew!: (v: unknown) => void;
    h.loadTaskTree
      .mockReturnValueOnce(new Promise((r) => (resolveOld = r))) // 旧请求
      .mockReturnValueOnce(new Promise((r) => (resolveNew = r))); // 新请求

    const p1 = taskStore.loadTree();
    const p2 = taskStore.loadTree();
    resolveNew({ data: [{ uri: A }] });
    await p2;
    resolveOld({ data: [] }); // 过期快照：若被采纳，A 会被误判成「已删」
    await p1;

    const alive = new Set<string>();
    const walk = (ns: { uri?: string; children?: unknown[] }[]): void => {
      for (const n of ns) {
        if (n.uri) alive.add(n.uri);
        walk((n.children ?? []) as { uri?: string; children?: unknown[] }[]);
      }
    };
    walk(taskStore.nodes);
    const stale = staleTaskTabCtxs({
      opened: [{ pageId: "task-run", ctx: A }],
      aliveUris: alive,
      treeLoaded: taskStore.treeLoaded,
    });
    expect(stale).toEqual([]); // 修复前（若用旧快照）这里会是 [A] → 误剪活着的 tab
  });
});
