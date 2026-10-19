// tests/core/local-chat-store-live-race.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 「发消息一刹那闪『⚠ 本轮未完成（流中断/崩溃恢复）』」的**回归契约**（任务 ##390）
//
// 现场（用户 2026-10-20 报）：任务页每次发出消息的一刹那，最后那一轮下方闪一条黄字，随即消失。
//
// 根因是**两段叠加**：
//   ① 黄字的判据 = `!isLiveTurn() && turnEndNote(turn)`；而 `turnEndNote` 对"没收 stop、
//      无 endReason"的轮次给的就是这句（chat-fold）。
//   ② `isLiveTurn()` 的 gating 是 `localChatStore.live`，它**只**由真值（`agent.local.running`）
//      与本地 `running` 拼成；任务页自 ##377 第 17 刀起走 `sendViaRoom`，**不接管 running**
//      ⇒ `live` 完全依赖真值 RPC。而 `applyOpsFrame` 是「先把 op 落树、**之后**才去问真值」，
//      中间必然渲染至少一帧：新轮已入树（未收 stop）+ live 仍 false ⇒ 黄字一闪。
//
// 本文件盯住**同一个判据的两侧**（缺一条就会往反面跑）：
//   A. 轮次 start 帧到达、真值还没回来 ⇒ 必须立刻算"直播中"（不许闪黄字）；
//   B. 轮次真收尾（stop 帧）⇒ 必须立刻收敛，且不得滞留成永久 live；
//   C. 轮次**真断了**（无 stop、无 endReason、main 也不再持它）⇒ 黄字仍然必须显示
//      —— 把真断流藏起来比误报更糟。
// ═══════════════════════════════════════════════════════════════

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockNode, Op } from "../../src/main/services/local-blocks";
import type { OpsFrame } from "../../src/shared/ops-frame";
import { liveTurnOf, turnEndNote } from "../../src/renderer_solid/lib/chat-fold";

/** 手动可控的异步帧流（opsWatch 的返回物）—— 同 local-chat-store-single-channel 的替身 */
function makeSub() {
    const buf: OpsFrame[] = [];
    let wake: (() => void) | null = null;
    return {
        push(f: OpsFrame) {
            buf.push(f);
            wake?.();
        },
        async *[Symbol.asyncIterator](): AsyncGenerator<OpsFrame> {
            for (;;) {
                while (buf.length > 0) yield buf.shift()!;
                await new Promise<void>((r) => {
                    wake = r;
                });
                wake = null;
            }
        },
    };
}

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

const h = vi.hoisted(() => ({
    historyWindow: vi.fn(),
    historyOlder: vi.fn(),
    opsWatermark: vi.fn(),
    opsWatch: vi.fn(),
    running: vi.fn(),
    usage: vi.fn(),
    steerList: vi.fn(),
    addToast: vi.fn(),
    sub: null as null | { push: (f: unknown) => void },
}));

vi.mock("../../src/renderer_solid/lib/rpc", () => ({
    diyService: {
        diy: {
            agent: {
                local: {
                    historyWindow: h.historyWindow,
                    historyOlder: h.historyOlder,
                    opsWatermark: h.opsWatermark,
                    opsWatch: h.opsWatch,
                    running: h.running,
                    usage: h.usage,
                    steer: { list: h.steerList },
                },
            },
        },
    },
}));
vi.mock("../../src/renderer_solid/store/personaStore", () => ({ personaStore: { load: async () => {} } }));
vi.mock("../../src/renderer_solid/store/notificationStore", () => ({
    notificationStore: { addToast: h.addToast },
}));

// node 环境没有 rAF；替身必须**延后执行**、由 settle() 手动跑（同 single-channel 用例的注释）
const rafQueue: Array<() => void> = [];
beforeAll(() => {
    (globalThis as unknown as { requestAnimationFrame: (cb: (t: number) => void) => number }).requestAnimationFrame = (
        cb,
    ) => {
        rafQueue.push(() => cb(0));
        return rafQueue.length;
    };
});

const URI = "projects/1/tasks/1";

let feedSeq = 0;

/** 推一帧增量（模拟 opsFeed 的 batch：一行一个 op，行号即 seq） */
function pushBatch(ops: Op[]) {
    for (const op of ops) {
        feedSeq += 1;
        h.sub!.push({ kind: "batch", epoch: 0, fromSeq: feedSeq, ops: [op] });
    }
}

/** 让订阅循环把已推的帧跑完，并跑掉合帧回调 */
async function settle(rounds = 8) {
    for (let i = 0; i < rounds; i++) {
        await new Promise((r) => setTimeout(r, 0));
        while (rafQueue.length > 0) rafQueue.shift()!();
    }
}

async function freshStore() {
    vi.resetModules();
    return (await import("../../src/renderer_solid/store/localChatStore")).localChatStore;
}

/** 与 LocalChatPage 的 `isLiveTurn()` 同源的判据：live 为真 + chat-fold 认定的"直播中的那一轮" */
function liveTurnId(store: { live: boolean; trees: BlockNode[] }): string | null {
    return store.live ? (liveTurnOf(store.trees)?.id ?? null) : null;
}

/** 页面上的黄字：只有"不是直播轮"才渲染（LocalChatPage 的 `<Show when={!isLiveTurn() && …}>`） */
function shownEndNote(store: { live: boolean; trees: BlockNode[] }): string | null {
    const tail = store.trees[store.trees.length - 1];
    if (!tail) return null;
    if (liveTurnId(store) === tail.id) return null; // 直播中 ⇒ 压掉
    return turnEndNote(tail);
}

beforeEach(() => {
    feedSeq = 0;
    rafQueue.length = 0;
    h.historyWindow.mockReset();
    h.historyOlder.mockReset();
    h.opsWatermark.mockReset();
    h.opsWatch.mockReset();
    h.running.mockReset();
    h.usage.mockReset();
    h.steerList.mockReset();
    h.addToast.mockReset();
    h.sub = null;
    // 首载：空会话（本用例只关心一轮实时流）
    h.historyWindow.mockResolvedValue({ ops: [], cursor: "c0", hasMore: false });
    h.opsWatermark.mockResolvedValue({ epoch: 0, seq: 0 });
    h.usage.mockResolvedValue([]);
    h.steerList.mockResolvedValue([]);
    h.running.mockResolvedValue({ active: [] });
    h.opsWatch.mockImplementation(async () => {
        const sub = makeSub();
        h.sub = sub as unknown as { push: (f: unknown) => void };
        sub.push({ kind: "hello", epoch: 0, seq: feedSeq });
        return sub;
    });
});

describe("A. 轮次 start 帧到达、真值（agent.local.running）还没回来", () => {
    it("必须立刻算直播中（该轮不许被判成 interrupted / 不许闪黄字）", async () => {
        const store = await freshStore();
        // 真值查询**永不返回** —— 这就是"发消息一刹那"那个窗口：op 已经到了，RPC 还在路上
        h.running.mockReturnValue(new Promise(() => {}));
        await store.open(URI);
        expect(store.live).toBe(false); // 还没有轮次

        // room 驱动的那一轮：main 落了 turn start，经 op 订阅送达（**不带** sending）
        pushBatch([{ op: "start", id: "t1", kind: "turn" }]);
        await settle();

        expect(store.live).toBe(true);
        expect(liveTurnId(store)).toBe("t1");
        expect(shownEndNote(store)).toBeNull(); // ← 现状（修前）这里是「⚠ 本轮未完成（流中断/崩溃恢复）」
    });

    it("早于这一轮的在途真值（答『不在跑』）晚到，不许把刚起的轮次压回死", async () => {
        const store = await freshStore();
        const stale = deferred<{ active: Array<{ taskUri: string }> }>();
        let n = 0;
        h.running.mockImplementation(() => {
            n += 1;
            return n === 1 ? stale.promise : new Promise(() => {}); // 第 1 次（open 那次）是旧答案
        });
        await store.open(URI);
        stale.resolve({ active: [] }); // 还没放行…
        pushBatch([{ op: "start", id: "t1", kind: "turn" }]);
        await settle();
        expect(store.live).toBe(true);

        await settle(); // 旧答案（发问时刻早于本轮 start）此刻才落地：必须被丢弃
        expect(store.live).toBe(true);
        expect(liveTurnId(store)).toBe("t1");
    });
});

describe("B. 短轮收敛（stop 边界）：不许滞留成永久 live", () => {
    it("start→stop 一瞬间：stop 边界立刻复位，不等真值往返", async () => {
        const store = await freshStore();
        h.running.mockReturnValue(new Promise(() => {})); // 真值一直不回来（最坏情形）
        await store.open(URI);

        pushBatch([{ op: "start", id: "t1", kind: "turn" }]);
        await settle();
        expect(store.live).toBe(true); // 乐观置位

        pushBatch([
            { op: "patch", id: "t1", fields: { endReason: { type: "completed", data: {} } } },
            { op: "stop", id: "t1" },
        ]);
        await settle();
        expect(store.live).toBe(false); // 收敛（若滞留 ⇒ 输入框永久"生成中"）
        expect(liveTurnId(store)).toBeNull();
        expect(shownEndNote(store)).toBeNull(); // completed：本来就没话说
    });

    it("补发/重放里的 start（该轮早已收尾）不许把死轮复活", async () => {
        const store = await freshStore();
        h.running.mockReturnValue(new Promise(() => {}));
        await store.open(URI);
        pushBatch([
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "t1_a", kind: "text", parent: "t1" },
            { op: "delta", id: "t1_a", fields: { content: "完" } },
            { op: "stop", id: "t1_a" },
            { op: "stop", id: "t1" },
        ]);
        await settle();
        expect(store.live).toBe(false);

        // 重放：同一个 turn id 的 start 再次送达（断线补发 / 日志重放）。块已 stopped ⇒ 不许再认活。
        pushBatch([{ op: "start", id: "t1", kind: "turn" }]);
        await settle();
        expect(store.live).toBe(false);
        expect(liveTurnId(store)).toBeNull();
    });

    it("真值仍可把本地抬回（队列下一轮/别人在跑）—— 乐观置位不是新判据", async () => {
        const store = await freshStore();
        h.running.mockReturnValue(new Promise(() => {}));
        await store.open(URI);
        pushBatch([{ op: "start", id: "t1", kind: "turn" }, { op: "stop", id: "t1" }]);
        await settle();
        expect(store.live).toBe(false);

        // main 说是活跃的（别人发起的轮次 / 队列下一轮已起跑）→ 立刻以真值为准
        h.running.mockResolvedValue({ active: [{ taskUri: URI }] });
        await store.refreshActive(URI);
        expect(store.live).toBe(true);
    });
});

describe("C. 真断流（同一条判据的另一侧）：黄字仍然必须显示", () => {
    it("历史轮：无 stop、无 endReason、main 也不再持它 ⇒ 仍然显示「本轮未完成」", async () => {
        const store = await freshStore();
        // 冷读：盘上就是这么一条"丢了收尾"的轮次（无 stop、无 endReason）
        h.historyWindow.mockResolvedValue({
            ops: [
                { op: "start", id: "t0", kind: "turn" },
                { op: "start", id: "t0_a", kind: "text", parent: "t0" },
                { op: "delta", id: "t0_a", fields: { content: "说到一半" } },
            ] as Op[],
            cursor: "c0",
            hasMore: false,
        });
        h.running.mockResolvedValue({ active: [] }); // main 明确：没有轮次在跑
        await store.open(URI);
        await settle();

        expect(store.live).toBe(false);
        expect(shownEndNote(store)).toBe("本轮未完成（流中断/崩溃恢复）");
    });

    it("活会话：start 帧到了、但这一轮再也没有 stop（真断了）⇒ 真值回落后黄字照样出", async () => {
        const store = await freshStore();
        h.running.mockReturnValue(new Promise(() => {})); // 先当真值还没回来
        await store.open(URI);
        pushBatch([{ op: "start", id: "t1", kind: "turn" }]);
        await settle();
        expect(shownEndNote(store)).toBeNull(); // 乐观置位：先认它活着（不许误报）

        // 之后 main 明确回"这个 task 没有活跃轮次"（进程被杀后的 closer / 收尾早了但没有 stop 帧）
        h.running.mockResolvedValue({ active: [] });
        await store.refreshActive(URI);
        await settle();

        expect(store.live).toBe(false);
        expect(shownEndNote(store)).toBe("本轮未完成（流中断/崩溃恢复）");
    });
});
