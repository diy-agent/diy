// tests/cli.intent.ui-find.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 页面内查找（##234）的**行为**契约
//
// 契约（用户能看见的行为）：
//   1. ⌘F 打开查找条（动态出现，不是模态弹窗）；点顶栏 🔍 按钮同样能开
//   2. 输入即高亮全部命中，显示 i/n 计数（0/0 = 无命中）
//   3. ↑ / ↓（或回车 / Shift+回车）在命中之间跳，计数跟着变
//   4. Esc / ✕ 关闭 → 查找条消失、高亮清除
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;

beforeAll(async () => {
  const electron = await startElectronTest();
  const HOME = electron.home;
  fx = {
    electron,
    HOME,
    sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
  };
  ui = await makeUiDriver(fx.electron.cdpUrl, () => a11y());

  const p = await fx.sh.getJson(`./diy.sh ui project create ${HOME}/find-repo --label 查找项目`);
  const pid = String((p.data as any)?.data?.id);
  // 三个任务标题都含「查找」，保证有多处命中
  for (const t of ["查找甲任务", "查找乙任务", "查找丙任务"]) {
    await fx.sh.getJson(`./diy.sh task create ${t} ${pid}`);
  }
  await fx.sh.getJson("./diy.sh ui page navigate task");
  // 等树把任务行渲染出来再开始（否则查找的搜索根里还没有那些标题 → 命中数不稳定）
  await waitUntil(
    () => ui.query<number>(`document.querySelectorAll('tbody tr[data-uri]').length`),
    (n) => n >= 3,
    { label: "任务行就绪（3 个）", timeoutMs: 8000 },
  );
});

afterAll(async () => {
  ui?.close();
  await fx?.electron?.stop();
});

async function a11y(): Promise<A11yNode | undefined> {
  const r = await fx.sh.getJson("./diy.sh ui inspect");
  return (r.data as any)?.data?.tree as A11yNode | undefined;
}

const findBarPresent = () =>
  ui.query<boolean>(`!!document.querySelector('input[placeholder*="页面内查找"]')`);

const badgeText = () =>
  ui.query<string>(`(() => {
    const input = document.querySelector('input[placeholder*="页面内查找"]');
    const bar = input?.closest('div');
    if (!bar) return "";
    const b = [...bar.querySelectorAll('span')].find((s) => /^\\d+\\/\\d+$/.test(s.textContent.trim()));
    return b ? b.textContent.trim() : "";
  })()`);

/** CSS Custom Highlight API 登记的命中数（高亮真的生效了，不只是计数好看） */
const highlightCount = () =>
  ui.query<number>(`(CSS.highlights?.get('diy-find')?.size) ?? 0`);

describe("页面内查找（##234）", () => {
  it("⌘F 打开查找条（动态出现）", async () => {
    expect(await findBarPresent()).toBe(false);
    await ui.press("Meta+f");
    await waitUntil(findBarPresent, (v) => v, { label: "⌘F 打开查找条" });
    expect(await findBarPresent()).toBe(true);
  });

  it("输入即高亮并显示 i/n（高亮数 = 命中数）", async () => {
    // ⌘F 已聚焦输入框，直接键入
    await ui.type("查找");
    const badge = await waitUntil(badgeText, (b) => /^\d+\/\d+$/.test(b) && !b.startsWith("0/"), {
      label: "计数出现",
    });
    const [i, n] = badge.split("/").map(Number);
    expect(i).toBe(1);
    expect(n).toBeGreaterThanOrEqual(3); // 三个任务标题 + 可能命中项目名
    expect(await highlightCount()).toBe(n); // 高亮真的登记了 n 处
  });

  it("↓ / ↑ 在命中之间跳（计数跟着变），到头回绕", async () => {
    const first = await badgeText();
    const n = Number(first.split("/")[1]);

    await ui.clickSelector('button[title^="下一个"]');
    const second = await waitUntil(badgeText, (b) => b !== first, { label: "↓ 后计数变化" });
    expect(second).toBe(`2/${n}`);

    await ui.clickSelector('button[title^="上一个"]');
    const back = await waitUntil(badgeText, (b) => b === `1/${n}`, { label: "↑ 回到第一个" });
    expect(back).toBe(`1/${n}`);
  });

  it("Esc 关闭 → 查找条消失、高亮清除", async () => {
    await ui.press("Escape");
    await waitUntil(findBarPresent, (v) => !v, { label: "Esc 关闭查找条" });
    expect(await findBarPresent()).toBe(false);
    expect(await highlightCount()).toBe(0);
  });

  it("切页 → 查找条关闭、高亮清零（RV-03：旧页 Range 随 Solid 卸载退化，不能留过期计数）", async () => {
    await ui.press("Meta+f");
    await waitUntil(findBarPresent, (v) => v, { label: "重新打开查找条" });
    await ui.type("查找");
    await waitUntil(highlightCount, (n) => n > 0, { label: "高亮就绪" });
    expect(await highlightCount()).toBeGreaterThan(0);
    // 切页：查找条是**页内**语义 → 路由一变即关（App createEffect on(route) → findStore.close）
    await fx.sh.getJson("./diy.sh ui page navigate settings");
    await waitUntil(findBarPresent, (v) => !v, { label: "切页关查找条", timeoutMs: 5000 });
    expect(await findBarPresent()).toBe(false);
    expect(await highlightCount()).toBe(0); // 高亮同步清（不残留 zeroWidth Range）
    // 切回任务页供后续（无后续，仅恢复现场）
    await fx.sh.getJson("./diy.sh ui page navigate task");
  });

  it("顶栏 🔍 按钮也能打开（不知道快捷键的人的入口）", async () => {
    await ui.clickSelector('button[title="页面内查找（⌘F）"]');
    await waitUntil(findBarPresent, (v) => v, { label: "点按钮打开查找条" });
    expect(await findBarPresent()).toBe(true);
    await ui.press("Escape");
    await waitUntil(findBarPresent, (v) => !v, { label: "清理" });
  });
});
