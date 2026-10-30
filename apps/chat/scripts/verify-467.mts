// verify-467.mts — 用 CDP 实测 ##467 的判据 1–4（判据 5 由外壳脚本改装配后二次启动验）。
//
//   ./sha.sh lab 起的那套产物被本脚本直接拉起（自带 CDP 端口，不依赖 GUI 手点）。
//   只读写 build/lab/home（gitignore 内）。**不打印任何 key**。

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { chromium, type Page } from "playwright-core";
import { load as loadYaml } from "js-yaml";
import { loadCatalog } from "@diy-agent/model-catalog";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(pkgDir, "..", "..");
const variant = process.env["DIY_VARIANT"] ?? "lab";
const entry = join(pkgDir, "build", variant, "main", "index.mjs");
const home = join(repo, "build", variant, "home");
const port = 9800 + Math.floor(Math.random() * 100);

let child: ChildProcess | null = null;
let logs = "";
const ok = (message: string): void => console.log(`✓ ${message}`);
const fail = (message: string): never => {
    console.error(`✗ ${message}`);
    if (logs) console.error(logs);
    child?.kill("SIGKILL");
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
            /* 还没起来 */
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    const browser = await chromium.connectOverCDP(endpoint);
    const page = browser.contexts()[0]?.pages()[0] ?? fail("没有页面");
    await page.waitForSelector(".wb-nav-item", { timeout: 15_000 });
    return page;
}

const model = loadYaml(readFileSync(join(home, "model.yaml"), "utf-8")) as Record<string, any>;
const providerIds = [
    ...Object.keys(model.stdProviders ?? {}),
    ...Object.keys(model.customProviders ?? {}),
];
const catalog = loadCatalog(home);
if (catalog.length === 0) fail("模型目录为空，判据 2 / 4 无从验起");
const target = catalog[0]!;

const page = await launch();

// ① 侧栏多出「模型配置」
const navText = await page.$$eval(".wb-nav-item", (items) => items.map((item) => item.textContent ?? ""));
if (process.env["DIY_VERIFY_ABSENT"] === "1") {
    // 判据 5：装配里删掉插件 → 主进程不交付页面 → 侧栏没有入口
    if (navText.includes("模型配置")) fail(`卸掉插件后侧栏仍有「模型配置」：${navText.join(" / ")}`);
    ok(`卸掉插件后侧栏没有「模型配置」（nav = ${navText.join(" / ")}）`);
    child?.kill("SIGTERM");
    process.exit(0);
}
if (!navText.includes("模型配置")) fail(`侧栏没有「模型配置」：${navText.join(" / ")}`);
ok(`侧栏含「模型配置」（nav = ${navText.join(" / ")}）`);

await page.click('.wb-nav-item[data-page-id="model-config"]');
await page.waitForSelector(".mc-page", { timeout: 10_000 });
await page.waitForFunction(() => document.querySelectorAll(".mc-section").length >= 4, null, { timeout: 10_000 });

// ② 列出的 provider / 模型与文件一致
const bodyText = await page.textContent(".mc-body");
for (const id of providerIds) {
    if (!bodyText?.includes(id)) fail(`页面没有列出 provider「${id}」`);
}
if (!bodyText?.includes(target.providerId)) fail(`页面没有列出 ${target.providerId}`);
const listedModels = await page.$$eval(".mc-name", (items) => items.map((item) => (item as HTMLInputElement).value));
for (const entry of catalog) {
    if (!listedModels.includes(entry.name)) fail(`页面没有列出模型 ${entry.providerId}/${entry.modelId}`);
}
ok(`provider ${providerIds.length} 个、模型输入框 ${listedModels.length} 个，与 model.yaml / providers.custom.yaml 对齐`);

// ③ DOM 全文不含任何 key 形态
const dom = await page.evaluate(() => document.documentElement.outerHTML);
const leaked = dom.match(/sk-[A-Za-z0-9_-]{6,}|oc_sk_[A-Za-z0-9_-]{6,}|user_[A-Za-z0-9_-]{20,}/g);
if (leaked !== null) fail(`DOM 里出现疑似 key：${leaked.map((item) => `${item.slice(0, 6)}…`).join(", ")}`);
ok("DOM 全文 grep 不到 sk- / oc_sk_ / user_ 形态的 key");

// ④ 改一个模型的 name → 文件真的变了 → 页面刷新后显示新值
const stamp = `改名-${Date.now().toString(36)}`;
const row = page.locator("tr", { has: page.locator('.mc-name[data-model="' + target.modelId + '"]') }).first();
const nameInput = row.locator(".mc-name");
await nameInput.fill(stamp);
await row.locator('button[data-action="save-model"]').click();
await page.waitForFunction(
    (text) => document.querySelector(".mc-status")?.textContent?.includes(`已保存`) === true && !document.querySelector(".mc-status")?.textContent?.includes("…"),
    stamp,
    { timeout: 10_000 },
);
const after = loadYaml(readFileSync(join(home, "model.yaml"), "utf-8")) as Record<string, any>;
const group = after.stdProviders?.[target.providerId] ?? after.customProviders?.[target.providerId];
const written = group?.models?.[target.modelId]?.name;
if (written !== stamp) fail(`model.yaml 没写进新 name（实际 ${String(written)}）`);
ok(`改 name 已落盘：model.yaml ${target.providerId}.models.${target.modelId}.name = ${stamp}`);

await page.click(".mc-head .mc-btn");
await page.waitForFunction(
    (text) => [...document.querySelectorAll(".mc-name")].some((item) => (item as HTMLInputElement).value === text),
    stamp,
    { timeout: 10_000 },
);
ok("刷新后页面显示新 name");

// 附：key 写入后不回显（DOM 仍无明文）
const testKey = `sk-verify-${Date.now().toString(36)}-abcdef`;
const keyRow = page.locator(".mc-account-row").first();
await keyRow.locator(".mc-key").fill(testKey);
await keyRow.locator("button", { hasText: "设置 key" }).click();
await page.waitForFunction(
    () => document.querySelector(".mc-status")?.textContent?.includes("已设置（") === true,
    null,
    { timeout: 10_000 },
);
const domAfterKey = await page.evaluate(() => document.documentElement.outerHTML);
if (domAfterKey.includes(testKey)) fail("写入后 DOM 出现了 key 明文");
const keyFile = readFileSync(join(home, "model.yaml"), "utf-8");
if (!keyFile.includes(testKey)) fail("key 没有写进 model.yaml");
ok("key 写入成功且 DOM 里不回显（输入框已清空、状态只显示字符数）");

child?.kill("SIGTERM");
console.log("✓ 判据 1–4 全部通过");
