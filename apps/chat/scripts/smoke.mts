// smoke.mts — 起隔离实例，用 CDP 走一遍 ##465 的判据（人不用手点也能验）。
//
// 判据：
//   ① 侧栏有「聊天」；能新建会话、发消息、收到**真模型**回复
//   ② 多会话隔离：第二个会话的消息不出现在第一个里
//   ③ 落盘：会话目录有 bucket / index / meta
//   ④ 重启后会话还在：关掉重开，列表仍在，点开消息完整
//   ⑤ 模型选择器列出 model.yaml 的 provider×model；切换后新会话用新模型
//
// 需要 `./sha.sh sync` 投影过真配置（build/lab/home/model.yaml 等）。不依赖测试框架。

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { chromium, type Page } from "playwright-core";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(pkgDir, "..", "..");
const variant = process.env["DIY_VARIANT"] ?? "lab";
const entry = join(pkgDir, "build", variant, "main", "index.mjs");
const home = join(repo, "build", variant, "home");
const port = 9600 + Math.floor(Math.random() * 200);

if (!existsSync(entry)) {
    console.error(`✗ 产物不存在：${entry}（先跑 ./sha.sh build）`);
    process.exit(1);
}
if (!existsSync(join(home, "model.yaml"))) {
    console.error(`✗ 数据根缺 model.yaml：${home}（先跑仓库根 ./sha.sh sync）`);
    process.exit(1);
}

let child: ChildProcess | null = null;
let logs = "";
const fail = (message: string): never => {
    console.error(`✗ ${message}`);
    if (logs) console.error(logs);
    child?.kill("SIGKILL");
    process.exit(1);
};

async function launch(): Promise<Page> {
    logs = "";
    child = spawn(electronPath as unknown as string, [entry, `--remote-debugging-port=${port}`], {
        env: { ...process.env, DIY_VARIANT: variant, DIY_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (buf: Buffer) => (logs += buf.toString()));
    child.stderr?.on("data", (buf: Buffer) => (logs += buf.toString()));
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            if ((await fetch(`${endpoint}/json/version`)).ok) break;
        } catch {
            // 还没起来
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    const browser = await chromium.connectOverCDP(endpoint);
    const page = browser.contexts()[0]?.pages()[0] ?? fail("没有页面");
    await page.waitForSelector(".chat-new", { timeout: 15_000, state: "visible" });
    return page;
}

async function stop(): Promise<void> {
    child?.kill("SIGTERM");
    child = null;
    await new Promise((r) => setTimeout(r, 1500));
}

async function newSession(page: Page, model: string, text: string): Promise<void> {
    const before = await page.$$eval(".chat-session", (items) => items.length);
    await page.selectOption(".chat-model", model);
    await page.click(".chat-new");
    await page.waitForFunction((n) => document.querySelectorAll(".chat-session").length === n + 1, before, { timeout: 10_000 });
    await page.fill(".chat-input", text);
    await page.press(".chat-input", "Enter");
    await page.waitForFunction(
        () => document.querySelectorAll(".chat-row[data-role=assistant]").length >= 1,
        null,
        { timeout: 120_000 },
    );
    const rows = await page.$$eval(".chat-row", (items) =>
        items.map((item) => [item.getAttribute("data-role"), item.querySelector(".chat-text")?.textContent]),
    );
    const last = rows[rows.length - 1];
    if (last?.[0] !== "assistant" || last[1].length === 0) fail(`没有拿到回复：${JSON.stringify(rows)}`);
    if (last[1].startsWith("出错了")) fail(`模型调用失败：${last[1]}`);
    console.log(`✓ ${model} 回复：${last[1].slice(0, 40)}`);
}

const page = await launch();
try {
    const nav = (await page.textContent(".wb-nav"))?.trim() ?? "";
    if (!nav.includes("聊天")) fail(`侧栏没有「聊天」：${JSON.stringify(nav)}`);
    console.log(`✓ 侧栏：${nav}`);

    const models = await page.$$eval(".chat-model option", (options) => options.map((o) => o.value));
    if (models.length < 2) fail(`模型选择器只有 ${models.length} 项`);
    if (!models.includes("deepseek/deepseek-flash")) fail("模型选择器缺少 deepseek/deepseek-flash");
    console.log(`✓ 模型选择器：${models.length} 个 provider×model`);

    // ① 真模型回复
    await newSession(page, "deepseek/deepseek-flash", "用一句话回答：1+1 等于几？");
    const firstTitle = await page.$eval(".chat-session[data-active=true] .chat-session-name", (el) => el.textContent);
    console.log(`✓ 首会话标题：${firstTitle}`);

    // ② 第二个会话 + 不同模型
    await newSession(page, "deepseek/deepseek-v4-flash", "第二会话的暗号：BETA");
    const metas = await page.$$eval(".chat-session", (items) =>
        items.map((item) => [
            item.querySelector(".chat-session-name")?.textContent,
            item.querySelector(".chat-session-meta")?.textContent,
        ]),
    );
    if (!metas.some(([, meta]) => meta?.includes("deepseek/deepseek-v4-flash"))) fail(`没有用上新模型：${JSON.stringify(metas)}`);
    console.log(`✓ 列表（新模型生效）：${JSON.stringify(metas)}`);

    // 切回第一个会话：不该有 BETA
    const buttons = await page.$$(".chat-session");
    await buttons[buttons.length - 1].click();
    await page.waitForTimeout(500);
    const firstRows = await page.$$eval(".chat-row", (items) =>
        items.map((item) => item.querySelector(".chat-text")?.textContent ?? ""),
    );
    if (firstRows.some((text) => text.includes("BETA"))) fail(`多会话没有隔离：${JSON.stringify(firstRows)}`);
    console.log(`✓ 多会话隔离：首会话 ${firstRows.length} 条，无 BETA`);

    // ③ 落盘
    const sessionDir = join(home, "sessions", "chat");
    const dirs = readdirSync(sessionDir).filter((name) => name.startsWith("s-"));
    if (dirs.length < 2) fail(`会话目录太少：${JSON.stringify(dirs)}`);
    const files = readdirSync(join(sessionDir, dirs[0]!)).sort();
    if (!files.includes("meta.json") || !files.some((file) => /^log-.+\.jsonl$/.test(file))) {
        fail(`落盘文件不对：${JSON.stringify(files)}`);
    }
    console.log(`✓ 落盘：${dirs.length} 个会话目录，${files.join(",")}`);

    // ④ 重启后会话还在
    await stop();
    const again = await launch();
    const listed = await again.$$eval(".chat-session", (items) => items.length);
    if (listed < 2) fail(`重启后只剩 ${listed} 个会话`);
    const shown = await again.$$eval(".chat-row", (items) => items.length);
    if (shown === 0) fail("重启后消息没有恢复");
    console.log(`✓ 重启后：${listed} 个会话，默认打开的会话 ${shown} 条消息`);
    await stop();
} catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
} finally {
    await stop();
}
