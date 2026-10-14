// tests/core/local-chat-store-single-channel.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 「块树只有一个 apply 通道」的**回归契约**（任务 ##327）
//
// 现场：main 侧**同一个 op 走两条路**送达 renderer ——
//   ① `opsFeed.publish` → `agent.local.opsWatch` 订阅（带行号 seq）；
//   ② `agent.local.chat` 的流（发起方专属，**不带 seq**，main 见 api-impl）。
// 两条都 apply 的后果**只**表现为「整段叠字」（用户实测：`大王大王，，先把现场先把现场看清楚看清楚。`）——
// 因为 `delta` 是**纯追加 / 无唯一键 / 不幂等**，而 start / patch / stop 恰好幂等，
// 所以块结构与消息条数全正常，光看结构查不出来。
//
// 本文件盯住两件事：
//   ① chat 流与 opsWatch **同时**送达同一批 op 时，文本只落地一次（逐字等于原文）；
//   ② 原先长在 send 流循环里的「插话已投递 → 重拉队列快照」判定，内收进 `applyOpsFrame` 后仍生效。
// ═══════════════════════════════════════════════════════════════

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockNode, Op } from "../../src/main/services/local-blocks";
import type { OpsFrame } from "../../src/shared/ops-frame";
import type { SteerItem } from "../../src/main/core/drafts";

/** 手动可控的异步帧流（opsWatch 的返回物） */
function makeSub() {
    const buf: OpsFrame[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    return {
        push(f: OpsFrame) {
            buf.push(f);
            wake?.();
        },
        async *[Symbol.asyncIterator](): AsyncGenerator<OpsFrame> {
            for (;;) {
                while (buf.length > 0) yield buf.shift()!;
                if (closed) return;
                await new Promise<void>((r) => {
                    wake = r;
                });
                wake = null;
            }
        },
    };
}

const h = vi.hoisted(() => ({
    historyWindow: vi.fn(),
    historyOlder: vi.fn(),
    opsWatermark: vi.fn(),
    opsWatch: vi.fn(),
    running: vi.fn(),
    usage: vi.fn(),
    steerList: vi.fn(),
    chat: vi.fn(),
    /** 订阅侧句柄（opsWatch 被调用后填上） */
    sub: null as null | { push: (f: unknown) => void },
    /** 下一次 chat 调用要"产出"的 op（模拟 main 的双送） */
    chatOps: [] as Op[],
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
                    chat: h.chat,
                    steer: { list: h.steerList },
                },
            },
        },
    },
}));
vi.mock("../../src/renderer_solid/store/personaStore", () => ({ personaStore: { load: async () => {} } }));
vi.mock("../../src/renderer_solid/store/notificationStore", () => ({
    notificationStore: { addToast: () => {} },
}));

// node 环境没有 rAF，而 op 落地后的合帧刷新走它。替身必须**延后执行**、由 flushFrames() 手动跑：
// 若替身同步执行回调，`rafId = requestAnimationFrame(cb)` 里 cb 先置 null、赋值随后又写回非 null
// → 此后永远不再合帧（刷新静默消失）。
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

/** 盘上「下一行」的行号（模拟 main 的 opsFeed.seq：每个 op 一行，appliedSeq 即行号） */
let feedSeq = 0;

/**
 * 模拟 main 的**双送**：先 `opsFeed.publish`（推给订阅），再作为 chat 流 yield。
 * 顺序照 main：`opsSink` 落盘 + publish 在前，`api-impl` 的 yield 在后。
 */
function chatThroughBothChannels(ops: Op[]) {
    return async function* (): AsyncGenerator<Op> {
        for (const op of ops) {
            feedSeq += 1;
            h.sub!.push({ kind: "batch", epoch: 0, fromSeq: feedSeq, ops: [op] });
            yield op;
        }
    };
}

async function freshStore() {
    vi.resetModules();
    return (await import("../../src/renderer_solid/store/localChatStore")).localChatStore;
}

/** 让订阅循环把已推的帧跑完，并跑掉合帧回调 */
async function settle() {
    for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 0));
        while (rafQueue.length > 0) rafQueue.shift()!();
    }
}

/** 块树里所有非空文本（在 UI 上就是一个字一个字拼出来的内容） */
function texts(nodes: BlockNode[]): string[] {
    const out: string[] = [];
    const walk = (n: BlockNode) => {
        const c = n.attrs["content"];
        if (typeof c === "string" && c.length > 0) out.push(c);
        n.children.forEach(walk);
    };
    nodes.forEach(walk);
    return out;
}

const steerItem = (id: string): SteerItem => ({ id, text: "插话", mode: "next-turn", created: "" });

beforeEach(() => {
    feedSeq = 0;
    rafQueue.length = 0;
    h.historyWindow.mockReset();
    h.historyOlder.mockReset();
    h.running.mockReset();
    h.opsWatermark.mockReset();
    h.opsWatch.mockReset();
    h.usage.mockReset();
    h.steerList.mockReset();
    h.chat.mockReset();
    h.sub = null;
    h.chatOps = [];
    // 首载：空会话（本用例只关心一轮实时流）
    h.historyWindow.mockResolvedValue({ ops: [], cursor: "c0", hasMore: false });
    h.opsWatermark.mockResolvedValue({ epoch: 0, seq: 0 });
    h.usage.mockResolvedValue([]);
    h.steerList.mockResolvedValue([]);
    h.running.mockResolvedValue({ active: [] });
    h.opsWatch.mockImplementation(async () => {
        const sub = makeSub();
        h.sub = sub as unknown as { push: (f: unknown) => void };
        return sub;
    });
    h.chat.mockImplementation(async () => chatThroughBothChannels(h.chatOps)());
});

describe("chat 流与 opsWatch 双通道送达同一批 op", () => {
    it("只落地一次：文本逐字等于原文，不出现整段叠字", async () => {
        const store = await freshStore();
        await store.open(URI);
        expect(h.sub).not.toBeNull(); // 订阅必须已建立（唯一 apply 通道）

        // 一轮：一段被逐 token 追加的回复 —— 正是 ##305 现场那段
        h.chatOps = [
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "t1_a", kind: "text", parent: "t1" },
            { op: "delta", id: "t1_a", fields: { content: "大王" } },
            { op: "delta", id: "t1_a", fields: { content: "，" } },
            { op: "delta", id: "t1_a", fields: { content: "先把现场" } },
            { op: "delta", id: "t1_a", fields: { content: "看清楚" } },
            { op: "delta", id: "t1_a", fields: { content: "。" } },
            { op: "stop", id: "t1_a" },
            { op: "stop", id: "t1" },
        ];
        await store.send(URI, "先把现场看清楚");
        await settle();

        expect(texts(store.trees)).toEqual(["大王，先把现场看清楚。"]);
        expect(store.trees.filter((t) => t.tag === "turn").map((t) => t.id)).toEqual(["t1"]);
    });

    it("轮次边界 op 也只算一次（块不会变成两个）", async () => {
        const store = await freshStore();
        await store.open(URI);
        h.chatOps = [
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "t1_a", kind: "text", parent: "t1" },
            { op: "delta", id: "t1_a", fields: { content: "x" } },
            { op: "stop", id: "t1_a" },
            { op: "stop", id: "t1" },
        ];
        await store.send(URI, "hi");
        await settle();

        // 块结构幂等 ⇒ 叠字看不出来；这里量的正是"结构正常"那条：轮与块都不重复
        const turns = store.trees.filter((t) => t.tag === "turn");
        expect(turns).toHaveLength(1);
        expect(turns[0]!.children.filter((c) => c.tag === "text")).toHaveLength(1);
        expect(texts(store.trees)).toEqual(["x"]);
    });
});

describe("插话投递的队列刷新（判定内收进 applyOpsFrame）", () => {
    it("带 steer 标记的 user 块经订阅到达 → 立刻重拉队列快照", async () => {
        const store = await freshStore();
        h.steerList.mockResolvedValueOnce([steerItem("s1")]); // open 的那次拉到一条待投递
        await store.open(URI);
        await settle();
        expect(store.steers.map((s) => s.id)).toEqual(["s1"]);

        // 投递后队列为空（盘上已出队）；这一帧不经 chat 流，只能由订阅触发刷新
        h.steerList.mockResolvedValue([]);
        feedSeq += 1;
        h.sub!.push({
            kind: "batch",
            epoch: 0,
            fromSeq: feedSeq,
            ops: [
                { op: "start", id: "t1", kind: "turn" },
                { op: "start", id: "t1_u", kind: "text", parent: "t1", meta: { steer: true } },
                { op: "delta", id: "t1_u", fields: { content: "插话" } },
                { op: "stop", id: "t1_u" },
                { op: "stop", id: "t1" },
            ],
        });
        await settle();

        expect(store.steers).toEqual([]); // 横条必须下架：模型已经看见了
    });
});
