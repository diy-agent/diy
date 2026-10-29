// tests/cli.intent.ui-usage.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 ##443 刀 3：用量表「一个入口 + group 切粒度」的真机验收
//
// 守的三件事（都是本刀的核心承诺，坏一条就是口径/形态回退）：
//   ① **四视角合计一致**：同一个会话在 step / turn / persona / session 下，
//      合计行的 `合计$` 必须是同一个数（同源同口径，见 shared/usage-fields.ts）。
//   ② **下钻是同一张表换参数**：点 turn 行 → 只剩该轮的步；面包屑「返回」回到轮视图。
//   ③ **窗口构成是另一个 group 视图**，不是独立表：有「系统提示词」列、**没有合计行**（构成不可加）。
//
// 种子是**固定数字**（0.2 + 0.2 + 0.1 = 0.5），因此断言能写死到字形（`$0.5000`），
// 不靠"看起来差不多"。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { sessionFileRel } from "../src/main/core/local-paths";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";

const NL = String.fromCharCode(10);

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
let uri = "";

beforeAll(async () => {
  const electron = await startElectronTest();
  const HOME = electron.home;
  fx = {
    electron,
    HOME,
    sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
  };
  const p = await fx.sh.getJson(`./diy.sh project create ${HOME}/usage --label 用量`);
  const pid = String((p.data as any)?.data?.id);
  const t = await fx.sh.getJson(`./diy.sh task create 用量四级视图 ${pid}`);
  uri = String((t.data as any)?.data?.uri);
  seedUsage(uri);
  ui = await makeUiDriver(electron.cdpUrl, async () => {
    const r = await fx.sh.getJson("./diy.sh ui inspect");
    return (r.data as any)?.data?.tree as A11yNode | undefined;
  });
  await ui.bringToFront();
  await openDrawer();
}, 180_000);

afterAll(async () => {
  ui?.close();
  await fx?.electron?.stop();
});

/** 一步的账本行（形状照 `StepUsageRecord`；数字是写的，不是算的） */
function step(turnId: string, n: number, o: { persona: string; noCache: number; cost: number; ts: string }) {
  const out = 10;
  return {
    ts: o.ts,
    turnId,
    step: n,
    persona: o.persona,
    model: "m-a",
    apiFace: "chat",
    contextLimit: 1_000_000,
    usage: {
      inputTokens: o.noCache,
      inputTokenDetails: { noCacheTokens: o.noCache, cacheReadTokens: 0, cacheWriteTokens: null },
      outputTokens: out,
      outputTokenDetails: { textTokens: out, reasoningTokens: 0 },
      totalTokens: o.noCache + out,
    },
    performance: { stepTimeMs: 1000, responseTimeMs: 900, timeToFirstOutputMs: 300 },
    cost: { noCache: o.cost, cacheRead: 0, cacheWrite: null, text: 0, reasoning: 0, total: o.cost },
    // 构成只给第一步 —— 顺带验证「老步缺构成 → –」不炸
    ...(n === 1 ? { contextParts: { systemBytes: 4000, toolsBytes: 400 } } : {}),
  };
}

/**
* 种三步两轮（含两个人物）：
*   t1: step1(p1, 0.2) + step2(p1, 0.2)   → 轮合计 0.4
*   t2: step1(p2, 0.1)                    → 轮合计 0.1
*   会话合计 = 0.5（四视角必须都是这个数）
*/
function seedUsage(taskUri: string): void {
  const rows = [
    step("t1767225600000", 1, { persona: "persona/1", noCache: 1000, cost: 0.2, ts: "2026-01-01T00:00:00.000Z" }),
    step("t1767225600000", 2, { persona: "persona/1", noCache: 2000, cost: 0.2, ts: "2026-01-01T00:00:05.000Z" }),
    step("t1767225601000", 1, { persona: "persona/2", noCache: 3000, cost: 0.1, ts: "2026-01-01T00:01:00.000Z" }),
  ];
  const fp = join(fx.HOME, sessionFileRel(taskUri, "usage"));
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, rows.map((r) => JSON.stringify(r)).join(NL) + NL, "utf-8");

  // ops：让会话页有内容可上屏（否则 tab 打开是空页，点不到 chip）
  const tid = "t1767225600000";
  const ops = [
    { op: "start", id: tid, kind: "turn" },
    { op: "start", id: `${tid}_u`, kind: "text", parent: tid, meta: { role: "user" } },
    { op: "delta", id: `${tid}_u`, fields: { content: "种子问题：四级视图" } },
    { op: "stop", id: `${tid}_u` },
    { op: "stop", id: tid },
  ];
  const fp2 = join(fx.HOME, sessionFileRel(taskUri, "ops"));
  mkdirSync(dirname(fp2), { recursive: true });
  writeFileSync(fp2, ops.map((o) => JSON.stringify(o)).join(NL) + NL, "utf-8");
}

/** 打开任务页 → 点会话累计 chip 开用量抽屉 */
async function openDrawer(): Promise<void> {
  await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
  await waitUntil(
    () => ui.query<boolean>(`document.body.textContent.includes(${JSON.stringify("种子问题：四级视图")})`),
    (v) => v,
    { label: "会话上屏", timeoutMs: 20_000 },
  );
  await ui.clickSelector('[aria-label^="会话累计用量"]');
  await waitUntil(
    () => ui.query<boolean>(`!!document.querySelector('[data-usage-group="step"]')`),
    (v) => v,
    { label: "用量抽屉打开", timeoutMs: 20_000 },
  );
}

/** 切 group（点按钮后等表格按新粒度重排） */
async function pick(group: "step" | "turn" | "persona" | "session" | "contextParts"): Promise<void> {
  await ui.clickSelector(`[data-usage-group="${group}"]`);
  await waitUntil(
    () =>
      ui.query<boolean>(
        `document.querySelector('[data-usage-group="${group}"]')?.getAttribute('aria-pressed') === 'true'`,
      ),
    (v) => v,
    { label: `切到 ${group}` },
  );
}

/** 合计行的「合计$」格（session 视图没有合计行 —— 它自己那一行就是合计） */
const totalCell = () =>
  ui.query<string>(
    `(() => { const tr = document.querySelector('[data-usage-row="total"]');` +
      ` const td = tr?.querySelector('[data-col="cost.total"]');` +
      ` return td ? td.textContent.trim() : null; })()`,
  );

const sessionRowCell = () =>
  ui.query<string>(
    `(() => { const td = document.querySelector('[data-usage-row="session"] [data-col="cost.total"]');` +
      ` return td ? td.textContent.trim() : null; })()`,
  );

/** 表体行键（不含合计行） */
const bodyRows = () =>
  ui.query<string[]>(
    `Array.from(document.querySelectorAll('[data-usage-row]'))` +
      `.map((tr) => tr.getAttribute('data-usage-row')).filter((k) => k !== 'total')`,
  );

describe("##443 刀 3：用量表一个入口 + group 切粒度", () => {
  it("默认 group=step：三步全在，合计行置顶且 = $0.5000", async () => {
    await pick("step");
    const rows = await bodyRows();
    expect(rows).toEqual(["t1767225600000#1", "t1767225600000#2", "t1767225601000#1"]);
    expect(await totalCell()).toBe("$0.5000");
  }, 60_000);

  it("四视角合计一致：step ≡ turn ≡ persona ≡ session", async () => {
    await pick("step");
    const stepTotal = await totalCell();
    await pick("turn");
    const turnTotal = await totalCell();
    await pick("persona");
    const personaTotal = await totalCell();
    await pick("session");
    const sessionTotal = await sessionRowCell();
    expect(stepTotal).toBe("$0.5000");
    expect(turnTotal).toBe(stepTotal);
    expect(personaTotal).toBe(stepTotal);
    expect(sessionTotal).toBe(stepTotal);
  }, 90_000);

  it("turn 视图两行（两轮），persona 视图两行（两个人）", async () => {
    await pick("turn");
    expect(await bodyRows()).toEqual(["t1767225600000", "t1767225601000"]);
    await pick("persona");
    expect((await bodyRows()).sort()).toEqual(["persona/1", "persona/2"]);
  }, 60_000);

  it("下钻：点 turn 行 → 只剩该轮的步；面包屑「返回」回到轮视图", async () => {
    await pick("turn");
    await ui.clickSelector('[data-usage-row="t1767225600000"] td:first-child');
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('[data-usage-crumbs]')`),
      (v) => v,
      { label: "面包屑出现" },
    );
    expect(await bodyRows()).toEqual(["t1767225600000#1", "t1767225600000#2"]);
    // 下钻后合计仍是该轮的（0.4），不是会话的（0.5）—— 过滤在聚合之前生效
    expect(await totalCell()).toBe("$0.4000");
    await ui.clickSelector("[data-usage-back]");
    await waitUntil(
      () => ui.query<boolean>(`!document.querySelector('[data-usage-crumbs]')`),
      (v) => v,
      { label: "返回轮视图" },
    );
    expect(await bodyRows()).toEqual(["t1767225600000", "t1767225601000"]);
  }, 90_000);

  it("窗口构成是另一个 group 视图：有「系统提示词」列，且**没有合计行**（构成不可加）", async () => {
    await pick("contextParts");
    const headers = await ui.query<string[]>(
      `Array.from(document.querySelectorAll('th[data-col]')).map((th) => th.textContent.trim())`,
    );
    expect(headers).toContain("系统提示词");
    expect(headers).toContain("工具定义");
    expect(headers).toContain("历史消息");
    expect(await totalCell()).toBeNull();
    // 构成只在轮首步有：第二步显示 –（不编 0）
    const second = await ui.query<string>(
      `(() => { const td = document.querySelector('[data-usage-row$="#2"] [data-col="contextParts.system"]');` +
        ` return td ? td.textContent.trim() : null; })()`,
    );
    expect(second).toBe("–");
  }, 90_000);
});
