// smoke.mts — 起隔离实例，用 CDP 走一遍 ##498 的判据（人不用手点也能验）。
//
// 判据：
//   ① 侧栏有「聊天」；能建 bot、发消息、收到**真模型**回复
//   ② 多 bot 隔离：第二个 bot 的消息不出现在第一个里（各有一条长期会话）
//   ③ 落盘：会话目录有 bucket / index / meta；bot.json 里有 primarySessionId
//   ④ 重启后还在：关掉重开，bot 列表仍在，点开消息完整（同一个 session）
//   ⑤ 「+ 新 bot」能建新 bot（跳配置面板）；**没有「新建会话」**
//
// 需要 `./sha.sh sync` 投影过真配置（build/lab/home/model.yaml 等）。不依赖测试框架。

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
    await page.waitForSelector(".chat-bots", { timeout: 15_000, state: "visible" });
    // 首份快照落地（否则 rows 还是空的，写死的 before 会立刻被历史消息满足）
    await page.waitForFunction(() => document.querySelector('[data-ready="1"]') !== null, null, { timeout: 30_000 });
    return page;
}

async function stop(): Promise<void> {
    child?.kill("SIGTERM");
    child = null;
    await new Promise((r) => setTimeout(r, 1500));
}

/** 首启引导：bots 为空时面板盖在消息区上（判据 8），按引导建第一个 bot */
async function ensureBot(page: Page, model: string): Promise<void> {
    if ((await page.$$eval('.chat-bot[data-active="true"]', (items) => items.length)) > 0) return;
    const panel = ".chat-panel[data-show=true]";
    await page.waitForSelector(panel, { timeout: 30_000 });
    await page.selectOption(`${panel} select`, model);
    await page.click(`${panel} button.chat-primary`);
    await page.waitForFunction(() => document.querySelectorAll('.chat-bot[data-active="true"]').length > 0, null, {
        timeout: 30_000,
    });
    console.log("✓ 首启引导：建了第一个 bot");
}

/** 「+ 新 bot」→ 配置面板填名字 / 选模型 → 创建（每建一个就是一个长期会话） */
async function newBot(page: Page, name: string, model: string, text: string): Promise<void> {
    const before = await page.$$eval(".chat-bot", (items) => items.length);
    await page.click(".chat-bot-new-btn");
    // 新建 bot 走右侧 panel（viewset）
    const panel = ".chat-viewset[data-show=true]";
    await page.waitForSelector(panel, { timeout: 10_000 });
    await page.fill(`${panel} input`, name);
    await page.selectOption(`${panel} select`, model);
    await page.click(`${panel} button.chat-primary`);
    await page.waitForFunction((n) => document.querySelectorAll(".chat-bot").length === n + 1, before, {
        timeout: 10_000,
    });
    await send(page, model, text);
}

async function send(page: Page, model: string, text: string): Promise<string> {
    // 会话是长期的那一条（跨 run 累积），所以按「助手行数增加」等，不是「>=1」
    const before = await page.$$eval(".chat-row[data-role=assistant]", (items) => items.length);
    await page.fill(".chat-input", text);
    await page.press(".chat-input", "Enter");
    await page.waitForFunction(
        (n) => document.querySelectorAll(".chat-row[data-role=assistant]").length > n,
        before,
        { timeout: 120_000 },
    );
    const rows = await page.$$eval(".chat-row", (items) =>
        items.map((item) => [item.getAttribute("data-role"), item.querySelector(".chat-text")?.textContent]),
    );
    const last = rows[rows.length - 1];
    if (last?.[0] !== "assistant" || last[1].length === 0) fail(`没有拿到回复：${JSON.stringify(rows)}`);
    if (last[1].startsWith("出错了")) fail(`模型调用失败：${last[1]}`);
    console.log(`✓ ${model} 回复：${last[1].slice(0, 40)}`);
    return last[1];
}

const page = await launch();
try {
    // 侧栏窄态只有图标：点 ☰ 钉住展开再读菜单文字（2026-11-02 起不再有抽屉）
    await page.click(".wb-side-toggle");
    const nav = (await page.textContent(".wb-side"))?.trim() ?? "";
    await page.keyboard.press("Escape");
    if (!nav.includes("聊天")) fail(`侧栏没有「聊天」：${JSON.stringify(nav)}`);
    console.log(`✓ 侧栏：${nav}`);

    // 判据 5：没有「新建会话」按钮，只有「+ 新 bot」
    if ((await page.$$eval(".chat-new", (items) => items.length)) !== 0) fail("还有「新建会话」按钮");
    if ((await page.$$eval(".chat-bot-new-btn", (items) => items.length)) !== 1) fail("缺「+ 新 bot」入口");

    // ① 真模型回复（首启则先按引导建 bot）
    await ensureBot(page, "deepseek/deepseek-flash");
    await send(page, "deepseek/deepseek-flash", "用一句话回答：1+1 等于几？");

    // ② 第二个 bot + 不同模型；两个 bot 各有一条长期会话
    const secondName = `小助手-${String(Date.now() % 10000)}`;
    await newBot(page, secondName, "deepseek/deepseek-v4-flash", "第二会话的暗号：BETA");
    const names = await page.$$eval(".chat-bot-name", (items) => items.map((item) => item.textContent));
    if (!names.includes(secondName)) fail(`bot 列表没有新 bot：${JSON.stringify(names)}`);
    console.log(`✓ bot 列表：${JSON.stringify(names)}`);

    // 切回第一个 bot：不该有 BETA
    // 切回第一个 bot（大王助手）：它的消息里不该有 BETA
    const backRow = page.locator('.chat-bot[data-active="false"]', { hasText: "大王助手" });
    if ((await backRow.count()) > 0) await backRow.first().click();
    else await page.locator('.chat-bot[data-active="false"]').first().click();
    await page.waitForTimeout(800);
    const firstRows = await page.$$eval(".chat-row", (items) =>
        items.map((item) => item.querySelector(".chat-text")?.textContent ?? ""),
    );
    if (firstRows.some((text) => text.includes("BETA"))) fail(`多 bot 没有隔离：${JSON.stringify(firstRows)}`);
    console.log(`✓ 多 bot 隔离：当前 bot ${firstRows.length} 条消息，无 BETA`);

    // ③ 落盘：每个 bot 一个会话目录；bot.json 有 primarySessionId
    const sessionDir = join(home, "sessions", "chat");
    const dirs = readdirSync(sessionDir).filter((name) => name.startsWith("s-"));
    if (dirs.length < 2) fail(`会话目录太少：${JSON.stringify(dirs)}`);
    const files = readdirSync(join(sessionDir, dirs[0]!)).sort();
    if (!files.includes("meta.json") || !files.some((file) => /^(log-|\d{4,}-).+\.jsonl$/.test(file))) {
        fail(`落盘文件不对：${JSON.stringify(files)}`);
    }
    const botsDir = join(home, "bots");
    for (const botId of readdirSync(botsDir)) {
        const config = JSON.parse(readFileSync(join(botsDir, botId, "bot.json"), "utf-8")) as {
            primarySessionId?: string;
        };
        if (typeof config.primarySessionId !== "string") fail(`bot ${botId} 没有 primarySessionId（判据 4）`);
    }
    console.log(`✓ 落盘：${dirs.length} 个会话目录，${files.join(",")}；bot.json 带 primarySessionId`);

    // ④ 重启后还在：bot 列表 + 消息恢复（同一个 session）
    await stop();
    const again = await launch();
    const listed = await again.$$eval(".chat-bot", (items) => items.length);
    if (listed < 2) fail(`重启后只剩 ${listed} 个 bot`);
    const shown = await again.$$eval(".chat-row", (items) => items.length);
    if (shown === 0) fail("重启后消息没有恢复");
    console.log(`✓ 重启后：${listed} 个 bot，默认打开的 bot ${shown} 条消息`);
    await stop();
} catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
} finally {
    await stop();
}
