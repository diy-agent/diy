// verify-compact.mts — 压缩点面板的自动判据（人不用手点）。
//
// 为什么要它：这一轮连续三次「看起来修好了、人一试还是不行」（面板一直显示 / 移开不收起 /
// 轮号跳号）。手点不可重复，所以把三条判据写成脚本：
//   1 初始必须收起（`.chat-cut-panel` hidden）
//   2 悬停「窗口」指标 → 展开，且内容是「保留最近 N / M 轮」+ 轮次行 + 一条压缩点虚线
//   3 移开 → 收起
//   4 （可选 --apply）点「压缩」→ 出现 checkpoint（列表里出现删除线行）
//
// 用法：./sha.sh build && npx tsx scripts/verify-compact.mts [--apply]
// 前置：DIY_CHAT_AGENT=1（面板只在 Agent 宿主下有真数据）

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { chromium, type Browser, type Page } from "playwright-core";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(pkgDir, "..", "..");
const variant = process.env["DIY_VARIANT"] ?? "lab";
// 产物目录是 `build/app/`（apps/chat 的变体名就叫 app），不是 build/<variant>
const entry = join(pkgDir, "build", "app", "main", "index.mjs");
const home = join(repo, "build", variant, "home");
const port = 9800 + Math.floor(Math.random() * 150);
const apply = process.argv.includes("--apply");

if (!existsSync(entry)) {
    console.error(`✗ 产物不存在：${entry}（先 ./sha.sh build）`);
    process.exit(1);
}

let child: ChildProcess | null = null;
let browser: Browser | null = null;
let logs = "";
const step = (ok: boolean, label: string): void => {
    console.log(`${ok ? "✓" : "✗"} ${label}`);
    if (!ok) {
        if (logs) console.error(logs.slice(-3000));
        child?.kill("SIGKILL");
        void browser?.close();
        process.exit(1);
    }
};

async function launch(): Promise<Page> {
    child = spawn(electronPath as unknown as string, [entry, `--remote-debugging-port=${port}`], {
        env: { ...process.env, DIY_VARIANT: variant, DIY_HOME: home, DIY_CHAT_AGENT: "1" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (b: Buffer) => (logs += b.toString()));
    child.stderr?.on("data", (b: Buffer) => (logs += b.toString()));
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            if ((await fetch(`${endpoint}/json/version`)).ok) break;
        } catch {
            /* 还没起来 */
        }
        if (child.exitCode !== null) {
            console.error(`✗ electron 提前退出（code ${String(child.exitCode)}）\n${logs.slice(-2000)}`);
            process.exit(1);
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    const deadline2 = Date.now() + 25_000;
    while (Date.now() < deadline2) {
        const page = context?.pages().find((p) => p.url().startsWith("file:"));
        if (page) {
            await page.waitForSelector(".chat-app", { timeout: 20_000 });
            await page.waitForFunction(() => document.querySelector('[data-ready="1"]') !== null, undefined, {
                timeout: 30_000,
            });
            return page;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    console.error("✗ 没等到页面");
    child?.kill("SIGKILL");
    process.exit(1);
}

const page = await launch();
const panel = page.locator(".chat-cut-panel");

// ① 初始收起
step(!(await panel.isVisible()), "初始：面板收起");

// ② 悬停展开
await page.locator(".chat-cut-wrap").hover();
await panel.waitFor({ state: "visible", timeout: 8000 });
const head = (await panel.locator(".chat-cut-head").innerText()).replace(/\s+/g, " ").trim();
step(/保留最近 \d+ \/ \d+ 轮/.test(head), `悬停：展开且读数为「${head}」`);
const rows = await panel.locator(".chat-cut-row").count();
step(rows > 0, `悬停：列出 ${rows} 行轮次`);
const dropped = (() => {
    const m = /已压掉 (\d+) 轮/.exec(head);
    return m ? Number(m[1]) : 0;
})();
const cut = await panel.locator(".chat-cut-line").count();
step(cut === 1, "悬停：有一条压缩点虚线");
const nums = await panel.locator(".chat-cut-lab").allInnerTexts();
// 轮号是**绝对**的（只列还能保留的轮，已压掉的选不回来），所以判据是「严格递增 + 末号 = 总轮数」
const parsed = nums.map((t) => Number(/^轮(\d+)$/.exec(t)?.[1] ?? NaN));
const asc = parsed.every((n, i) => Number.isFinite(n) && (i === 0 || n === parsed[i - 1]! + 1));
const lastNo = parsed[parsed.length - 1] ?? 0;
step(asc && lastNo === nums.length + dropped, `悬停：轮号递增且末号对得上（${nums.join(",")}）`);

// ③ 移开收起
await page.locator(".chat-bot-label").hover();
await panel.waitFor({ state: "hidden", timeout: 5000 });
step(true, "移开：面板收起");

// ④ 可选：真压一次
if (apply) {
    const total = nums.length;
    if (total < 2) {
        console.log("· 只有 1 轮，跳过压缩验证");
    } else {
        await page.locator(".chat-cut-wrap").hover();
        await panel.waitFor({ state: "visible", timeout: 8000 });
        const range = panel.locator(".chat-cut-range");
        await range.fill("1");
        await range.dispatchEvent("input");
        await panel.locator(".chat-cut-apply").click();
        await page.waitForTimeout(2000);
        // 压缩后整页会重绘（applySnapshot）⇒ 面板节点被换掉，重新悬停拿新的那个
        if (!(await panel.isVisible())) {
            await page.locator(".chat-cut-wrap").hover();
            await page.waitForTimeout(400);
        }
        // 调试：把面板读回来（失败时最需要知道它到底显示了什么）
        console.log("  面板读数：", (await panel.innerText()).replace(/\s+/g, " ").slice(0, 160));
        const struck = await panel.locator(".chat-cut-row-drop").count();
        step(struck > 0, `压缩后：出现 ${struck} 行删除线（已压掉）`);
    }
}

console.log("全部通过");
child?.kill("SIGTERM");
await browser?.close();
process.exit(0);
