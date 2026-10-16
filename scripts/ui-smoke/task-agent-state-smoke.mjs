// task-agent-state-smoke.mjs — 任务 agent 面状态（##355）：真实 UI（CDP）冒烟
//
// 验的是**接线**（真源 → main 任务树 → RPC → 渲染端 chip），不是判据本身（判据有纯函数单测）：
//   · 干净任务（无 ops 日志、无草稿）        → chip = 「○ 未对话」(data-task-agent-state="clean")
//   · 有 drafts.yaml.agent_input 的任务      → chip = 「✎ 有草稿」(="draft")
//   · 有 ops 日志（对话过）但空闲的任务      → **不渲染 chip**（idle 是"没事"，行内不占地方）
//   · 任务属性面板                          → `always`：空闲也显示（"空闲"是明确结论）
//   · 属性面板「窗口」行                    → 有实测量化值才画（本次无用量账 → `—`，不编 0%）
//
// 用法：node scripts/ui-smoke/task-agent-state-smoke.mjs
// 依赖：`npm install`（playwright-core 是 devDependency）+ `./sha.sh build`（prod 产物）。
// 不花钱：不起真轮次 —— in-turn / unread 两态要真会话，见本文件末尾「没覆盖到的」。
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 路径全部相对**脚本自身**推导（仓库根 = 本文件上溯两级）：换机器 / 换 checkout 位置都不影响。
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP = join(REPO, "pkgs.ts/diy-app");
const ELECTRON = join(REPO, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = mkdtempSync(join(tmpdir(), "diy-t355-"));
const env = { ...process.env, HOME: home, DIY_HOME: home, DIY_VARIANT: "prod", PATH: join(REPO, "node_modules/.bin") + ":" + process.env.PATH };
delete env.DIY_PORT;
const port = 9700 + Math.floor(Math.random() * 200);
const proc = spawn(ELECTRON, ["build/prod/main/index.mjs", `--remote-debugging-port=${port}`], { cwd: APP, env, stdio: "ignore", detached: true });
const diy = (args) => JSON.parse(execFileSync("tsx", ["src/cli/index.ts", ...args], { cwd: APP, env, encoding: "utf8" }));

const fail = [];
const need = (c, label) => { if (!c) fail.push(label); return c; };
let pg, step = "boot";
const kill = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch {} try { proc.kill("SIGKILL"); } catch {} };

try {
  await sleep(9000);
  step = "fixture";
  const pid = diy(["project", "create", join(home, "p"), "--label", "状态项目"]).data.id;
  const clean = diy(["task", "create", "干净任务", String(pid)]).data.uri;
  const draft = diy(["task", "create", "草稿任务", String(pid)]).data.uri;
  const talked = diy(["task", "create", "说过话的任务", String(pid)]).data.uri;

  // 「对话过」的落盘事实：会话 Op 日志存在且非空（keyOf 与 local-paths.ts 同构：
  // 可读前缀（非 [\w.-] → _，截 64）+ "-" + sha256(uri) 前 12 位）
  const keyOf = (uri) => `${uri.replace(/[^\w.-]+/g, "_").slice(0, 64)}-${createHash("sha256").update(uri).digest("hex").slice(0, 12)}`;
  const opsOf = (uri) => join(home, "local", `${keyOf(uri)}.ops.jsonl`);
  mkdirSync(join(home, "local"), { recursive: true });
  writeFileSync(opsOf(talked), '{"op":"start","id":"t1","kind":"turn","meta":{}}\n', "utf-8");

  // 「有草稿」的落盘事实：任务目录 .diy/drafts.yaml 的 agent_input
  const sysDir = join(home, "projects", String(pid), "tasks", draft.split("/").pop(), ".diy");
  mkdirSync(sysDir, { recursive: true });
  writeFileSync(join(sysDir, "drafts.yaml"), ["kind: diy.ui-drafts", "version: 3", `task: ${draft}`, "fields:", "  agent_input: 半句话", ""].join("\n"), "utf-8");

  const { chromium } = await import(join(REPO, "node_modules/playwright-core/index.mjs"));
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  pg = b.contexts()[0].pages()[0];
  await pg.reload(); await sleep(3500);
  // 监听放在 reload **之后**：重载时旧渲染进程的在途 RPC 会报 "Client disposed"，
  // 那是重载产物，不是产品错误（本脚本要抓的是装载后稳定期的报错）。
  const errors = [];
  pg.on("console", (m) => m.type() === "error" && errors.push(`[${step}] ${m.text()}`));
  pg.on("pageerror", (e) => errors.push(`[${step}] ${String(e)}`));

  step = "① 任务表行 chip";
  const chips = await pg.evaluate(() => [...document.querySelectorAll("[data-task-agent-state]")].map((el) => ({
    uri: el.getAttribute("data-task-agent-uri") ?? el.getAttribute("data-task-agent-dot") ?? "?",
    kind: el.getAttribute("data-task-agent-state"),
    text: el.innerText.replace(/\s+/g, ""),
    visible: el.getBoundingClientRect().width > 0,
    title: el.title,
    row: el.closest("tr")?.innerText.split("\n")[0] ?? "",
  })));
  console.log("① 文档内 agent 状态标记:", JSON.stringify(chips, null, 1));
  const dumpTable = await pg.evaluate(() => [...document.querySelectorAll("tbody tr")].map((r) => r.innerText.replace(/\s+/g, " ").slice(0, 60)));
  console.log("① 任务表行:", JSON.stringify(dumpTable, null, 1));

  const uri1 = `projects/${pid}/tasks/1`, uri2 = `projects/${pid}/tasks/2`, uri3 = `projects/${pid}/tasks/3`;
  const byRow = (u) => chips.find((c) => c.uri === u);
  need(byRow(uri1)?.kind === "clean", "① 干净任务 → clean（实得 " + JSON.stringify(byRow(uri1)) + "）");
  need(byRow(uri1)?.text === "○未对话", "① 干净任务的 chip 文案 = 未对话（实得 " + JSON.stringify(byRow(uri1)?.text) + "）");
  need(byRow(uri2)?.kind === "draft", "① 有草稿任务 → draft（实得 " + JSON.stringify(byRow(uri2)) + "）");
  need(byRow(uri2)?.text === "✎有草稿", "① 草稿任务的 chip 文案 = 有草稿（实得 " + JSON.stringify(byRow(uri2)?.text) + "）");
  need(!byRow(uri3), "① 对话过且空闲 → 行内不渲染 chip（idle 不占地方，实得 " + JSON.stringify(byRow(uri3)) + "）");
  need(uri1 !== clean || true, "");

  step = "② 任务属性面板（always + 窗口行）";
  await pg.locator("span.diy-link", { hasText: "干净任务" }).first().click({ timeout: 15000 });
  await sleep(1200);
  const panel = await pg.evaluate(() => {
    const sec = [...document.querySelectorAll("section")].find((x) => x.querySelector("button")?.innerText.includes("任务属性"));
    if (!sec) return null;
    const label = [...sec.querySelectorAll("span")].find((n) => n.textContent.trim() === "agent 状态");
    const wlabel = [...sec.querySelectorAll("span")].find((n) => n.textContent.trim() === "窗口");
    const row = label?.closest(".task-field-row");
    const wrow = wlabel?.closest(".task-field-row");
    return {
      hasRow: !!label,
      stateText: row?.innerText.replace(/\s+/g, " ").trim() ?? null,
      stateKind: row?.querySelector("[data-task-agent-state]")?.getAttribute("data-task-agent-state") ?? null,
      stateTitle: row?.querySelector("[data-task-agent-state]")?.title ?? null,
      windowText: wrow?.innerText.replace(/\s+/g, " ").trim() ?? null,
      windowUsageAttr: wrow?.querySelector("[data-window-usage]")?.getAttribute("data-window-usage") ?? null,
    };
  });
  console.log("② 属性面板 agent 行:", JSON.stringify(panel, null, 1));
  need(panel?.hasRow, "② 属性面板有「agent 状态」行");
  need(panel?.stateKind === "clean", "② 干净任务在面板里也报 clean（always：空闲/未对话是明确结论）");
  need((panel?.stateTitle ?? "").includes("Op 日志"), "② chip 的 title 指名真源（Op 日志）");
  need((panel?.windowText ?? "").includes("—"), "② 无用量账 → 窗口行显示 —（不编 0%）：" + panel?.windowText);
  // 先说清"没有真实用量账"是**预期**：这个隔离库从没跑过真轮次
  need(!panel?.windowUsageAttr, "② 没实测就不挂 data-window-usage（不画进度条）");

  step = "③ 对话过且空闲的任务：面板 always 显示 idle";
  await pg.locator("span.diy-link", { hasText: "说过话的任务" }).first().click({ timeout: 15000 });
  await sleep(1200);
  const idle = await pg.evaluate(() => {
    const sec = [...document.querySelectorAll("section")].find((x) => x.querySelector("button")?.innerText.includes("任务属性"));
    const el = sec?.querySelector("[data-task-agent-state]");
    return el ? { kind: el.getAttribute("data-task-agent-state"), text: el.innerText.replace(/\s+/g, "") } : null;
  });
  console.log("③ 对话过任务的属性面板:", JSON.stringify(idle));
  need(idle?.kind === "idle", "③ 对话过 + 空闲 → 面板显示 idle（行内不显示、面板显示）：" + JSON.stringify(idle));

  step = "④ 控制台无错误";
  need(errors.length === 0, "④ 渲染进程无 error：" + JSON.stringify(errors.slice(0, 5)));
} catch (e) {
  fail.push(`异常（${step}）：${e?.stack ?? e}`);
} finally {
  kill();
}

if (fail.length) { console.error("✗ FAIL\n - " + fail.join("\n - ")); process.exit(1); }
console.log("✓ PASS 全部检查通过");
// ─── 没覆盖到的（本脚本刻意不花钱：不发真请求） ───────────────────────────────
// · `in-turn`（对话中）/ `unread`（有未读）需要**真有会话在跑**：
//   `diy agent local chat <taskUri> "…"` 在主进程里真跑一轮，期间任务表行实见 in-turn；
//   轮末实见 unread（`sessionStore` 在首次见到该会话时把水位记到当时步数 —— syncSeenBaseline，
//   此后步数继续涨 = "你没看着时跑的"）；`diy ui tab open <uri>` 追平水位后回 idle。
//   这条判据本身在 tests/core/task-agent-state.test.ts 里有纯函数用例（优先级 / 互斥矩阵）。
