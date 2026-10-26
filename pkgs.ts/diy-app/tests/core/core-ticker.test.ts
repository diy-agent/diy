import { describe, expect, it } from "vitest";
import { CoreTicker } from "../../src/main/services/core-ticker";

// ##408 v2：唯一一拍源。**不真等 60s** —— 计时器注入，tick() 直接调。

function fakeClock() {
    let fire: (() => void) | null = null;
    let unrefCalled = false;
    const handle = { unref: () => void (unrefCalled = true) } as unknown as NodeJS.Timeout;
    let intervals = 0;
    let cleared = 0;
    return {
        deps: {
            now: () => 1_000,
            setTimer: (fn: () => void) => {
                intervals += 1;
                fire = fn;
                return handle;
            },
            clearTimer: () => {
                cleared += 1;
                fire = null;
            },
        },
        fire: () => fire?.(),
        get armed() {
            return fire !== null;
        },
        get intervals() {
            return intervals;
        },
        get cleared() {
            return cleared;
        },
        get unrefCalled() {
            return unrefCalled;
        },
    };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

describe("订阅读表", () => {
    it("没人订阅 ⇒ 一个 timer 都不存在；首个订阅才起表", () => {
        const c = fakeClock();
        const ticker = new CoreTicker(c.deps);
        expect(ticker.isRunning()).toBe(false);
        expect(c.intervals).toBe(0);
        ticker.subscribe("a", () => void 0);
        expect(ticker.isRunning()).toBe(true);
        expect(c.intervals).toBe(1);
    });

    it("最后一个退订 ⇒ 停表（空转的定时器是纯电费）", () => {
        const c = fakeClock();
        const ticker = new CoreTicker(c.deps);
        const offA = ticker.subscribe("a", () => void 0);
        const offB = ticker.subscribe("b", () => void 0);
        offA();
        expect(ticker.isRunning()).toBe(true);
        offB();
        expect(ticker.isRunning()).toBe(false);
        expect(c.cleared).toBe(1);
    });

    it("退订函数幂等；同名重复订阅 = 替换（同一件事不许一拍跑两遍）", async () => {
        const c = fakeClock();
        const ticker = new CoreTicker(c.deps);
        let n = 0;
        ticker.subscribe("same", () => void n++);
        ticker.subscribe("same", () => void n++);
        await ticker.tick(0);
        expect(n).toBe(1);
        const off = ticker.subscribe("same", () => void n++);
        off();
        off();
        expect(ticker.stats().handlers).toHaveLength(0);
    });

    it("定时器 unref：后台一拍不该吊住进程退出", () => {
        const c = fakeClock();
        const ticker = new CoreTicker(c.deps);
        ticker.subscribe("a", () => void 0);
        expect(c.unrefCalled).toBe(true);
    });
});

describe("一拍怎么跑", () => {
    it("一次 tick 把所有住户都跑一遍，序号从 1 起", async () => {
        const c = fakeClock();
        const ticker = new CoreTicker(c.deps);
        const seen: string[] = [];
        ticker.subscribe("a", (ctx) => void seen.push(`a${ctx.seq}`));
        ticker.subscribe("b", (ctx) => void seen.push(`b${ctx.seq}`));
        const r = await ticker.tick(0);
        expect(r).toMatchObject({ ran: true, at: 0, seq: 1, handlers: 2 });
        expect(seen.sort()).toEqual(["a1", "b1"]);
    });

    it("一个住户抛错不带走别人：失败记在它自己名下", async () => {
        const c = fakeClock();
        const ticker = new CoreTicker(c.deps);
        let ok = 0;
        ticker.subscribe("bad", () => {
            throw new Error("boom");
        });
        ticker.subscribe("good", () => void ok++);
        await ticker.tick(0);
        expect(ok).toBe(1);
        const bad = ticker.stats().handlers.find((h) => h.name === "bad");
        expect(bad).toMatchObject({ failures: 1, runs: 0, lastError: "boom" });
    });

    it("单飞：上一拍没跑完，这一拍整体跳过（不排队、不叠拍）", async () => {
        const c = fakeClock();
        const ticker = new CoreTicker(c.deps);
        const gate = deferred();
        const order: string[] = [];
        ticker.subscribe("slow", async () => {
            order.push("slow-start");
            await gate.promise;
            order.push("slow-end");
        });
        ticker.subscribe("fast", () => void order.push("fast"));

        const first = ticker.tick(0);
        await Promise.resolve();
        expect(order).toEqual(["slow-start", "fast"]);

        const second = await ticker.tick(1);
        expect(second).toMatchObject({ ran: false, seq: 1, skipped: 1 });

        gate.resolve();
        await first;
        expect(order).toEqual(["slow-start", "fast", "slow-end"]);
        const third = await ticker.tick(2);
        expect(third).toMatchObject({ ran: true, seq: 2 });
    });
});
