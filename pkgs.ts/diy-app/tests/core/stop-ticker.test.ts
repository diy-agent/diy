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

// ═══════════════════════════════════════════════════════════════
// 🎯 生命周期接线（##307 review3 R6）：镜像 localChatStore 的调用序列
//
// 真实的 store 接线（在 renderer 环境，本仓 node 单测覆盖不到）是：
//   · `setStopRequested`       —— stopRequestedAt 的**唯一写点**，改值即 `syncStopTicker()`
//   · `cancel`                 —— setStopRequested(true)  → 开表
//   · `refreshActive` 报不活跃 —— setStopRequested(null)  → 停表
//   · `watch()`/`open()` 起始  —— `syncStopTicker()`       → 切回仍在收尾的任务要重新开表
//   · `watch()` 清理           —— `stopTicker.stop()`      → 离开页面硬停表（不留空转）
// 这里用真实 StopTicker 复刻该序列，钉死协议：漏任一处 sync，ticker 就停在错的状态。
// ═══════════════════════════════════════════════════════════════

describe("StopTicker — 生命周期接线（镜像 localChatStore）", () => {
    it("切走再切回仍在收尾的任务：起始 sync 重新开表（R6 核心）", () => {
        // 用「多任务停态」镜像 anyTaskStopping()：任一 stopping 即需走表
        const stopping: Record<string, boolean> = { a: false, b: false };
        const anyStopping = (): boolean => Object.values(stopping).some(Boolean);
        const ticker = new StopTicker(() => {}, { intervalMs: 100 });
        const sync = (): void => ticker.sync(anyStopping());               // = syncStopTicker
        const setStop = (k: string, v: boolean): void => { stopping[k] = v; sync(); }; // = setStopRequested

        setStop("a", true);                       // cancel(A) → 开表
        expect(ticker.running).toBe(true);

        ticker.stop();                            // 切走 A（watch cleanup）→ 硬停表
        expect(ticker.running).toBe(false);

        sync();                                   // 切回 A（watch/open 起始）→ 按全局停态重新开表
        expect(ticker.running).toBe(true);        // 曾漏此步 → 恒 false，「强制中断」出口成死代码

        setStop("a", false);                      // main 收尾 → refreshActive 清停态 → 停表
        expect(ticker.running).toBe(false);
    });

    it("新一轮开始清停态即停表（send 清 stopRequestedAt 也须同步）", () => {
        const stopping = { a: false };
        const ticker = new StopTicker(() => {}, { intervalMs: 100 });
        const setStop = (v: boolean): void => { stopping.a = v; ticker.sync(stopping.a); };

        setStop(true);
        expect(ticker.running).toBe(true);
        setStop(false); // send() 清停态
        expect(ticker.running).toBe(false);
    });
});
