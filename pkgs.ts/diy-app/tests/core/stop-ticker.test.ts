// tests/core/stop-ticker.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 停止收尾期间的时钟推进器（##307 review2 R2）
//
// 回归对象：删掉 2s 轮询后，若还让 `now` 只在「对 main 真值返回 / 点停止」时前进，
// 则 main 卡在工具里（不发 op）时 `now` 冻住 → stoppingStuck 永假 → 「强制中断」出口失效。
// 这里钉死推进器本身：只在需要时走表、每拍推进、不需要时立即停（不空转）。
// 纯逻辑 + 注入 fake timer，无 Electron / DOM。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StopTicker } from "../../src/renderer_solid/lib/stop-ticker";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("StopTicker —— 只在「停止收尾中」走表", () => {
    it("sync(true) 开表，每拍调用 onTick；sync(false) 停表（幂等、不空转）", () => {
        let ticks = 0;
        const t = new StopTicker(() => ticks++, { intervalMs: 100 });

        expect(t.running).toBe(false);
        t.sync(false); // 不需要 → 保持停表
        expect(t.running).toBe(false);

        t.sync(true);
        expect(t.running).toBe(true);
        vi.advanceTimersByTime(350);
        expect(ticks).toBe(3); // 100/200/300

        t.sync(true); // 幂等：已在走表，不重建
        vi.advanceTimersByTime(100);
        expect(ticks).toBe(4);

        t.sync(false);
        expect(t.running).toBe(false);
        vi.advanceTimersByTime(500); // 停表后不再推进
        expect(ticks).toBe(4);

        t.stop(); // 幂等
        expect(t.running).toBe(false);
    });

    it("停表后 onTick 不再被调用（避免 main 卡死后永久空转）", () => {
        let ticks = 0;
        const t = new StopTicker(() => ticks++, { intervalMs: 50 });
        t.sync(true);
        vi.advanceTimersByTime(50);
        expect(ticks).toBe(1);
        t.sync(false);
        vi.advanceTimersByTime(10_000);
        expect(ticks).toBe(1);
    });
});
