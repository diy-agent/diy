// tests/core/local-chat-store-paging.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 分页在渲染端的**失效契约**（任务 ##293，review1 R3）
//
// main 的 `HistoryWindow.stale` = 「你给的游标失效了，这一份是**全量**」。渲染端两个消费端
// （轮末重放 `doReload` / 上滚补段 `loadOlder`）都必须按「**整树重置**」处理。
//
// 为什么不能只靠 `mergeWindow` 的**前缀守卫**兜：守卫判的是"末段轮次序列是新窗口的前缀"，
// 而**被覆盖写的全量**只要与末段轮次 id 巧合相容（同会话重写 / 同 id 重放），守卫就放行 ——
// 于是那些属于**旧日志**的更早段被静默留在树里，用户看到的是两份不同来源的历史缝在一起。
// 契约归契约，巧合不算数。
// ═══════════════════════════════════════════════════════════════

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Op } from "../../src/main/services/local-blocks";
import { installRpc, stubPersonaLoad, stubToasts } from "../helpers/renderer-deps";

const h = vi.hoisted(() => ({
    historyWindow: vi.fn(),
    historyOlder: vi.fn(),
    // ##307：open() 现在还要取水位 + 建 op 增量订阅；本用例只关心分页，给空流即可
    opsWatermark: vi.fn(),
    opsWatch: vi.fn(),
    running: vi.fn(),
    usage: vi.fn(),
    steerList: vi.fn(),
    toasts: [] as Array<{ type: string; message: string }>,
}));

// 人物清单与本用例无关，切断它到 taskStore / task-edit 的引用链

const URI = "projects/1/tasks/1";

/** 一轮（含一个 text 子块）—— 分页只按**轮 `start`** 切，子块是陪衬 */
const turn = (id: string): Op[] => [
    { op: "start", id, kind: "turn", meta: { model: "m" } },
    { op: "start", id: `${id}_b`, kind: "text", parent: id },
    { op: "delta", id: `${id}_b`, fields: { content: "x" } },
    { op: "stop", id: `${id}_b` },
    { op: "stop", id },
];

/** 一份窗口（轮次 + 游标 + hasMore + stale） */
const win = (ids: string[], cursor: string, hasMore: boolean, stale = false) => ({
    ops: ids.flatMap(turn),
    cursor,
    hasMore,
    stale,
});

/** 每个用例一份全新 store 单例；依赖走显式注入（先 resetModules 再注入，见 helpers）。 */
async function freshStore() {
    vi.resetModules();
    await installRpc({
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
    });
    await stubToasts((type, message) => void h.toasts.push({ type: type as string, message: message as string }));
    await stubPersonaLoad();
    return (await import("../../src/renderer_solid/store/localChatStore")).localChatStore;
}

/** 已装载的轮次（自下而上：段是升序拼的，与 UI 的渲染序一致） */
const loadedTurns = (store: { trees: Array<{ tag: string; id: string }> }): string[] =>
    store.trees.filter((t) => t.tag === "turn").map((t) => t.id);

/** 走一次「活跃 → 不活跃」的下降沿触发轮末重放（`doReload` 的唯一入口） */
async function turnEndReload(store: { refreshActive: (u: string) => Promise<void> }) {
    h.running.mockResolvedValue({ active: [{ taskUri: URI }] });
    await store.refreshActive(URI);
    h.running.mockResolvedValue({ active: [] });
    await store.refreshActive(URI);
}

beforeEach(() => {
    h.historyWindow.mockReset();
    h.historyOlder.mockReset();
    h.running.mockReset();
    h.opsWatermark.mockReset();
    h.opsWatch.mockReset();
    h.usage.mockReset();
    h.steerList.mockReset();
    h.toasts.length = 0;
    h.opsWatermark.mockResolvedValue({ epoch: 0, seq: 0 });
    // ⚠️ 必须给一条**永远连着**的空流（不送帧，也不收尾）：main 的 subscribe 不会自己结束
    //（见 ops-feed：它只等帧 / 被客户端 abort）。给"立刻正常收尾"的空流等于模拟"main 把订阅关了"
    // —— 那按 ##327 R1 是**故障**（会出声 + 退避重订），而本用例量的是分页/重放，不该被假订阅干扰。
    h.opsWatch.mockResolvedValue({
        async *[Symbol.asyncIterator]() {
            yield { kind: "hello", epoch: 0, seq: 0 }; // main 的 subscribe 首帧恒为 hello
            await new Promise<void>(() => {}); // 然后一直连着：不送帧，也不收尾
        },
    });
    h.usage.mockResolvedValue([]);
    h.steerList.mockResolvedValue([]);
    h.running.mockResolvedValue({ active: [] });
});

describe("轮末重放（doReload）遇上失效游标", () => {
    it("main 报 stale 且全量与末段 id 巧合相容 ⇒ 仍必须整树重置（不许缝两份历史）", async () => {
        const store = await freshStore();
        // 首载：尾部窗口 [t1,t2]，前面还有更早的
        h.historyWindow.mockResolvedValueOnce(win(["t1", "t2"], "c1", true));
        await store.open(URI);
        // 上滚补一段：现在树 = [t0][t1,t2]（两段、两个来源时刻）
        h.historyOlder.mockResolvedValueOnce(win(["t0"], "c0", true));
        await store.loadOlder(URI);
        expect(loadedTurns(store)).toEqual(["t0", "t1", "t2"]);
        expect(store.hasOlder).toBe(true);

        // 日志被覆盖写：main 退全量并报 stale。**全量的轮次恰好以末段为前缀**
        // （同会话 / 同 id 重放）—— 前缀守卫在这一刻是放行的，只有认 stale 才能重置。
        h.historyWindow.mockResolvedValueOnce(win(["t1", "t2", "t3"], "c1b", false, true));
        await turnEndReload(store);

        // t0 属于**被覆盖写掉的旧日志**，必须消失；hasMore 必须跟着全量走（前面没东西了）
        expect(loadedTurns(store)).toEqual(["t1", "t2", "t3"]);
        expect(store.hasOlder).toBe(false);
        expect(h.toasts.map((t) => t.type)).toEqual(["info"]); // 重置必须出声
        expect(h.toasts[0]!.message).toContain("日志已被改写");
    });

    it("正常轮末重放（stale=false）仍是增量并入：不误重置、不动 hasMore", async () => {
        const store = await freshStore();
        h.historyWindow.mockResolvedValueOnce(win(["t1", "t2"], "c1", true));
        await store.open(URI);
        h.historyOlder.mockResolvedValueOnce(win(["t0"], "c0", true));
        await store.loadOlder(URI);

        // 末段延长（起点固定）：前缀成立 ⇒ 只加一轮
        h.historyWindow.mockResolvedValueOnce(win(["t1", "t2", "t3"], "c1", false));
        await turnEndReload(store);

        expect(loadedTurns(store)).toEqual(["t0", "t1", "t2", "t3"]);
        // ⚠️ hasMore 说的是「**最老**段之前还有没有轮」：单段时才等于本窗口的 hasMore。
        // 这里是两段（t0 段在前）⇒ 不能被末段的 hasMore=false 覆盖。
        expect(store.hasOlder).toBe(true);
        expect(h.toasts).toEqual([]); // 常规路径不该惊动用户
    });

    it("stale 退全量后必须丢弃游标：下一轮末重放要重新按预算 seek，不许粘住全量游标", async () => {
        const store = await freshStore();
        h.historyWindow.mockResolvedValueOnce(win(["t1", "t2"], "c1", true));
        await store.open(URI);

        // 日志被清空 / 覆盖写：main 退**全量**、游标 = 全量游标（at:0）。它是个**合法轮首**，
        // 回传下去 main 会照收 ⇒ 此后每轮末都退全量（== 把 R9 想消灭的"整量回包"贴回来）。
        h.historyWindow.mockResolvedValueOnce(win(["t1", "t2", "t3"], "c-at0", false, true));
        await turnEndReload(store);

        // 下一轮末重放：必须**不带游标**（重新按预算 seek），而不是把 at:0 粘住回传
        h.historyWindow.mockResolvedValueOnce(win(["t1", "t2", "t3"], "c-new", false));
        await turnEndReload(store);
        const req = h.historyWindow.mock.calls.at(-1)![0];
        expect(req.cursor).toBeUndefined();
        // 且**必须带预算**：无游标却不带预算 ⇒ main 认为预算非法、照样退全量，bug 原样复发
        // （seekWindowStart 对 !(budget > 0) 直接退全量）。只守 cursor 会漏掉这半个条件（R3）。
        expect(req.budgetBytes).toBe(4 * 1024 * 1024);
    });
});

describe("上滚补段（loadOlder）遇上失效游标", () => {
    it("main 报 stale ⇒ 重置为这一段 + 出声，且返回 false（重建不是前插，不该做位置补偿）", async () => {
        const store = await freshStore();
        h.historyWindow.mockResolvedValueOnce(win(["t1", "t2"], "c1", true));
        await store.open(URI);

        h.historyOlder.mockResolvedValueOnce(win(["t1", "t2"], "c1", true, true));
        const inserted = await store.loadOlder(URI);

        expect(inserted).toBe(false);
        expect(loadedTurns(store)).toEqual(["t1", "t2"]); // 重置成单段（没有缝进两份）
        expect(h.toasts.map((t) => t.type)).toEqual(["info"]);

        // R4：stale 重置还须**丢弃末段游标** ⇒ 随后一次轮末重放的请求 cursor 必须为 undefined。
        // 否则这半修补可静默回退：下一轮回传全量游标，每次上滚/收尾又退全量。
        h.historyWindow.mockResolvedValueOnce(win(["t1", "t2"], "c1", false));
        await turnEndReload(store);
        expect(h.historyWindow.mock.calls.at(-1)![0].cursor).toBeUndefined();
    });

    it("两段轮次重叠（防线）⇒ 同样重置 + 出声，不缝", async () => {
        const store = await freshStore();
        h.historyWindow.mockResolvedValueOnce(win(["t1", "t2"], "c1", true));
        await store.open(URI);

        // stale 缺席也要兜住：与已有段相交说明 main 给的不是"更早一段"
        h.historyOlder.mockResolvedValueOnce(win(["t2", "t3"], "cx", false));
        const inserted = await store.loadOlder(URI);

        expect(inserted).toBe(false);
        expect(loadedTurns(store)).toEqual(["t2", "t3"]);
        expect(h.toasts.map((t) => t.type)).toEqual(["info"]);
    });
});
