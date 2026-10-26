import { describe, expect, it } from "vitest";
import { TICK_MS, TickGate } from "../../src/shared/tick";

// ##408 v2：一拍的门（纯判据）。判据写进用例名 —— 改实现先看这些句子还成不成立。

describe("一拍 = 60s", () => {
    it("间隔是常量，watch 的分钟数按它折算成整数拍", () => {
        expect(TICK_MS).toBe(60_000);
        expect(TICK_MS / 60_000).toBe(1);
    });
});

describe("单飞", () => {
    it("上一拍没 end 之前，下一拍被跳过：序号不涨、跳拍数 +1", () => {
        const gate = new TickGate();
        expect(gate.begin(1_000)).toEqual({ ran: true, seq: 1 });
        expect(gate.begin(2_000)).toEqual({ ran: false, seq: 1, reason: "busy" });
        expect(gate.begin(3_000)).toEqual({ ran: false, seq: 1, reason: "busy" });
        expect(gate.stats()).toEqual({ seq: 1, skipped: 2 });
    });

    it("end 之后下一拍照常跑，序号接着涨", () => {
        const gate = new TickGate();
        gate.begin(0);
        gate.end();
        expect(gate.begin(60_000)).toEqual({ ran: true, seq: 2 });
        expect(gate.isBusy()).toBe(true);
    });

    it("跳过的拍不推进序号：序号 = 「真正跑过几次」", () => {
        const gate = new TickGate();
        gate.begin(0);
        gate.begin(1); // skip
        gate.end();
        gate.begin(2); // seq 2
        expect(gate.stats().seq).toBe(2);
    });

    it("最后一次跳拍的时刻可查（跳没跳要能看见，不能靠猜）", () => {
        const gate = new TickGate();
        expect(gate.lastSkipAt()).toBeNull();
        gate.begin(0);
        gate.begin(12_345);
        expect(gate.lastSkipAt()).toBe(12_345);
    });
});

describe("计数与复位", () => {
    it("reset 清空三个计数（只在测试里用：序号回退等于假装时间倒流）", () => {
        const gate = new TickGate();
        gate.begin(0);
        gate.begin(1);
        gate.reset();
        expect(gate.stats()).toEqual({ seq: 0, skipped: 0 });
        expect(gate.isBusy()).toBe(false);
    });
});
