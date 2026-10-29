// smoke.mts — 起一个隔离实例，用 CDP 走一遍 UI 判据（人不用手点也能验）。
//
// 判据（与 ##457 body 的 ①② 对应）：
//   ① 侧栏出现页面按钮「聊天」
//   ② 输入一句话回车 ⇒ 消息列表出现用户消息 + 一条固定回复
//
// 不依赖任何测试框架：连上 → 断言 → 关窗 → 退出码 0/1。

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { chromium } from "playwright-core";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const variant = process.env["DIY_VARIANT"] ?? "lab";
const entry = join(pkgDir, "build", variant, "main", "index.mjs");
const home = join(resolve(pkgDir, "..", ".."), "build", variant, "home");
const port = 9300 + Math.floor(Math.random() * 200);

if (!existsSync(entry)) {
    console.error(`✗ 产物不存在：${entry}（先跑 ./sha.sh build）`);
    process.exit(1);
}

const child: ChildProcess = spawn(electronPath as unknown as string, [entry, `--remote-debugging-port=${port}`], {
    env: { ...process.env, DIY_VARIANT: variant, DIY_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout?.on("data", (buf: Buffer) => (logs += buf.toString()));
child.stderr?.on("data", (buf: Buffer) => (logs += buf.toString()));

const fail = (message: string): never => {
    console.error(`✗ ${message}`);
    if (logs) console.error(logs);
    child.kill("SIGKILL");
    process.exit(1);
};

const endpoint = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 30_000;
let ready = false;
while (Date.now() < deadline) {
    try {
        const res = await fetch(`${endpoint}/json/version`);
        if (res.ok) {
            ready = true;
            break;
        }
    } catch {
        // 还没起来
    }
    await new Promise((r) => setTimeout(r, 200));
}
if (!ready) fail(`等不到 CDP（${endpoint}）`);

const browser = await chromium.connectOverCDP(endpoint);
try {
    const page = browser.contexts()[0]?.pages()[0] ?? fail("没有页面");
    await page.waitForSelector(".wb-nav-item", { timeout: 15_000 });
    const navText = (await page.textContent(".wb-nav"))?.trim() ?? "";
    if (!navText.includes("聊天")) fail(`侧栏没有「聊天」：${JSON.stringify(navText)}`);

    await page.fill(".chat-input", "你好");
    await page.press(".chat-input", "Enter");
    await page.waitForFunction(() => document.querySelectorAll(".chat-row").length >= 2, null, { timeout: 10_000 });
    const rows = await page.$$eval(".chat-row", (items) =>
        items.map((item) => ({
            role: (item as HTMLElement).dataset["role"],
            text: item.querySelector(".chat-text")?.textContent ?? "",
        })),
    );
    if (rows[0]?.role !== "user" || rows[0]?.text !== "你好") fail(`用户消息不对：${JSON.stringify(rows[0])}`);
    if (rows[1]?.role !== "assistant" || !rows[1]?.text) fail(`没有固定回复：${JSON.stringify(rows[1])}`);

    console.log(`✓ 侧栏：${navText}`);
    console.log(`✓ 用户消息：${rows[0].text}`);
    console.log(`✓ 回复：${rows[1].text}`);
} finally {
    await browser.close();
    child.kill("SIGTERM");
}
