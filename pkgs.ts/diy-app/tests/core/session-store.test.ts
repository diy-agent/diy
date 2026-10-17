// tests/core/session-store.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 全局会话可见性 store 的**响应式契约**（##308 review3 P1-1 回归）
//
// 回归对象（真机实测，不是假想）：App 的「已读水位跟随」effect 在 **tracked 作用域**里调
// `sessionStore.markViewed()`，而 markViewed 内部又**读**了 `seen`（`new Map(seen())`）、
// 紧接着**写**它（`setSeen`）。Solid 的 effect 先 `cleanNode`（把 state 归零）再跑 fn，
// 于是这次写把**自己**重新入队 ⇒ effect → 读 seen → 写 seen → 再跑 …… 递归到栈溢出。
//
// 真机后果**不是**"界面难看"，而是**订阅本身死掉**：RangeError 从帧处理里抛出 → 被
// `connect()` 的 catch 当成"流断了" → `connection="down"` + 退避重连（[5] 要的"实时"直接失效），
// 且 `diy ui tab open …` 这类普通动作当场返回 `Maximum call stack size exceeded`。
// 注意：帧是**先 apply 后炸**的，所以只看 DOM（nav 角标 / 表行 chip）**看着是对的** ——
// 这正是它当初漏过验收的原因，故本用例断言的是"订阅是否还活着"，不是 DOM 文本。
//
// 为什么这样写：
//   · 用**真 store**（不是内联副本）+ 真 RPC 客户端 + 最小假 transport（只答 sessions/limits），
//     帧从订阅那条真路径喂进去 —— 判据（connection / 重连日志）全落在真代码上。
//   · ⚠️ `solid-js` 在 node 条件下解析到 **SSR 构建**（`createEffect` 不追踪依赖）⇒ 必须钉到
//     **客户端构建**，否则本回归会静默空跑（假绿）。
//   · 唯一被复刻的是 App.tsx 那条 effect 的**形态**（node 里挂不起 App）；被测对象是真
//     store 的方法与真订阅，复刻处已标注。
// ═══════════════════════════════════════════════════════════════

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryFrame, SessionEntry } from "../../src/shared/registry-frame";

// 钉死 solid 的**客户端**构建（理由见头注）。vitest 会把它作用于本文件整张模块图，
// 故 store 内部的 `createSignal` 与下面 harness 的 `createEffect` 是**同一份实现**。
vi.mock("solid-js", () => import("solid-js/dist/solid.js"));

// ── 最小假 transport：只应答本用例真会走的两个 RPC ──────────────────
// 形状照 `@diy/rpc` 的 EnvelopeTransport（send / on / onClose）；信封照 types.ts：
//   请求 {type:'call', id, method, params, stream?} · ack {type:'call', id, stream}
//   流数据 {type:'data', stream, value} · unary 结果 {type:'call', id, result}
interface Env {
    type: string;
    id?: number;
    method?: string;
    stream?: number;
    value?: unknown;
    result?: unknown;
}

const STREAM_ID = 7;
const sent: Env[] = [];
/** 假 transport 没答应答的调用（非空 = 被测代码新增了 RPC ⇒ 用例须显式跟进，别静默放过） */
const unhandled: string[] = [];
let sink: ((msg: Env) => void) | null = null;

const transport = {
    send(payload: unknown): void {
        const msg = payload as Env;
        sent.push(msg);
        if (msg.type !== "call" || msg.method == null) return; // cancel/data 等：本用例不关心
        if (msg.method === "diy.agent.local.sessions") {
            // 建流：ack 给 stream id；此后帧由测试**手动**喂（模拟"订阅一直开着、不主动 end"）
            queueMicrotask(() => sink?.({ type: "call", id: msg.id, stream: STREAM_ID }));
        } else if (msg.method === "diy.agent.local.limits") {
            queueMicrotask(() => sink?.({ type: "call", id: msg.id, result: { maxSteps: 200 } }));
        } else if (msg.method === "diy.agent.local.usage") {
            // 账本（`<key>.usage.jsonl`）：**答空数组** = "读到且为空"。
            // ##358 起水位钉的是 `max(注册表 turnCount, 账本唯一 turnId 数)`（`totalTurnsOf`）——
            // 账本没到货时水位**挂起不写**（宁可不写也不写个会撒谎的数），故本用例必须让它有个
            // 明确答案，否则断言的是"挂起"而不是"追平"。
            queueMicrotask(() => sink?.({ type: "call", id: msg.id, result: [] }));
        } else {
            unhandled.push(msg.method);
        }
    },
    on(handler: (msg: Env) => void): () => void {
        sink = handler;
        return () => {
            sink = null;
        };
    },
    onClose(): () => void {
        return () => {};
    },
};

(globalThis as { window?: unknown }).window = { transport };

/**
 * 已读水位落盘在 renderer `localStorage`（`diy_sessions_seen`，##358 的**临时实现**）——
 * 单测跑在 node 环境、没有它。不给桩的话 `loadSeen` 会打一条"读取已读水位失败"的
 * error（真实现没错，是环境缺件），而本文件恰恰断言"没有多余日志"⇒ 会红。
 * 桩只实现用到的那三个方法（get / set / remove），够水位读写与"清空重算"用。
 */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
};

const { sessionStore } = await import("../../src/renderer_solid/store/sessionStore");
const { createEffect, createRoot, createSignal } = await import("solid-js");

/** 一帧 = 一秒的让位（微任务 + 宏任务），足够让订阅循环把帧处理完 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function pushFrame(frame: RegistryFrame): void {
    sink?.({ type: "data", stream: STREAM_ID, value: frame });
}

function makeEntry(over: Partial<SessionEntry> = {}): SessionEntry {
    const at = new Date().toISOString();
    return {
        id: "local-projects_2_tasks_1",
        refs: [{ kind: "task", uri: "projects/2/tasks/1" }],
        turn: {
            turnId: "turn-1",
            steps: 5,
            tokens: 100,
            lastOpAt: at,
            startedAt: at,
            model: "mimo-v2.6-flash",
            state: "active",
        },
        queue: 0,
        viewers: 0,
        firstSeenAt: at,
        lastActivity: at,
        turnCount: 5,
        lastEndReason: null,
        totalSteps: 0,
        totalTokens: 0,
        ...over,
    };
}

interface ActiveTab {
    pageId: string;
    ctx: string | null;
}

/**
 * 复刻 App.tsx 的「已读水位跟随」effect（**本文件唯一复刻处**：node 里挂不起 App，
 * 而被测对象是**真 store** —— 读**真** table / 调**真** markViewed）。
 */
function mountFollowEffect(active: () => ActiveTab | undefined): { runs: () => number; dispose: () => void } {
    let runs = 0;
    const dispose = createRoot((d) => {
        createEffect(() => {
            const t = active();
            if (t?.pageId !== "task-run" || !t.ctx) return;
            // 读一次条目表 = 订阅注册表帧（帧到了本 effect 要重跑，把水位追到最新）
            if (sessionStore.entries.length === 0) return;
            runs++;
            sessionStore.markViewed(t.ctx);
        });
        return d;
    });
    return { runs: () => runs, dispose };
}

beforeEach(() => {
    sent.length = 0;
    unhandled.length = 0;
    sessionStore.stop();
});
afterEach(() => {
    sessionStore.stop();
    vi.restoreAllMocks();
});

describe("sessionStore —— 打开会话页不得把注册表订阅弄死（P1-1）", () => {
    it("激活的 task-run 会话在表里 → effect 调 markViewed 不自触发：订阅保持 live、无重连日志", async () => {
        const warns: unknown[][] = [];
        vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warns.push(a));

        const [active, setActive] = createSignal<ActiveTab | undefined>(undefined);
        const { runs, dispose } = mountFollowEffect(active);

        sessionStore.start();
        await settle();

        // 打开会话 tab：此刻表还是空的（effect 只早退，不算"看过"）
        setActive({ pageId: "task-run", ctx: "projects/2/tasks/1" });
        await settle();

        // 注册表推来条目（真订阅路径：transport → ChannelClientBinding → for await → applyFrame）
        pushFrame({ kind: "snapshot", entries: [makeEntry()] });
        await settle();

        // ① 订阅还活着 —— P1 时这里是 "down"（RangeError 被当成流断）
        expect(sessionStore.connection).toBe("live");
        // ② 没有"[sessions] 注册表订阅中断"这类日志（P1 时必有一条退避重连）
        expect(warns).toEqual([]);
        // ③ 水位追平到当前轮次（##358：1 轮 = 1 条未读消息；effect 干了它该干的事，只是没自循环）
        expect(sessionStore.seenTurnsOf("projects/2/tasks/1")).toBe(5);
        // ④ 跑的次数是**有界**的（自触发时这里会炸栈，根本到不了断言）。
        //    2 次 = ① active 切过来（表还空，早退）→ ② 注册表帧到、表非空 + 水位那一步。
        //    ##358 起水位要多读一份**账本**（`totalTurnsOf` 里 `usageLedgerStore.turnsOf` ⇒ 订阅
        //    它的 version），账本到货会**合法地**再跑一次 —— 那是依赖变更，不是"读 seen → 写 seen"
        //    的自触发。故上界放到 3（自触发是几十上百次起步，这个上界照样拦得住）。
        expect(runs()).toBeLessThanOrEqual(3);
        expect(sessionStore.entries).toHaveLength(1);
        // ⑤ 没碰别的 RPC（新增调用 = 本用例的假 transport 须跟进）
        expect(unhandled).toEqual([]);

        dispose();
    });

    it("水位跟随帧前进：新帧到达 → effect 重跑 → 水位追到新轮次（订阅没受影响）", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const [active] = createSignal<ActiveTab | undefined>({ pageId: "task-run", ctx: "projects/2/tasks/1" });
        const { runs, dispose } = mountFollowEffect(active);

        sessionStore.start();
        await settle();
        pushFrame({ kind: "snapshot", entries: [makeEntry()] });
        await settle();
        expect(sessionStore.seenTurnsOf("projects/2/tasks/1")).toBe(5);

        // 轮次前进到 9（同一条目 upsert）→ 水位应随帧追平
        const e = makeEntry();
        pushFrame({ kind: "upsert", entry: { ...e, turnCount: 9 } });
        await settle();

        expect(sessionStore.seenTurnsOf("projects/2/tasks/1")).toBe(9);
        expect(sessionStore.connection).toBe("live");
        // 快照一次 + 前进一次 + **账本到货一次**（##358：水位读账本 ⇒ 订阅它的 version；
        // 这条依赖变更会合法地再跑一次，见上一个用例 ④ 的说明）。上界拦的是自触发。
        expect(runs()).toBeLessThanOrEqual(3);
        dispose();
    });

    it("会话不在注册表里（本次启动没活动过）→ 不虚报未读、也不循环", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const [active] = createSignal<ActiveTab | undefined>({ pageId: "task-run", ctx: "projects/9/tasks/9" });
        const { runs, dispose } = mountFollowEffect(active);

        sessionStore.start();
        await settle();
        pushFrame({ kind: "snapshot", entries: [makeEntry()] });
        await settle();

        // 水位写的是**总轮次真值**（##358：注册表 ∪ 账本）。这条 uri 两头都没有 ⇒ 真值 = 0，
        // 于是水位落成 0（= "读到第 0 轮"）。
        // ⚠️ 0 与 null 的区别只在"有没有这条记录"，**可见结论相同**：未读 = 0（不虚报）。
        //（旧断言写 null 是"账本没到货 → 挂起不写"的副作用，不是契约。）
        expect(sessionStore.seenTurnsOf("projects/9/tasks/9")).toBe(0);
        expect(sessionStore.unreadTurnsOf("projects/9/tasks/9")).toBe(0);
        // effect 仍会因"表由空变非空"重跑一次（它订阅的是整张表，不是某一条）——
        // 这是有意的：水位判据只需"帧到了就追平当前在看的那条"。
        // + 账本到货那一次（见上两个用例：水位读账本 ⇒ 订阅它的 version）。上界拦自触发。
        expect(runs()).toBeLessThanOrEqual(3);
        expect(sessionStore.connection).toBe("live");
        dispose();
    });
});
