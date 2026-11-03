import { spawn } from "node:child_process";
import { join } from "node:path";
import electronPath from "electron";
import { chromium } from "playwright-core";

const pkgDir = "/Users/ccc/git/diy/diy/apps/chat";
const home = "/Users/ccc/git/diy/diy/build/lab/home";
const port = 9885;
const child = spawn(electronPath as unknown as string, [join(pkgDir, "build/lab/main/index.mjs"), `--remote-debugging-port=${port}`], {
  env: { ...process.env, DIY_VARIANT: "lab", DIY_HOME: home }, stdio: ["ignore", "pipe", "pipe"],
});
child.stderr?.on("data", (b) => process.stderr.write(b));
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 200));
}
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0]!.pages().find((p) => p.url().startsWith("file:"))!;
await page.waitForSelector(".chat-app");
await page.waitForFunction(() => document.querySelector('[data-ready="1"]') !== null, null, { timeout: 30000 });

const state = () => page.evaluate(() => ({
  rows: document.querySelectorAll(".chat-row").length,
  tool: document.querySelectorAll(".chat-block-tool").length,
  inputDisabled: (document.querySelector(".chat-input") as HTMLInputElement | null)?.disabled,
  sendDisabled: (document.querySelector(".chat-send") as HTMLButtonElement | null)?.disabled,
  bot: document.querySelector(".chat-bot[data-active] .chat-bot-name")?.textContent,
  viewset: document.querySelector(".chat-viewset")?.getAttribute("data-show"),
}));
console.log("start", await state());

// 先跑一次 /demo-tool（模拟 verify 的 0d）
await page.fill(".chat-input", "/demo-tool");
await page.press(".chat-input", "Enter");
await page.waitForTimeout(1200);
console.log("after demo", await state());

// 再发一条真消息
await page.fill(".chat-input", "判据2 第 1 条");
await page.press(".chat-input", "Enter");
console.log("after enter", await state());
for (const t of [1000, 3000, 6000]) { await page.waitForTimeout(t); console.log(`after ${t}ms`, await state()); }
child.kill("SIGKILL");
await browser.close();
process.exit(0);
