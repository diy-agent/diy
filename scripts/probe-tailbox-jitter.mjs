#!/usr/bin/env node
/**
 * 活动框（TailBox）抖动探针 —— 逐帧采 `[data-tail-row]` 的 rect + `data-live-area` 状态序列。
 *
 * 为什么要有这个脚本：活动框的「高度会跳」只能**实测**定位（候选源见 ##399 body），
 * 靠读代码猜不出来 —— 定高体 `h-[8.2em]` 看着恒定，真正的跳变发生在「轮末坍缩」
 * 与「折叠状态被换叶子重置」两处，且都是时序问题。
 *
 * 用法（需要**已经跑起来的**实例，探针只 attach、从不启动/关闭实例）：
 *
 *   1) 拿 CDP 端口：`cat <DIY_HOME>/electron_user_data/DevToolsActivePort` 第一行
 *      （`--remote-debugging-port=0` 时由 Electron 写盘）
 *   2) `node scripts/probe-tailbox-jitter.mjs 65096 /tmp/jitter.jsonl 60000 [--click-at=12000]`
 *   3) 另开一条命令真发一轮对话（`./diy.sh agent local chat <uri> "<消息>"`），让框动起来
 *   4) 结束后按 t / area / bid 去重看序列：**h 恒 = 稳定；h 在 area 变化处跳 = 换叶子重建；
 *      h 变 0 = 轮末坍缩；h 120.7 → 30.5 → 120.7 = 用户折叠被新叶子重置**
 *
 * 依赖：`playwright-core`（`playwright-cli` 自带的那份）。用 `PLAYWRIGHT_CORE` 环境变量指路径，
 * 缺省走全局 playwright-cli 的 node_modules（故本脚本**不加进** package.json 依赖 —— 它不是产品运行时）。
 *
 * 只读：除了在轮次进行中可选的「点头一次」（`--click-at`，用来验开合是否真的生效）外，不改任何状态。
 */
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const corePath =
    process.env.PLAYWRIGHT_CORE ??
    "/Users/ccc/.local/share/mise/installs/node/24.19.0/lib/node_modules/@playwright/cli/node_modules/playwright-core/index.js";
const { chromium } = require(corePath);

const [port, out = "/tmp/tailbox-jitter.jsonl", ms = "60000", ...rest] = process.argv.slice(2);
if (!port) {
    console.error("用法: node probe-tailbox-jitter.mjs <cdp-port> [out.jsonl] [durationMs] [--click-at=ms]");
    process.exit(2);
}
const clickAt = Number((rest.find((a) => a.startsWith("--click-at=")) ?? "").split("=")[1] ?? 0);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page =
    browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("http://localhost")) ??
    browser.contexts()[0].pages()[0];

const t0 = Date.now();
const fd = fs.createWriteStream(out);
let clicked = false;

/** 一帧样本：活动框外框 / 体 / 开合态 / 标题 / 滚动位置 */
const probe = () => {
    const live = document.querySelector("[data-live-area]");
    const row = document.querySelector("[data-tail-row]");
    const scroller = document.querySelector("[data-chat-list]")?.closest(".overflow-y-auto");
    const head = live?.querySelector("[role=button],button");
    return {
        h: row ? Math.round(row.getBoundingClientRect().height * 10) / 10 : null,
        top: row ? Math.round(row.getBoundingClientRect().top * 10) / 10 : null,
        area: live ? live.getAttribute("data-live-area") : null,
        bid: live ? live.getAttribute("data-block-id") : null,
        head: head ? head.innerText.replace(/\s+/g, " ").slice(0, 70) : null,
        rows: document.querySelectorAll("[data-block-id]").length,
        st: scroller ? scroller.scrollTop : null,
        sh: scroller ? scroller.scrollHeight : null,
    };
};

while (Date.now() - t0 < Number(ms)) {
    const t = Date.now() - t0;
    let sample;
    try {
        sample = await page.evaluate(probe);
    } catch (err) {
        sample = { err: String(err).slice(0, 80) };
    }
    if (clickAt && !clicked && t >= clickAt) {
        clicked = true;
        const action = await page
            .evaluate(() => {
                const live = document.querySelector("[data-live-area]");
                const head = live?.querySelector("[role=button],button");
                if (!head) return "no-head";
                head.click();
                return "clicked";
            })
            .catch(() => "err");
        fd.write(JSON.stringify({ t, action }) + "\n");
    }
    fd.write(JSON.stringify({ t, ...sample }) + "\n");
    await new Promise((r) => setTimeout(r, 60));
}
fd.end();
// 只断开，不 close：探针不得关闭被别人跑着的实例
process.exit(0);
