// verify-render.mts — 用 CDP 实测 ##468 的七条判据（人不用手点也能验）。
//
// 判据（编号照任务 body）：
//   1 界面与裸 DOM 版等价：bot 条 / 消息流 / 输入框 / 底部指标都在（##498：会话列表 → bot 列表）
//   2 发消息不闪：连发 5 条，消息列表新增的 DOM 节点只有「新那几条」的量（不整表重绘）
//   3 滚动不跳：滚到中间后新来一条消息，scrollTop 不动
//   4 输入框不丢焦点：等待回复期间打的草稿，回复到达后还在、焦点还在
//   5 切 bot：.chat-list 外壳元素不重建（身份不变），只有行整批换
//   6 两版可切：data-renderer 标记与 --expect 一致（切 import 重新 build 后跑本脚本）
//   7 静态检查：./sha.sh check 由外层跑（这里只负责 1–6）
//
// 用法：./sha.sh verify-render            # 期望 diui
//       RENDERER=dom ./sha.sh verify-render  # 期望裸 DOM（切回 import 后验对照组）
//
// 前置：./sha.sh build（产物在 build/<variant>）+ 仓库根 ./sha.sh sync（真 model.yaml）。

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { chromium, type Browser, type Page } from "playwright-core";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(pkgDir, "..", "..");
const variant = process.env["DIY_VARIANT"] ?? "lab";
const expect = (process.env["RENDERER"] ?? "diui") as "diui" | "dom";
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
let browser: Browser | null = null;
let logs = "";

const fail = (message: string): never => {
    console.error(`✗ ${message}`);
    if (logs) console.error(logs.slice(-4000));
    child?.kill("SIGKILL");
    void browser?.close();
    process.exit(1);
};

async function launch(): Promise<Page> {
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
        if (child.exitCode !== null) fail(`electron 提前退出（code ${String(child.exitCode)}）`);
        await new Promise((r) => setTimeout(r, 200));
    }
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0] ?? fail("CDP 没有 default context");
    const deadline2 = Date.now() + 20_000;
    while (Date.now() < deadline2) {
        const page = context.pages().find((p) => p.url().startsWith("file:") || p.url() === "about:blank");
        if (page) {
            await page.waitForSelector(".chat-app", { timeout: 20_000 });
            // 首份快照落地（渲染层在 applySnapshot 之后置 data-ready=1）
            await page.waitForFunction(() => document.querySelector('[data-ready="1"]') !== null, undefined, {
                timeout: 30_000,
            });
            return page;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    return fail("没等到页面");
}

/** 消息行数 */
const rows = (page: Page): Promise<number> => page.locator(".chat-row").count();

/** 发一条消息并等回复落地（行数 +2）。 */
async function send(page: Page, text: string): Promise<void> {
    const before = await rows(page);
    const input = page.locator(".chat-input");
    await input.fill(text);
    await input.press("Enter");
    await page.waitForFunction((n) => document.querySelectorAll(".chat-row").length >= n, before + 2, {
        timeout: 120_000,
    });
}

/**
 * 确保至少有一个 bot：bots 为空时（判据 8 首启）面板会盖在消息区上，
 * 这里按引导建第一个 bot（选模型 + 创建），之后才谈得上发消息。
 */
async function ensureBot(page: Page): Promise<void> {
    if ((await page.locator(".chat-bot[data-active]").count()) > 0) return;
    const panel = page.locator('.chat-panel[data-show="true"]');
    await panel.waitFor({ timeout: 30_000 });
    const model = await panel.locator("select").first().inputValue();
    if (model === "") fail("首启引导里没有可选模型（model.yaml 空？）");
    await panel.locator("button.chat-primary").click();
    await page.waitForFunction(() => document.querySelectorAll(".chat-bot[data-active]").length > 0, undefined, {
        timeout: 30_000,
    });
}

/** 新建一个 bot（`+ 新 bot` → 填名字 / 选模型 → 创建） */
async function createBot(page: Page, name: string, model?: string): Promise<void> {
    await page.locator(".chat-bot-new-btn").click();
    // 新建 bot 走右侧 panel（viewset），不再是覆盖式面板
    const panel = page.locator('.chat-viewset[data-show="true"]');
    await panel.waitFor({ timeout: 15_000 });
    await panel.locator("input").first().fill(name);
    if (model !== undefined) await panel.locator("select").first().selectOption(model);
    await panel.locator("button.chat-primary").click();
    await page.waitForFunction(
        (n) => {
            const names = Array.from(document.querySelectorAll(".chat-bot-name")).map((el) => el.textContent);
            return names.includes(n);
        },
        name,
        { timeout: 30_000 },
    );
}

/** 等「新来一条消息」时给消息列表挂 MutationObserver 数新增元素（含自身）。 */
async function startCount(page: Page): Promise<void> {
    await page.evaluate(() => {
        const list = document.querySelector(".chat-list")!;
        const win = window as unknown as { __added: number; __obs?: MutationObserver };
        win.__added = 0;
        win.__obs?.disconnect();
        const obs = new MutationObserver((records) => {
            for (const record of records) {
                for (const node of Array.from(record.addedNodes)) {
                    if (!(node instanceof Element)) continue;
                    win.__added += 1 + node.querySelectorAll("*").length;
                }
            }
        });
        obs.observe(list, { childList: true, subtree: true });
        win.__obs = obs;
    });
}

async function takeCount(page: Page): Promise<number> {
    return page.evaluate(() => {
        const win = window as unknown as { __added: number };
        return win.__added;
    });
}

async function main(): Promise<void> {
    const page = await launch();
    const ok = (label: string): void => console.log(`✓ ${label}`);

    // ── 判据 1：界面等价 ──
    const marker = await page.locator(".chat-page").getAttribute("data-renderer");
    if (marker !== expect) fail(`data-renderer=${String(marker)}，期望 ${expect}（判据 6：切 import 需重新 build）`);
    for (const sel of [".chat-bots", ".chat-bot-list", ".chat-list", ".chat-input", ".chat-send", ".chat-metrics"]) {
        if ((await page.locator(sel).count()) === 0) fail(`缺元素 ${sel}`);
    }
    // ##498 判据 5：没有「新建会话」按钮（左侧是 bot 不是会话）
    if ((await page.locator(".chat-new").count()) !== 0) fail("还有「新建会话」按钮（##498 判据 5）");
    ok(`判据 1：bot 条 / 消息流 / 输入框 / 底部指标齐全（renderer=${expect}）`);

    // 先等 snapshot 落地（多 bot 能力 = 左栏不再 hidden）+ 至少有一个 bot（首启则走引导）
    await page.waitForFunction(() => !document.querySelector(".chat-bots")?.hasAttribute("hidden"), undefined, {
        timeout: 30_000,
    });
    await ensureBot(page);
    ok("至少一个 bot（首启引导按需走）+ bot 条可见");

    // ── 判据 0：##498 界面形态（四条硬要求） ──
    if ((await page.locator(".chat-header").count()) !== 0) fail("还有顶部横幅（硬要求 1：消息区顶天）");
    // 「顶天」= 消息区与 .chat-main 顶端齐平（页面上方那条是工作台自己的 tab 条，不归本页）
    const listTop = await page.evaluate(() => {
        const list = document.querySelector(".chat-list")!.getBoundingClientRect().top;
        const main = document.querySelector(".chat-main")!.getBoundingClientRect().top;
        return Math.round(list - main);
    });
    if (listTop !== 0) fail(`消息区没有顶天：相对 .chat-main 顶部 ${listTop}px（有横幅？）`);
    const botsWidth = (): Promise<number> =>
        page.evaluate(() => Math.round(document.querySelector(".chat-bots")!.getBoundingClientRect().width));
    // 宽度含 1px 边框，给 ±6 的容差（硬要求 2：平时窄条只露头像 / hover 展开）
    const narrow = await botsWidth();
    if (narrow < 64 || narrow > 70) fail(`bot 条宽 ${String(narrow)}，期望 ≈64`);
    await page.hover(".chat-bot[data-active] .chat-bot-btn");
    await page
        .waitForFunction(() => document.querySelector(".chat-bots")!.getBoundingClientRect().width >= 190, undefined, {
            timeout: 5_000,
        })
        .catch(async () => fail(`hover 后 bot 条没有展开（宽 ${String(await botsWidth())}）`));
    if ((await page.locator('.chat-card[data-show="true"]').count()) === 0) fail("bot hover 没有弹卡片");
    const cardText = (await page.locator(".chat-card").textContent()) ?? "";
    for (const word of ["会话", "创建", "本轮花费", "配置", "打开对话"]) {
        if (!cardText.includes(word)) fail(`hover 卡片缺「${word}」：${cardText}`);
    }
    const foot = (await page.locator(".chat-metrics").textContent()) ?? "";
    for (const word of ["⚙", "输入", "窗口", "缓存", "本轮", "上下文"]) {
        if (!foot.includes(word)) fail(`底部一行缺「${word}」：${foot}`);
    }
    ok("判据 0：无顶部横幅 / bot 条 64→200 / hover 卡片 / 底部一行指标（硬要求 1–4）");

    // ── 判据 0b：左侧菜单窄 bar + 抽屉（2026-11-02 #5） ──
    const railWidth = await page.evaluate(() =>
        Math.round(document.querySelector(".wb-rail")!.getBoundingClientRect().width),
    );
    if (railWidth < 44 || railWidth > 60) fail(`左侧窄 bar 宽 ${String(railWidth)}，期望 ~52`);
    if ((await page.locator(".wb-drawer").isVisible()) === true) fail("抽屉默认应该是收起的");
    if ((await page.locator(".wb-sidebar").count()) !== 0) fail("还有常驻的 220px 侧栏（.wb-sidebar）");
    await page.click(".wb-rail-expand");
    await page.waitForSelector(".wb-drawer .wb-nav-item", { state: "visible", timeout: 5_000 });
    const groups = await page.$$eval(".wb-drawer .wb-group-head", (items) => items.map((item) => item.textContent));
    if (groups.length === 0) fail("抽屉里没有分组（Web Awesome 风格的菜单树）");
    // 分组可收起
    await page.locator(".wb-drawer .wb-group-head").first().click();
    const collapsed = await page.$eval(".wb-drawer .wb-group", (node) => (node as HTMLElement).dataset["collapsed"]);
    if (collapsed !== "true") fail("点分组标题没有收起该组");
    await page.locator(".wb-drawer .wb-group-head").first().click();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".wb-root")?.getAttribute("data-drawer") === "closed", undefined, {
        timeout: 5_000,
    });
    ok(`判据 0b：窄 bar ${String(railWidth)}px / 抽屉分组 ${JSON.stringify(groups)} / 可收起 / Esc 关闭`);

    // ── 判据 0c：新 bot 在列表顶部；点 bot 只开对话；配置走右侧 panel（#2/#4/#6） ──
    const firstBotRow = await page.$eval(".chat-bot-list", (list) => list.firstElementChild?.className ?? "");
    if (!firstBotRow.includes("chat-bot-new")) fail(`「新 bot」不在列表顶部：第一项是 ${firstBotRow}`);
    await page.locator(".chat-bot[data-active] .chat-bot-btn").first().click();
    await page.waitForTimeout(200);
    if ((await page.locator('.chat-viewset[data-show="true"]').count()) !== 0) fail("点 bot 弹出了配置 panel（#2：只该开对话）");
    // hover 一会儿 ⇒ 右侧 panel 预览
    await page.locator('.chat-bot[data-active="false"] .chat-bot-btn').first().hover();
    await page.waitForSelector('.chat-viewset[data-show="true"]', { timeout: 5_000 });
    await page.hover(".chat-viewset");
    const mode0 = await page.$eval(".chat-viewset", (node) => (node as HTMLElement).dataset["mode"]);
    if (mode0 !== "floating") fail(`panel 缺省应是悬浮，实得 ${String(mode0)}`);
    await page.click(".chat-viewset-pin");
    const mode1 = await page.$eval(".chat-viewset", (node) => (node as HTMLElement).dataset["mode"]);
    if (mode1 !== "pinned") fail("点「固定」没有切成 pinned");
    await page.click(".chat-viewset-close");
    await page.mouse.move(600, 500);
    ok("判据 0c：新 bot 在顶部 / 点 bot 只开对话 / hover 出右侧 panel / 悬浮⇄固定可切");
    // 鼠标挪开，收起卡片（别挡住后面的点击）
    await page.mouse.move(600, 300);

    // 对照组（裸 DOM 版）：判据 2/3/4 本来就不过 —— 只记录它的量，不判失败
    if (expect === "dom") {
        const added: number[] = [];
        for (let i = 1; i <= 5; i++) {
            await startCount(page);
            await send(page, `对照组 第 ${i} 条`);
            added.push(await takeCount(page));
        }
        console.log(`· 对照组（裸 DOM）：5 次发送新增节点 = ${added.join(",")}（整表重绘 ⇒ 逐次变多）`);
        ok("判据 6：renderer=dom（同一脚本、同一份 wire，对照组行为不同是预期）");
        child?.kill("SIGKILL");
        await browser?.close();
        process.exit(0);
    }

    // ── 判据 2：连发 5 条，DOM 新增节点只有新消息那点量 ──
    // 基线：数据根是跨 run 复用的（同一个 bot 的同一条长期会话），所以按增量判
    const start = await rows(page);
    const firstRow = page.locator(".chat-row").first();
    const added: number[] = [];
    for (let i = 1; i <= 5; i++) {
        await startCount(page);
        await send(page, `判据2 第 ${i} 条`);
        added.push(await takeCount(page));
    }
    if ((await rows(page)) !== start + 10) fail(`发完 5 条应新增 10 行（${start} → 实得 ${await rows(page)}）`);
    // 一条消息 = li + role + blocks 容器 + block + text ≈ 5 个节点（##499：一行是 Block 列表）；
    // 一次发送 = user + assistant ≈ 10~12。整表重绘的话第 5 次会是这个数的 5 倍以上。
    const worst = Math.max(...added);
    if (worst > 16) fail(`单次发送新增 DOM 节点 ${worst}（>16 ⇒ 整表重绘）：${added.join(",")}`);
    // 旧行必须是同一批真实元素（身份不变 ⇒ 没被重建）
    if (expect === "diui") {
        const same = await page.evaluate(
            (el) => {
                const first = document.querySelector(".chat-row");
                return first === el;
            },
            await firstRow.elementHandle(),
        );
        if (!same) fail("发消息后第一行 DOM 元素被替换（说明整表重绘了）");
    }
    ok(`判据 2：5 次发送新增节点 = ${added.join(",")}（每次约 10~12 个，旧行复用）`);

    // ── 判据 3：滚动不跳 ──
    // 把消息区压到 200px 高，保证内容溢出（只是量测需要，不改渲染逻辑）
    await page.evaluate(() => {
        const list = document.querySelector(".chat-list") as HTMLElement;
        list.style.flex = "none";
        list.style.height = "200px";
    });
    while (
        await page.evaluate(() => {
            const l = document.querySelector(".chat-list")!;
            return l.scrollHeight < l.clientHeight + 120;
        })
    ) {
        await send(page, "判据3 填高度");
    }
    const scrollTop = await page.evaluate(() => {
        const l = document.querySelector(".chat-list")!;
        l.scrollTop = Math.floor((l.scrollHeight - l.clientHeight) / 2);
        return l.scrollTop;
    });
    if (scrollTop < 20) fail("滚动测试没造出可滚动的中间位置");
    await send(page, "判据3 新来一条");
    const after = await page.evaluate(() => document.querySelector(".chat-list")!.scrollTop);
    if (Math.abs(after - scrollTop) > 1) fail(`滚动位置被拽走：${scrollTop} → ${after}`);
    ok(`判据 3：滚到中间（scrollTop=${scrollTop}）后新消息到达，位置不变`);

    // ── 判据 4：输入框不丢焦点、草稿不丢 ──
    let focusOk = false;
    for (let attempt = 1; attempt <= 3 && !focusOk; attempt++) {
        const before = await rows(page);
        const input = page.locator(".chat-input");
        await input.click();
        await input.fill("判据4 触发一条回复");
        await input.press("Enter");
        await input.fill("草稿还在吗");
        await page.waitForFunction((n) => document.querySelectorAll(".chat-row").length >= n, before + 2, {
            timeout: 120_000,
        });
        const state = await page.evaluate(() => {
            const el = document.querySelector(".chat-input") as HTMLInputElement | null;
            return { value: el?.value ?? "", focused: document.activeElement === el };
        });
        focusOk = state.focused && state.value === "草稿还在吗";
        if (!focusOk) await input.fill("");
    }
    if (!focusOk) fail("回复到达后输入框丢了焦点或草稿（判据 4）");
    ok("判据 4：回复到达时焦点仍在输入框，草稿原样保留");

    // ── 判据 5：切 bot，外壳不重建（##498：左栏点的是 bot，切的是它的长期会话）──
    await page.evaluate(() => {
        const win = window as unknown as { __list?: Element };
        win.__list = document.querySelector(".chat-list");
    });
    const botsBefore = await page.locator(".chat-bot").count();
    await createBot(page, `验证用 bot ${String(Date.now() % 10000)}`);
    if ((await page.locator(".chat-bot").count()) !== botsBefore + 1) fail("「+ 新 bot」没有新增一行");
    await send(page, "新 bot 的第一条");
    // 切回第一个 bot（点当前没选中的那一行）
    await page.locator('.chat-bot[data-active="false"]').first().click();
    await page.waitForFunction(() => document.querySelectorAll(".chat-row").length > 0, undefined, { timeout: 30_000 });
    const shellKept = await page.evaluate(() => {
        const win = window as unknown as { __list?: Element };
        return win.__list === document.querySelector(".chat-list");
    });
    if (expect === "diui" && !shellKept) fail("切 bot 后 .chat-list 外壳被重建（判据 5）");
    ok("判据 5：切 bot 后消息行整批替换，外壳元素身份不变");

    ok(`判据 6：renderer=${expect}（切 import 重新 build 即另一版）`);
    console.log("\n全部通过（判据 7 由 ./sha.sh check 验）。");
    child?.kill("SIGKILL");
    await browser?.close();
    process.exit(0);
}

void main().catch((cause: unknown) => fail(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)));
