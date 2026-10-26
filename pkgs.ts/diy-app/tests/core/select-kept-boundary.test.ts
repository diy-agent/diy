import { describe, expect, it } from "vitest";
import {
    HEAD_KEEP_TOKENS,
    hasDropped,
    selectKeptBoundary,
    type BoundaryMessage,
} from "../../src/shared/context/select-kept-boundary";

/** 造一条消息（边界只关心 tokens 与工具配对） */
function m(tokens: number, kind?: string, callId?: string): BoundaryMessage {
    return { tokens, ...(kind ? { kind } : {}), ...(callId ? { callId } : {}) };
}

// 本文件是 `selectKeptBoundary` 的**唯一**判据测试：其他调用方（范例预览等）只测「有没有走这个函数」，
// 不许各自复制一份算法断言 —— 否则锁死两份实现。##432 落地后本文件随实现一起迁移。
describe("select-kept-boundary · 保留边界的唯一判据", () => {
    it("保头 = 600 token 硬编码", () => {
        expect(HEAD_KEEP_TOKENS).toBe(600);
    });

    it("保头：从第一条起装到 ≥ 600 token 为止", () => {
        // 250 × 3 = 750 ≥ 600 ⇒ 停在第三条（下标 2）
        const { headEnd } = selectKeptBoundary([m(250), m(250), m(250), m(250)], 0);
        expect(headEnd).toBe(2);
    });

    it("首个 user 永不被丢：单条就超过 600 token 时保头也含它", () => {
        const { headEnd } = selectKeptBoundary([m(5000), m(100)], 0);
        expect(headEnd).toBe(0);
    });

    it("上限 0 = 清零：尾部一条都不取（cut = 条数）", () => {
        const { headEnd, cut } = selectKeptBoundary([m(250), m(250), m(250), m(250), m(250)], 0);
        expect(headEnd).toBe(2);
        expect(cut).toBe(5);
    });

    it("从最后往前累加、**先判再加**：保留到上限的一半（RETAIN_RATIO），最后一步永远保留", () => {
        // 每条 250 token、上限 125 ⇒ 尾部额度 floor(62.5)−保头(750) ≤ 0 ⇒ 只留最后一条
        const { cut } = selectKeptBoundary([m(250), m(250), m(250), m(250), m(250)], 125);
        expect(cut).toBe(4);
    });

    it("上限足够大 ⇒ 保头与尾部接上（cut = headEnd + 1，一条不丢）", () => {
        const { headEnd, cut } = selectKeptBoundary([m(250), m(250), m(250)], 100_000);
        expect(cut).toBe(headEnd + 1);
    });

    it("tool 配对平衡：留了 result 就必须留下它的 call（切点往前挪）", () => {
        const msgs = [
            m(500), // 保头区（500 ≥ … 第一条先吃）
            m(125, "call", "c1"),
            m(125, "result", "c1"),
            m(125),
            m(125, "call", "c2"),
            m(125, "result", "c2"),
        ];
        // 上限 125 ⇒ 本来只切到最后一条 result(c2)；配平把 call(c2) 一起带进来
        const { cut } = selectKeptBoundary(msgs, 125);
        expect(cut).toBe(4);
        expect(msgs[cut].kind).toBe("call");
    });

    it("**多 tool-call 一条消息**：切点落在第二个 result 上也必须配平（review P0-1）", () => {
        // 一条 assistant 消息带 A、B 两个工具调用（并行调用是常态）
        const call2: BoundaryMessage = { tokens: 125, kind: "call", callIds: ["cA", "cB"] };
        // 末条是 result(cB) ⇒ 切点本来就落在它身上（保留区会从一条孤立 result 开始）；
        // 中间两段是正常历史（保证配平后确实丢了东西）
        const msgs = [m(600), m(300), m(300), call2, m(125, "result", "cA"), m(125, "result", "cB")];
        // 上限 125 ⇒ 本可只切到最后一条 result(cB)；配平必须前移到那条带 cB 的调用
        const { cut, kind, dropped } = selectKeptBoundary(msgs, 125);
        expect(msgs[cut]).toBe(call2); // 前移到**带 cA/cB 的那条调用**（不是停在孤立 result 上）
        expect(kind).toBe("drop");
        expect(dropped).toBe(2);
        // 保留区里不得出现「无主的 result」
        const kept = msgs.slice(cut);
        const keptIds = new Set(kept.flatMap((x) => x.callIds ?? (x.callId ? [x.callId] : [])));
        for (const x of kept) {
            if (x.kind === "result" && x.callId) expect(keptIds.has(x.callId)).toBe(true);
        }
    });

    it("显式状态：`cut === n`（全丢）也是 drop，不是 none（review P1-2）", () => {
        const full = selectKeptBoundary([m(250), m(250), m(250), m(250), m(250)], 0);
        expect(full.cut).toBe(5);
        expect(full.kind).toBe("drop");
        expect(full.dropped).toBe(2); // 保头 3 条之外全丢
        expect(hasDropped(full)).toBe(true);

        const none = selectKeptBoundary([m(250), m(250), m(250)], 100_000);
        expect(none.kind).toBe("none");
        expect(none.dropped).toBe(0);
        expect(hasDropped(none)).toBe(false);
    });

    it("limits 极小 ⇒ 只留保头 + 最新一组（不越界、不返回负 dropped）", () => {
        const msgs = Array.from({ length: 12 }, (_, i) => ({ tokens: 500, step: `s${i}` }) as BoundaryMessage);
        const { headEnd, cut, dropped, kind } = selectKeptBoundary(msgs, 1);
        expect(headEnd).toBe(1); // 500 + 500 ≥ 600
        expect(cut).toBe(11); // 最后一组永远保留
        expect(dropped).toBe(9);
        expect(kind).toBe("drop");
    });

    it("**保头侧配平**：保头停在 call 上时，它的 result 必须一起留在保头里（##444 现场）", () => {
        // 保头恰好装到第 2 条（assistant tool-call c1）为止，而它的 result 在丢弃段（cut 之前）
        const msgs = [m(50), m(50, "call", "c1"), m(50, "result", "c1"), m(50), m(50)];
        const { headEnd, cut, dropped } = selectKeptBoundary(msgs, 10, { headTokens: 100 });
        // 不配平的话 headEnd === 1、第 2 条 result 被压掉 ⇒ 投递里 c1 永远等不到结果（SDK 报 missing）
        expect(headEnd).toBe(2);
        expect(msgs[headEnd].kind).toBe("result");
        expect(msgs[headEnd].callId).toBe(msgs[1].callId);
        expect(cut).toBe(4); // 切点不动（只延长保头）
        expect(dropped).toBe(1);
    });

    // ── ##445 根因：保头 / 保留区的 call 必须都拿得到 result（否则 SDK 抛
    //    AI_MissingToolResultsError，整轮死；不是降级、不是 provider 400）──

    /** 保留区 = `[0, headEnd] ∪ [cut, n)`；判据 = 每条 call 的 getResult 都在保留区里 */
    function orphanCalls(msgs: readonly BoundaryMessage[], headEnd: number, cut: number): string[] {
        const kept = (i: number): boolean => i <= headEnd || i >= cut;
        const out: string[] = [];
        for (let i = 0; i < msgs.length; i++) {
            const ids = msgs[i]!.kind === "call" ? idsOfMsg(msgs[i]!) : [];
            if (ids.length === 0) continue;
            for (const id of ids) {
                // 该 id 的全部 result 下标
                const results = msgs.map((mm, j) => (mm.kind === "result" && idsOfMsg(mm).includes(id) ? j : -1)).filter((j) => j >= 0);
                if (results.length === 0) continue; // 这条 call 本来就没 result（另一类问题，A 兜底管）
                const anyKept = results.some((j) => kept(j));
                if (!anyKept && kept(i)) out.push(id);
            }
        }
        return out;
    }
    const idsOfMsg = (mm: BoundaryMessage): string[] => mm.callIds ?? (mm.callId ? [mm.callId] : []);

    it("**复现（##445 body）**：保头正好停在 assistant(tool-call) 上 ⇒ result 必须一并进保头", () => {
        // body 里的 5 条：user(400) / assistant(call A, 300) / tool(result A, 200) / text / text
        const msgs = [m(400), m(300, "call", "A"), m(200, "result", "A"), m(2000), m(2000)];
        const { headEnd, cut } = selectKeptBoundary(msgs, 4000, { headTokens: 600, retainRatio: 0.25 });
        // 修前：headEnd === 1（保头停在 call A 上）、cut === 4 ⇒ A 孤立
        expect(msgs[headEnd]!.kind).toBe("result"); // 保头末尾是 result A
        expect(orphanCalls(msgs, headEnd, cut)).toEqual([]);
    });

    it("**多 call 一条消息 + cut 落在第二个 result 上** ⇒ 第一个 result 也必须进保留区", () => {
        const msgs = [
            m(600), // 保头（一条就够 600）
            m(100), // 丢弃区
            { tokens: 100, kind: "call", callIds: ["cA", "cB"] } as BoundaryMessage,
            m(100, "result", "cA"),
            m(100, "result", "cB"),
            m(100), // 最后一步（永远保留）
        ];
        // 额度 = floor(1000 × 0.85) − 600 = 250 ⇒ 先判再加：尾部本来只装得下 result cB（下标 4）
        // ⇒ 切点初值 4。修前的 `balanceCut` 只把 call（下标 2，带 cA+cB）前移进来，
        // 而 result cA 在下标 3 仍留在**丢弃区** ⇒ cA 孤立（##445 根因第二处）。
        const { headEnd, cut } = selectKeptBoundary(msgs, 1000, { headTokens: 600, retainRatio: 0.85 });
        expect(cut).toBe(2); // 修后：切点一路前移到那条 assistant —— cA / cB 的 result 都在保留区
        expect(orphanCalls(msgs, headEnd, cut)).toEqual([]);
    });

    it("**性质测试**：随机 500 组序列 × 随机 budget / headTokens ⇒ 恒无孤立 call", () => {
        // 线性同余伪随机（可复现；不引依赖）
        let seed = 20261027;
        const rnd = (n: number): number => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed % n;
        };
        for (let round = 0; round < 500; round++) {
            const len = 2 + rnd(24);
            const msgs: BoundaryMessage[] = [];
            let open: string[] = []; // 尚未出 result 的 call id
            for (let i = 0; i < len; i++) {
                const pick = rnd(10);
                if (open.length > 0 && pick < 5) {
                    // 出一条 result（可能一次一条）
                    const id = open.shift()!;
                    msgs.push(m(1 + rnd(300), "result", id));
                } else if (pick < 9) {
                    // 一条带 1~3 个 call 的 assistant
                    const ids: string[] = [];
                    const k = 1 + rnd(3);
                    for (let j = 0; j < k; j++) ids.push(`c${round}_${i}_${j}`);
                    open.push(...ids);
                    msgs.push({ tokens: 1 + rnd(300), kind: "call", callIds: ids });
                } else {
                    msgs.push(m(1 + rnd(300)));
                }
            }
            // 收尾：把所有 result 补齐（call 全部有 result，才谈得上「孤立」）
            for (const id of open) msgs.push(m(1 + rnd(300), "result", id));
            const budget = rnd(4000);
            const headTokens = 1 + rnd(700);
            const { headEnd, cut } = selectKeptBoundary(msgs, budget, { headTokens, retainRatio: 0.1 + rnd(90) / 100 });
            const orphans = orphanCalls(msgs, headEnd, cut);
            if (orphans.length > 0) {
                // 打印可复现的最小现场
                console.error("孤立 call:", orphans, JSON.stringify({ budget, headTokens, headEnd, cut, msgs }));
            }
            expect(orphans, `round ${round}`).toEqual([]);
        }
    });

    it("配平不会越过保头（切点至少停在 headEnd + 1）", () => {
        const msgs = [m(1000), m(50, "call", "c1"), m(50, "result", "c1")];
        const { headEnd, cut } = selectKeptBoundary(msgs, 10);
        expect(headEnd).toBe(0);
        expect(cut).toBeGreaterThanOrEqual(headEnd + 1);
    });
});
