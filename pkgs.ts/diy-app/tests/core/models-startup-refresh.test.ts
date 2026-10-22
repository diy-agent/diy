// tests/core/models-startup-refresh.test.ts
// 🎯 模型目录**启动后一次**刷新的契约（##385 §3.2）：延迟执行、可关、退出可取消、失败不抛。
//
// 为什么只测「什么时候调」：调了怎么判 diff / 怎么不写半成品在 tests/core/models-sync.test.ts。
// 定时（24h）**不在本条**：调度器与 job 可见性归 ##408，本文件也不该出现 setInterval ——
// 一旦出现就说明又造了第二套调度器。
import { describe, expect, it } from "vitest";
import type { ModelsRefreshResult } from "../../src/shared/model-config";
import {
    DEFAULT_STARTUP_DELAY_MS,
    refreshModelsOnStartup,
    startupRefreshEnabled,
    type StartupTimer,
} from "../../src/main/services/models-startup-refresh";

/** 假定时器：记录一处 setTimeout，测试手动触发 / 检查取消 */
function fakeTimer() {
    const timeouts: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const timer: StartupTimer = {
        setTimeout: (fn, ms) => {
            const h = { fn, ms, cleared: false };
            timeouts.push(h);
            return h;
        },
        clearTimeout: (h) => {
            (h as { cleared: boolean }).cleared = true;
        },
    };
    return { timer, timeouts };
}

const okResult = (changed: boolean): ModelsRefreshResult => ({
    ok: true,
    changed,
    checkedAt: "2026-10-22T00:00:00.000Z",
    path: "/tmp/x/models.dev.json",
    origin: "https://models.dev/api.json",
    providers: 2,
    models: 3,
    addedProviders: [],
    removedProviders: [],
    addedModels: changed ? 1 : 0,
    removedModels: 0,
    previous: null,
    error: null,
});

const tick = () => new Promise((r) => setTimeout(r, 0)); // 让 run 里的 await 完成

describe("startupRefreshEnabled", () => {
    it("缺省开启", () => {
        expect(startupRefreshEnabled({})).toBe(true);
    });

    it.each(["0", "false", "off", "no"])("可关：DIY_MODELS_STARTUP_REFRESH=%s", (v) => {
        expect(startupRefreshEnabled({ DIY_MODELS_STARTUP_REFRESH: v })).toBe(false);
    });
});

describe("refreshModelsOnStartup", () => {
    it("延迟 DEFAULT_STARTUP_DELAY_MS 后跑**一次**（不注册任何间隔）", async () => {
        const { timer, timeouts } = fakeTimer();
        let calls = 0;
        refreshModelsOnStartup({ timer, delayMs: DEFAULT_STARTUP_DELAY_MS, refresh: async () => (calls++, okResult(false)), log: () => {} });
        expect(timeouts).toHaveLength(1); // 只有一个 setTimeout：没有任何循环调度
        expect(timeouts[0]!.ms).toBe(15_000);
        expect(calls).toBe(0); // 不阻塞启动：注册时没跑
        timeouts[0]!.fn();
        await tick();
        expect(calls).toBe(1);
    });

    it("关闭时什么都不注册（手工按钮仍可用）", () => {
        const { timer, timeouts } = fakeTimer();
        const logs: string[] = [];
        refreshModelsOnStartup({ timer, enabled: false, refresh: async () => okResult(false), log: (m) => logs.push(m) });
        expect(timeouts).toHaveLength(0);
        expect(logs.join("\n")).toMatch(/已关闭/);
    });

    it("取消函数清掉挂着的定时器，之后不再调 refresh（应用退出不留悬挂 tick）", async () => {
        const { timer, timeouts } = fakeTimer();
        let calls = 0;
        const cancel = refreshModelsOnStartup({ timer, refresh: async () => (calls++, okResult(false)), log: () => {} });
        cancel();
        expect(timeouts[0]!.cleared).toBe(true);
        timeouts[0]!.fn(); // 即使（竞争下）回调仍被调到，也不跑
        await tick();
        expect(calls).toBe(0);
    });

    it("refresh 抛异常不冒泡、走 warn（启动流程不会因一次抓取失败被拖垮）", async () => {
        const { timer, timeouts } = fakeTimer();
        const warns: string[] = [];
        refreshModelsOnStartup({
            timer,
            refresh: async () => {
                throw new Error("boom");
            },
            log: () => {},
            warn: (m) => warns.push(m),
        });
        timeouts[0]!.fn();
        await tick();
        expect(warns.join("\n")).toMatch(/boom/);
    });

    it("失败结果不抛、只 warn（不弹窗轰炸的机制侧）", async () => {
        const { timer, timeouts } = fakeTimer();
        const warns: string[] = [];
        refreshModelsOnStartup({
            timer,
            refresh: async () => ({ ...okResult(false), ok: false, error: "HTTP 502" }),
            log: () => {},
            warn: (m) => warns.push(m),
        });
        timeouts[0]!.fn();
        await tick();
        expect(warns.join("\n")).toMatch(/HTTP 502/);
    });
});
