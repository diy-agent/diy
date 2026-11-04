// tests/e2e/bot-create.e2e.test.ts — 「+新 bot → 选模型 → 创建」全链路
//
// 这一条测的是**装起来能不能真用** —— 前面 38 个单元测试全部通过时，
// 这条仍然可能是红的（模型下拉为空、按钮点了没反应、面板被挡住）。
//
// 默认不跑（要起 Electron，慢）：`npm run test:e2e`
// 跑之前先 build：`npm run build`

import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Driver } from "./drive";
import electronPath from "electron";
import { join } from "node:path";

const PORT = 9444;
const REPO = join(import.meta.dirname, "../../../..");
const HOME = join(REPO, "build/lab/home");
const MAIN = join(import.meta.dirname, "../../build/lab/main/index.mjs");

let app: ChildProcess | undefined;
let d: Driver;

beforeAll(async () => {
    app = spawn(
        electronPath as unknown as string,
        [`--remote-debugging-port=${PORT}`, MAIN],
        {
            cwd: REPO,
            env: { ...process.env, DIY_HOME: HOME, DIY_VARIANT: "lab" },
            stdio: "ignore",
        },
    );
    d = await Driver.attach(PORT);
    const ready = await d.waitFor(`document.querySelector('.chat-page, .chat-bots, #app')`, 20_000);
    expect(ready, "页面根没渲染出来").toBe(true);
}, 60_000);

afterAll(() => {
    d?.close();
    app?.kill();
});

describe("建 bot 全链路", () => {
    it("首启就是「建第一个 bot」面板（bot 条隐藏），模型下拉必须有可选项", async () => {
        // 没有 bot 时 aside.chat-bots 是 hidden（renderer.ts:39），入口是默认展开的 .chat-panel
        const ok = await d.waitFor(`document.querySelector('.chat-panel')`);
        expect(ok, "建 bot 面板没出现").toBe(true);

        const models = await d.eval<string[]>(`[...document.querySelectorAll('.chat-panel select option')]
            .map(o => o.value).filter(v => v !== "")`);
        expect(models.length, "模型列表为空 —— 检查 DIY_HOME 下的 model.yaml").toBeGreaterThan(0);
    });

    it("填名字 + 选模型 + 创建 ⇒ 列表出现这个 bot", async () => {
        const name = `e2e-${Date.now()}`;
        await d.type('.chat-panel input[type="text"]', name);
        await d.eval(`(() => {
            const s = document.querySelector('.chat-panel select');
            s.selectedIndex = [...s.options].findIndex(o => o.value !== "");
            s.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await d.click(".chat-panel .chat-primary");

        const appeared = await d.waitFor(
            `[...document.querySelectorAll('.chat-bot-btn')].some(b => b.textContent.includes(${JSON.stringify(name)}))`,
            10_000,
        );
        expect(appeared, `创建后列表里没有 ${name}`).toBe(true);
    });

    it("全程没有未捕获异常", () => {
        const errs = d.errors();
        expect(errs, `页面抛异常：\n${errs.join("\n")}`).toEqual([]);
    });
});
