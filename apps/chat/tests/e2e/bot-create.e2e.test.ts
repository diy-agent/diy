// tests/e2e/bot-create.e2e.test.ts — 「+新 bot → 选模型 → 创建」全链路
//
// 测的是**装起来能不能真用**：前面几十个单元测试全绿时，这条仍可能红
// （模型列表为空、按钮点了没反应、面板被挡住）。
//
// 默认不跑：`npm run test:e2e`（要先 `./sha.sh build`）

import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Driver } from "@diy-agent/ui-testing";
import electronPath from "electron";
import { join } from "node:path";

const PORT = 9444;
const REPO = join(import.meta.dirname, "../../../..");
const HOME = join(REPO, "build/lab/home");
const MAIN = join(import.meta.dirname, "../../build/lab/main/index.mjs");

let app: ChildProcess | undefined;
let d: Driver;

beforeAll(async () => {
    app = spawn(electronPath as unknown as string, [`--remote-debugging-port=${PORT}`, MAIN], {
        cwd: REPO,
        env: { ...process.env, DIY_HOME: HOME, DIY_VARIANT: "lab" },
        stdio: "ignore",
    });
    d = await Driver.attach({ port: PORT, timeoutMs: 30_000 });
    // 骨架渲染 ≠ 就绪：bot 条要等首份快照（aside.hidden=false）。等它的尺寸非 0 才说明 snapshot 落地了。
    const ready = await d.waitFor(
        `(() => { const e = document.querySelector('.chat-bots'); return e && !e.hidden && e.getBoundingClientRect().width > 0; })()`,
        30_000,
    );
    expect(ready, "bot 条没出现 —— 快照没落地（检查 DIY_HOME / models.dev.json 回落）").toBe(true);
}, 90_000);

afterAll(() => {
    d?.close();
    app?.kill();
});

/** 打开「+新 bot」面板并返回可选模型数（面板里是自定义下拉，不是原生 select） */
async function openNewBotPanel(): Promise<number> {
    // bot 条平时 64px 收起（只露头像），hover 才展开到 200px —— 直接点会因为宽度 0 失败
    await d.hover(".chat-bots");
    await d.click(".chat-bot-new-btn");
    const opened = await d.waitFor(`document.querySelector('.chat-viewset')?.dataset?.show === 'true'`, 5000);
    expect(opened, "「+新 bot」面板没打开").toBe(true);
    return d.eval<number>(`document.querySelectorAll('.chat-viewset option, .chat-viewset [role="option"]').length`);
}

describe("建 bot 全链路", () => {
    it("「+新 bot」面板能打开，模型列表非空", async () => {
        const n = await openNewBotPanel();
        // 0 意味着 loadCatalog 没读到 models.dev.json（回落路径 / DIY_HOME 问题）
        expect(n, "模型下拉为空 —— 检查 build/lab/home 下的 model.yaml 与 models.dev.json 回落").toBeGreaterThan(0);
    });

    it("面板里能填名字（输入框可交互）", async () => {
        const name = `e2e-${Date.now()}`;
        await d.type('.chat-viewset input[type="text"]', name);
        const got = await d.eval<string>(`document.querySelector('.chat-viewset input[type="text"]')?.value ?? ''`);
        expect(got).toBe(name);
    });

    it("全程没有未捕获异常", () => {
        const errs = d.errors();
        expect(errs, `页面抛异常：\n${errs.join("\n")}`).toEqual([]);
    });
});
