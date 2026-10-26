import { describe, expect, it } from "vitest";
import { RETAIN_RATIO, hasDropped, selectKeptBoundary, type BoundaryMessage } from "../../src/shared/context/select-kept-boundary";

/** 造一条消息：`user` = 轮首/插话（切点只许落在这里） */
const u = (tokens: number): BoundaryMessage => ({ tokens, user: true });
const a = (tokens: number): BoundaryMessage => ({ tokens });
/** 一轮 = 一条 user + 若干 assistant/工具消息 */
const turn = (userTokens: number, restTokens: number[]): BoundaryMessage[] => [u(userTokens), ...restTokens.map(a)];

// 本文件是压缩切点判据的**唯一**断言处（##442：向 dsh 看齐后的极简算法）。
// 其他调用方（范例预览等）只测「有没有走这个函数」，不许各自复制一份算法断言。
describe("select-kept-boundary · 压缩切点（##442 极简算法）", () => {
    it("保留比例 = 0.16（dsh 同值）", () => {
        expect(RETAIN_RATIO).toBe(0.16);
    });

    it("三档窗口的保留量：128k→20k、256k→41k、1M→160k", () => {
        const at = (w: number) => Math.floor(w * RETAIN_RATIO);
        expect(at(128_000)).toBe(20_480);
        expect(at(256_000)).toBe(40_960);
        expect(at(1_000_000)).toBe(160_000);
    });

    it("从最后一条往前累加，装到 ≥ 保留量为止 —— cut 落在那一轮的轮首", () => {
        // 10 轮 × (1 user 100 + 3 assistant 100) = 每条 100
        const msgs = Array.from({ length: 10 }, () => turn(100, [100, 100, 100])).flat();
        // 保留量 800 ⇒ 从尾往前 8 条 = 2 轮；第 8 条（下标 32）是轮首 user ⇒ cut = 32
        const b = selectKeptBoundary(msgs, 800, 100_000);
        expect(b.kind).toBe("drop");
        expect(b.cut).toBe(32);
        expect(msgs[b.cut]!.user).toBe(true);
        expect(b.retainedTokens).toBe(800);
    });

    it("切点必落在 user 上：累加停在 assistant/tool 上也往前挪到轮首（配对靠结构保证）", () => {
        // 一轮：user 100 + assistant(call) 100 + tool-result 100
        const msgs = [...turn(100, [100, 100]), ...turn(100, [100, 100])];
        // 保留量 150 ⇒ 从尾累加：最后一条(tool 100) → 再一条(assistant 100)=200 ≥ 150 ⇒ i 指向 assistant
        const b = selectKeptBoundary(msgs, 150, 100_000);
        // assistant 不是合法切点 ⇒ 往前挪到它前面那条 user（下标 3）
        expect(b.cut).toBe(3);
        expect(msgs[b.cut]!.user).toBe(true);
        // 保留段 = user(3) + assistant(4) + tool(5)：call 与 result 同在一段
        expect(b.retainedTokens).toBe(300);
    });

    it("整段没有 user 边界 ⇒ 不压（找不到合法切点，绝不硬切）", () => {
        const b = selectKeptBoundary([a(100), a(100), a(100)], 100, 100_000);
        expect(hasDropped(b)).toBe(false);
    });

    it("切点落在第一条 ⇒ 没有可丢的 ⇒ 不压", () => {
        const msgs = [u(100), a(100)];
        const b = selectKeptBoundary(msgs, 50, 100_000);
        expect(hasDropped(b)).toBe(false);
    });

    it("压完仍超触发线 ⇒ 不压（空转判据：尾部一坨巨型工具结果时不硬压）", () => {
        // 每轮 1 条 user 100 + 1 条巨型结果 10_000；保留量 160，触发线 1_000
        const msgs = Array.from({ length: 5 }, () => turn(100, [10_000])).flat();
        const b = selectKeptBoundary(msgs, 160, 1_000);
        // 从尾累加第一条就 10_000 ≥ 160 ⇒ 挪到该轮轮首，保留段 = 10_100 ≥ 触发线 1_000 ⇒ 不压
        expect(hasDropped(b)).toBe(false);
    });

    it("尾部保留段没超触发线 ⇒ 压（并报出实际保留量，可能 > 目标：一条本身超大）", () => {
        const msgs = [...turn(100, [100]), ...turn(100, [500])];
        const b = selectKeptBoundary(msgs, 150, 5_000);
        expect(b.kind).toBe("drop");
        expect(b.cut).toBe(2);
        // 目标 150，实际 600（那一轮本身 600）—— 结构上必须整轮留下
        expect(b.retainedTokens).toBe(600);
        expect(b.dropped).toBe(2);
    });

    it("保留量 <= 0 ⇒ 不压（配置坏掉时不猜，交给配置层出声）", () => {
        expect(hasDropped(selectKeptBoundary([u(1), a(1)], 0, 100))).toBe(false);
    });
});
