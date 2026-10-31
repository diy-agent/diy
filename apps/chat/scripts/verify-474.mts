// verify-474.mts — 用 CDP 实测 ##474 的判据 1 / 3 / 4（判据 2/5/6 由单测与 check 覆盖）。
//
//   ① 侧栏出现「Bot 配置」（装配里装了插件才有）
//   ② 新建一个 bot，写入 bots/<id>/bot.json（页面上看到列表多一行）
//   ③ 配置页的「测试对话」收到**真模型**回复
//   ④ 说完话后 $DIY_HOME 下不出现任何新文件（find -newer 的等价物：前后文件清单比对）
//
// 不打印任何 key；只读写 build/lab/home（gitignore 内）。

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { chromium, type Page } from "playwright-core";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const variant = process.env["DIY_VARIANT"] ?? "lab";
const entry = join(pkgDir, "build", variant, "main", "index.mjs");
const home = join(pkgDir, "..", "..", "build", variant, "home");
const port = 9700 + Math.floor(Math.random() * 100);

if (!existsSync(entry)) {
    console.error(`✗ 产物不存在：${entry}（先跑 ./sha.sh build）`);
    process.exit(1);
}
if (!existsSync(join(home, "model.yaml"))) {
    console.error(`✗ 数据根缺 model.yaml：${home}`);
    process.exit(1);
}

let child: ChildProcess | null = null;
let logs = "";
const ok = (message: string): void => console.log(`✓ ${message}`);
const fail = (message: string): never => {
    console.error(`✗ ${message}`);
    if (logs) console.error(logs);
    child?.kill("SIGKILL");
    process.exit(1);
};

/** 递归列出文件（相对路径 + mtime；给判据 4 前后比对用） */
function listFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
        let items;
        try {
            items = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const item of items) {
            const rel = prefix === "" ? item.name : `${prefix}/${item.name}`;
            if (item.isDirectory()) walk(join(dir, item.name), rel);
            else out.push(`${rel}@${statSync(join(dir, item.name)).mtimeMs}`);
        }
    };
    walk(root, "");
    return out.sort();
}

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
            /* 还没起来 */
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    const browser = await chromium.connectOverCDP(endpoint);
    const page = browser.contexts()[0]?.pages()[0] ?? fail("没有页面");
    await page.waitForSelector(".wb-nav-item", { timeout: 15_000 });
    return page;
}

const page = await launch();

// ① 侧栏
const navText = await page.$$eval(".wb-nav-item", (items) => items.map((item) => item.textContent ?? ""));
if (process.env["DIY_VERIFY_ABSENT"] === "1") {
    if (navText.includes("Bot 配置")) fail(`卸掉插件后侧栏仍有「Bot 配置」：${navText.join(" / ")}`);
    ok(`卸掉插件后侧栏没有「Bot 配置」（nav = ${navText.join(" / ")}）`);
    child?.kill("SIGTERM");
    process.exit(0);
}
if (!navText.includes("Bot 配置")) fail(`侧栏没有「Bot 配置」：${navText.join(" / ")}`);
ok(`侧栏含「Bot 配置」（nav = ${navText.join(" / ")}）`);

await page.click('.wb-nav-item[data-page-id="bot-config"]');
await page.waitForSelector(".bc-page", { timeout: 10_000 });
await page.waitForFunction(() => document.querySelectorAll(".bc-section").length >= 3, null, {
    timeout: 10_000,
});

// ② 新建 bot
const stamp = Date.now();
const botName = `验收bot-${stamp}`;
await page.fill('input[name="name"]', botName);
await page.fill("textarea", "你是验收用的助手，回答只许一句。");
// 选第一个具体模型（第一项是「跟随缺省」）
await page.evaluate(() => {
    const select = document.querySelector("select") as HTMLSelectElement | null;
    if (select !== null && select.options.length > 1) select.selectedIndex = 1;
});
await page.click(".bc-form-actions .bc-btn");
await page.waitForFunction(
    (name) => document.querySelector(".bc-status")?.textContent?.includes(`已新建 bot「${name}」`) === true,
    botName,
    { timeout: 15_000 },
);
const botsDir = join(home, "bots");
const created = readdirSync(botsDir).filter((id) => id.startsWith("bot-"));
ok(`新建 bot 成功（bots/ 里有 ${created.length} 个 bot：${created.join(", ")}）`);

// 判据 2：改 name / instructions 并保存（贴 bot.json 关键字段的 diff）
const botId = created.sort().at(-1)!;
const botFile = join(botsDir, botId, "bot.json");
const beforeEdit = JSON.parse(readFileSync(botFile, "utf-8")) as Record<string, unknown>;
const renamed = `${botName}-改`;
await page.fill('input[name="name"]', renamed);
await page.fill("textarea", "你是改过之后的验收助手，回答只许一句。");
await page.click(".bc-form-actions .bc-btn");
await page.waitForFunction(
    (name) => document.querySelector(".bc-status")?.textContent?.includes(`已保存「${name}」`) === true,
    renamed,
    { timeout: 15_000 },
);
const afterEdit = JSON.parse(readFileSync(botFile, "utf-8")) as Record<string, unknown>;
if (afterEdit["name"] !== renamed) fail(`改名未写入：${String(afterEdit["name"])}`);
if (afterEdit["createdAt"] !== beforeEdit["createdAt"]) fail("保存改了 createdAt（应该不变）");
if (afterEdit["updatedAt"] === beforeEdit["updatedAt"]) fail("保存没刷新 updatedAt");
ok(
    `编辑保存生效：name ${String(beforeEdit["name"])} → ${String(afterEdit["name"])}；` +
        `instructions 已更新；createdAt 不变（${String(afterEdit["createdAt"])}）`,
);

// 判据 4 的基线：新建 bot 之后再记一次文件清单（bot.json 本身是预期写入）
const before = listFiles(home);

// ③ 测试对话（真模型）
await page.fill('input[name="test"]', "用一句话回答：1+1 等于几？");
await page.click(".bc-test-input .bc-btn");
await page.waitForFunction(() => document.querySelectorAll(".bc-test-row").length >= 2, null, {
    timeout: 120_000,
});
const rows = await page.$$eval(".bc-test-row", (items) =>
    items.map((item) => ({
        role: item.querySelector(".bc-test-role")?.textContent ?? "",
        text: item.querySelector(".bc-test-text")?.textContent ?? "",
    })),
);
if (rows.length < 2) fail(`测试对话只有 ${rows.length} 行`);
if (rows[0]?.role !== "我") fail(`第一行不是用户消息：${JSON.stringify(rows[0])}`);
if ((rows[1]?.text ?? "").trim() === "") fail("assistant 回复为空");
ok(`测试对话收到回复：${(rows[1]?.text ?? "").slice(0, 40)}`);

// ④ 零落盘：前后文件清单必须一致
const after = listFiles(home);
const added = after.filter((item) => !before.includes(item));
if (added.length > 0) fail(`测试对话后 DIY_HOME 下出现了新文件：${added.join(", ")}`);
ok("测试对话零落盘：$DIY_HOME 前后文件清单一致（判据 4）");

child?.kill("SIGTERM");
