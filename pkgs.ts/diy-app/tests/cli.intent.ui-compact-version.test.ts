// tests/cli.intent.ui-compact-version.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 plan 版本链的 **UI 面**（##378 M3b）—— 真实 renderer + 合成点击
//
// 三面同步里的 UI 面（body §5）：`CompactSessionPanel` 的「装配管道」Block 要显示
//   **当前版本 id** + 最近 N 版（`brief`），点开能看全文/对比，并能回滚。
// 另钉一条**记账完整性**：用户在界面上改级列表（`+ 新增级`）也必须**入版本链** ——
//   否则「版本链」会漏掉界面上的每一次改动（UI 走 `autoCompactSetConfig`，与 plan.set 是两条路）。
//
// 判据真源不在本文件：内容寻址 / 链 / brief 的纯逻辑单测见 tests/services/plan-store.test.ts。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";
import { keyOf } from "../src/main/core/local-paths";

const REPO_ROOT = join(__dirname, "..", "..", "..");

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
let uri = "";

beforeAll(async () => {
  const electron = await startElectronTest();
  const HOME = electron.home;
  fx = {
    electron,
    HOME,
    sh: new ShellTest({ cwd: REPO_ROOT, env: { HOME, DIY_HOME: HOME } }),
  };
  ui = await makeUiDriver(electron.cdpUrl, async () => {
    const r = await fx.sh.getJson("./diy.sh ui inspect");
    return (r.data as { data?: { tree?: A11yNode } })?.data?.tree;
  });

  const p = await fx.sh.getJson(`./diy.sh project create ${HOME}/cpv --label 版本`);
  const pid = String((p.data as { data?: { id?: string } })?.data?.id);
  const t = await fx.sh.getJson(`./diy.sh task create "plan 版本 UI" ${pid}`);
  uri = String((t.data as { data?: { uri?: string } })?.data?.uri);

  // 先写一版 plan（走 CLI ⇒ 链上有一行，界面应显示它）
  const keepFile = join(HOME, "keep-fixture.json");
  mkdirSync(HOME, { recursive: true });
  writeFileSync(keepFile, JSON.stringify([{ type: "recent", data: { n: 3 } }]), "utf-8");
  await fx.sh.getJson(`./diy.sh agent local compact plan set ${uri} ${keepFile}`);
}, 120_000);

afterAll(async () => {
  ui?.close();
  await fx?.electron?.stop();
});

async function a11yText(): Promise<string> {
  const res = await fx.sh.getJson("./diy.sh ui inspect");
  const acc: string[] = [];
  const walk = (n: A11yNode | undefined): void => {
    if (!n) return;
    if (n.text) acc.push(String(n.text));
    for (const c of n.children ?? []) walk(c);
  };
  walk((res.data as { data?: { tree?: A11yNode } })?.data?.tree);
  return acc.join("\n");
}

/** 打开「窗口构成」抽屉（合成 click —— 环的 hover 卡会盖住 tab，见 ui-compact 同注） */
async function openDrawer(): Promise<void> {
  await ui.query<string>(
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'').startsWith('窗口占用')); if(!b) return 'no'; b.click(); return 'ok'; })()`,
  );
  await waitUntil(a11yText, (t) => t.includes("窗口构成"), { label: "窗口构成抽屉打开" });
  await waitUntil(() => ui.query<boolean>(`!!document.querySelector('[data-plan-version]')`), (v) => v === true, {
    label: "装配管道版本区上屏",
  });
}

describe("plan 版本链：UI 面", () => {
  it("装配管道显示当前版本 id + 版本行；点开看全文（再点收起）", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await openDrawer();
    const current = String(
      ((await fx.sh.getJson(`./diy.sh agent local compact plan versions ${uri}`)).data as { current?: string }).current ?? "",
    );
    expect(current).toMatch(/^plan-[0-9a-f]{12}$/);
    // 当前版本 id 上屏（与主进程现算的一致 —— UI 不许自己算一份）
    await waitUntil(
      () => ui.query<string>(`document.querySelector('[data-plan-version]')?.textContent?.trim() ?? ''`),
      (t) => t === current,
      { label: `当前版本上屏 ${current}` },
    );
    // 版本行（可点）+ brief + 回滚按钮（当前版禁用）
    expect(await ui.query<boolean>(`!!document.querySelector('[data-plan-version-row="${current}"]')`)).toBe(true);
    expect(await ui.query<boolean>(`!!document.querySelector('[data-plan-version-detail]')`)).toBe(false);
    expect(
      await ui.query<boolean>(`document.querySelector('[data-plan-version-restore="${current}"]')?.disabled === true`),
    ).toBe(true);

    await ui.clickSelector(`[data-plan-version-row="${current}"]`);
    const detail = await waitUntil(
      () => ui.query<string>(`document.querySelector('[data-plan-version-detail]')?.textContent ?? ''`),
      (t) => t.includes("recent"),
      { label: "版本详情展开" },
    );
    expect(detail).toContain(current);
    // 再点同一版 = 收起
    await ui.clickSelector(`[data-plan-version-row="${current}"]`);
    await waitUntil(() => ui.query<boolean>(`!!document.querySelector('[data-plan-version-detail]')`), (v) => v === false, {
      label: "再点收起",
    });
    // 目录键复用 keyOf（唯一算法）：`local/plan/plan-scope_global-<sha12>/`
    expect(readdirSync(join(fx.HOME, "local", "plan"))[0]).toBe(keyOf("plan-scope:global"));
  }, 60_000);

  it("界面不再给级列表编辑入口（##432：keep 已废弃，不决定投递）", async () => {
    // 版本链保留只为「旧 keep 存档可查」；「UI 编辑 keep 入链」那条写路径已无入口（review 第 1 条：
    // 不许并列第二个旋钮）。这条守的是**编辑面确实没了**，而不是某个按钮点在哪儿。
    expect(await ui.query<boolean>(`!!document.querySelector('[data-keep-add]')`)).toBe(false);
    expect(await ui.query<boolean>(`!!document.querySelector('[data-keep-reset]')`)).toBe(false);
  }, 60_000);
});
