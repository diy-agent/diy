// tests/e2e/bot-create.intent.test.ts — 同一个链路，**意图测试**版（B3）
//
// 与 bot-create.e2e.test.ts 的差别只有「怎么点」：
//   e2e    → Input.dispatchMouseEvent（真鼠标，受命中测试/遮挡/动画影响）
//   intent → window.__diyTest({ type:'click' })（dom.dispatchEvent，直达）
//
// 断言是一样的（面板打开、模型列表非空、值填进去了、无未捕获异常）——
// 所以这两份可以直接对比**速度与稳定性**。见 docs/testing.md 的分层。

import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Driver } from "@diy-agent/ui-testing";
import electronPath from "electron";
import { join } from "node:path";

const PORT = 9445; // 与 e2e 的 9444 错开，两份可以同时跑
const REPO = join(import.meta.dirname, "../../../..");
const HOME = join(REPO, "build/lab/home");
const MAIN = join(REPO, "apps/chat/build/app/main/index.mjs");

let app: ChildProcess | undefined;
let d: Driver;

beforeAll(async () => {
    app = spawn(electronPath as unknown as string, [`--remote-debugging-port=${PORT}`, MAIN], {
        cwd: REPO,
        env: { ...process.env, DIY_HOME: HOME, DIY_VARIANT: "lab" },
        stdio: "ignore",
    });
    d = await Driver.attach({ port: PORT, timeoutMs: 30_000 });
    const ready = await d.waitFor(
        `(() => { const e = document.querySelector('.chat-bots'); return e && !e.hidden && e.getBoundingClientRect().width > 0; })()`,
        30_000,
    );
    expect(ready, "bot 条没出现 —— 快照没落地").toBe(true);
    const hasHooks = await d.eval<boolean>(`typeof window.__diyTest === 'function'`);
    expect(hasHooks, "renderer 没装意图测试钩子（installTestHooks 没调？）").toBe(true);
}, 90_000);

afterAll(() => {
    d?.close();
    app?.kill();
});

/** 意图命令：直接调页面里的执行端（不经 CDP Input 域） */
const intent = <T = unknown>(cmd: Record<string, unknown>) =>
    d.eval<T>(`window.__diyTest(${JSON.stringify(cmd)})`);

describe("建 bot 全链路（意图测试）", () => {
    it("「+新 bot」面板能打开，模型列表非空", async () => {
        // 不需要 hover：`dispatchEvent` 不看宽度/遮挡（e2e 版必须先 hover 展开）
        await intent({ type: "click", selector: ".chat-bot-new-btn" });
        const opened = await d.waitFor(`document.querySelector('.chat-viewset')?.dataset?.show === 'true'`, 5000);
        expect(opened, "「+新 bot」面板没打开").toBe(true);
        const n = await d.eval<number>(
            `document.querySelectorAll('.chat-viewset option, .chat-viewset [role="option"]').length`,
        );
        expect(n, "模型下拉为空 —— 检查 build/lab/home 下的 model.yaml 与 models.dev.json 回落").toBeGreaterThan(0);
    });

    it("面板里能填名字（直接设值 + 派发 input）", async () => {
        const name = `intent-${Date.now()}`;
        await intent({ type: "fill", selector: '.chat-viewset input[type="text"]', value: name });
        const got = await d.eval<string>(`document.querySelector('.chat-viewset input[type="text"]')?.value ?? ''`);
        expect(got).toBe(name);
    });

    it("waitState：等实际状态而不是等 DOM（dom 有 ≠ 数据到位）", async () => {
        // 给页面挂一个可观测状态，验证轮询逻辑本身
        await d.eval(`window.__diyTestState = { booted: false }`);
        const started = Date.now();
        setTimeout(() => { void d.eval(`window.__diyTestState = { booted: true }`); }, 100);
        await intent({ type: "waitState", path: "booted", equals: true, timeoutMs: 3000 });
        expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    });

    it("全程没有未捕获异常", () => {
        const errs = d.errors();
        expect(errs, `页面抛异常：\n${errs.join("\n")}`).toEqual([]);
    });
});
