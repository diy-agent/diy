// tests/core/local-chat-store-full-text.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ##93 D 的「按需读全文」（口径 = 任务 body 的「待决策 ②」：不新增 main 接口，
//    用 historyOlder / historyWindow 把该块所在的**段**重新取回来，用**无硬顶**的 store 重折）
//
// 判据：
//   ① 渲染端 store 里那块是**被裁过的**（显示值只有头尾两段 + 一行标注）；
//   ② `loadFullBlockFields` 拿回来的必须是**完整**字段值（逐字等于原文，不再是裁过的）；
//   ③ 段不是末段时走 `historyOlder(下一段游标)`，末段走 `historyWindow(本段游标)` —— 取错段 = 拿不到块；
//   ④ 查不到就如实返回 `null`（绝不返回裁过的值冒充全文）。
// ═══════════════════════════════════════════════════════════════

import { beforeEach, describe, expect, it, vi } from "vitest";
import { RENDER_TEXT_CAP, type Op } from "../../src/main/services/local-blocks";
import { installRpc, stubPersonaLoad, stubToasts } from "../helpers/renderer-deps";

const h = vi.hoisted(() => ({
    historyWindow: vi.fn(),
    historyOlder: vi.fn(),
    opsWatermark: vi.fn(),
    opsWatch: vi.fn(),
    running: vi.fn(),
    usage: vi.fn(),
    steerList: vi.fn(),
}));

const URI = "projects/1/tasks/93";
const BIG = "x".repeat(RENDER_TEXT_CAP.head + RENDER_TEXT_CAP.tail + 5_000);

/** 一轮 + 一个超顶的 text 子块（id 固定，便于断言） */
const bigTurn = (): Op[] => [
    { op: "start", id: "t1", kind: "turn", meta: { model: "m" } },
    { op: "start", id: "t1_b", kind: "text", parent: "t1" },
    { op: "delta", id: "t1_b", fields: { content: BIG } },
    { op: "stop", id: "t1_b" },
    { op: "stop", id: "t1" },
];

const win = (ops: Op[], cursor: string, hasMore: boolean, stale = false) => ({ ops, cursor, hasMore, stale });

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
    await stubToasts(() => {});
    await stubPersonaLoad();
    return await import("../../src/renderer_solid/store/localChatStore");
}

beforeEach(() => {
    for (const f of [h.historyWindow, h.historyOlder, h.running, h.opsWatermark, h.opsWatch, h.usage, h.steerList]) {
        f.mockReset();
    }
    h.opsWatermark.mockResolvedValue({ epoch: 0, seq: 0 });
    h.opsWatch.mockResolvedValue({
        async *[Symbol.asyncIterator]() {
            yield { kind: "hello", epoch: 0, seq: 0 };
            await new Promise<void>(() => {});
        },
    });
    h.usage.mockResolvedValue([]);
    h.steerList.mockResolvedValue([]);
    h.running.mockResolvedValue({ active: [] });
});

describe("按需取全文（##93 D）", () => {
    it("渲染端那块被裁过，loadFullBlockFields 拿回逐字全文（末段走 historyWindow）", async () => {
        const m = await freshStore();
        h.historyWindow.mockResolvedValueOnce(win(bigTurn(), "c1", false));
        await m.localChatStore.open(URI);
        // ① 渲染端看到的是裁过的（头尾两段 + 标注）
        const shown = m.localChatStore.trees.find((t) => t.id === "t1")!.children.find((c) => c.id === "t1_b")!;
        expect(String(shown.attrs.content).length).toBeLessThan(200 * 1024);
        expect(String(shown.attrs.content)).toContain("已省略");
        // ② 载入全文：main 会给同一段（`stale:false`），重折时**不带硬顶**
        h.historyWindow.mockResolvedValueOnce(win(bigTurn(), "c1", false));
        const fields = await m.loadFullBlockFields("t1_b");
        expect(fields).not.toBeNull();
        expect(fields!.content).toBe(BIG);
        // ③ 末段没有"下一段" ⇒ 走 historyWindow（带本段游标），不走 historyOlder
        expect(h.historyOlder).not.toHaveBeenCalled();
        expect(h.historyWindow).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "c1" }));
    });

    it("不是末段时走 historyOlder(下一段游标) —— 取到的段必须覆盖该块", async () => {
        const m = await freshStore();
        // 首载 = 尾部窗口 [t2]；再上滚补出 [t1]（t1 现在**不是末段**，后面还有个 t2 段）
        const t2: Op[] = [
            { op: "start", id: "t2", kind: "turn", meta: {} },
            { op: "stop", id: "t2" },
        ];
        h.historyWindow.mockResolvedValueOnce(win(t2, "c2", true));
        await m.localChatStore.open(URI);
        h.historyOlder.mockResolvedValueOnce(win(bigTurn(), "c0", true));
        await m.localChatStore.loadOlder(URI);
        // 点 t1 段里那块 ⇒ 取 [c0, c2) 这一段，游标 = 下一段（t2 段）的起点
        h.historyOlder.mockResolvedValueOnce(win(bigTurn(), "c0", true));
        const fields = await m.loadFullBlockFields("t1_b");
        expect(fields!.content).toBe(BIG);
        expect(h.historyOlder).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "c2" }));
        // 末段那条路没被走：historyWindow 只在首载时调过一次
        expect(h.historyWindow).toHaveBeenCalledTimes(1);
    });

    it("段里找不到该块 ⇒ 如实返回 null（不拿裁过的值冒充全文）", async () => {
        const m = await freshStore();
        h.historyWindow.mockResolvedValueOnce(win(bigTurn(), "c1", false));
        await m.localChatStore.open(URI);
        // 重取回的段里没有这个 id（模拟日志被改写 / 块已被新帧替换）
        h.historyWindow.mockResolvedValueOnce(win(bigTurn().filter((o) => o.id !== "t1_b"), "c1", false));
        expect(await m.loadFullBlockFields("t1_b")).toBeNull();
    });
});
