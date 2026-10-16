// tests/cli.intent.ui-nav-project.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 nav「任务管理」分区按项目分类（##302）的**行为**契约 —— 走真实 renderer
//
// 需求原文（用户 2026-10-13）：「为 nav 做一个按项目分类的能力，当前任务无法分清
// 哪些是哪个项目的。」
//
// 契约（用户能看见的行为）：
//   1. 同时打开两个项目的任务 → 展开态 nav 出现**两个项目组头**，文案是项目 label
//   2. 每个 tab 行标出**归属项目**（`data-nav-project` = 项目 id）；同项目的行落在
//      自己那组组头**之下**、别的组头之上（分组真的把同项目挪到一起了）
//   3. **缩进语义不变**：分组是显示层重排，任务父子缩进照旧（顶级 28px / 子级 42px）
//   4. rail（40px 收起态）装不下组头文字 → 不渲染组头，但归属字段仍在（色条是那一态
//      唯一的归属线索）
//   5. 与置顶（##356 ②）合流：钉住某组的项 → 它**仍在整条 nav 的最前**（##356 的
//      「固定在最上面」原样成立），且它所在的**组**整体排到最前（组是整体，不能拆）
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";
import { NAV_MENU_SEL, lockNavOpen, unlockNav } from "./nav-helper";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
let uriA = "";   // 项目甲 · 顶级任务
let uriA1 = "";  // 项目甲 · 甲的子任务（验缩进）
let uriB = "";   // 项目乙 · 顶级任务
let uriB2 = "";  // 项目乙 · 第二个任务（验「组内置顶提前」：同组内才看得出先后）

beforeAll(async () => {
  const electron = await startElectronTest();
  const HOME = electron.home;
  fx = {
    electron,
    HOME,
    sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
  };
  ui = await makeUiDriver(fx.electron.cdpUrl, () => a11y());

  const pA = await fx.sh.getJson(`./diy.sh ui project create ${HOME}/navproj-a --label 分组甲项目`);
  const pidA = String((pA.data as any)?.data?.id);
  const pB = await fx.sh.getJson(`./diy.sh ui project create ${HOME}/navproj-b --label 分组乙项目`);
  const pidB = String((pB.data as any)?.data?.id);

  const mk = async (title: string, pid: string, parent?: string): Promise<string> => {
    const r = await fx.sh.getJson(`./diy.sh task create ${title} ${pid}${parent ? ` --parent ${parent}` : ""}`);
    return String((r.data as any)?.data?.uri);
  };
  uriA = await mk("甲顶级", pidA);
  uriA1 = await mk("甲的子", pidA, uriA);
  uriB = await mk("乙顶级", pidB);
  uriB2 = await mk("乙之二", pidB);

  // 打开顺序刻意交叉：甲 → 乙 → 甲的子 → 乙之二（分组要能把同项目的挪到一起）
  for (const u of [uriA, uriB, uriA1, uriB2]) await fx.sh.getJson(`./diy.sh ui tab open ${u}`);
});

afterAll(async () => {
  ui?.close();
  await fx?.electron?.stop();
});

async function a11y(): Promise<A11yNode | undefined> {
  const r = await fx.sh.getJson("./diy.sh ui inspect");
  return (r.data as any)?.data?.tree as A11yNode | undefined;
}

/** 展开态 nav 里的项目组头：`{id, text}`（顺序 = DOM 顺序） */
const heads = () =>
  ui.query<{ id: string; text: string }[]>(`(() => {
    const nav = document.querySelector(${JSON.stringify(NAV_MENU_SEL)});
    if (!nav) return [];
    return [...nav.querySelectorAll('[data-nav-project-head]')].map((e) => ({
      id: e.dataset.navProjectHead ?? "",
      text: (e.textContent || "").trim(),
    }));
  })()`);

/** 展开态 nav 里的 tab 行：`{uri, project, y, padLeft}`。
 * 身份取 `data-nav-tab`（= ctx，两态同值）—— 别用 title：展开态 title 是 URI、
 * 收起态 title 是**显示名**（`#1 甲顶级`），拿它当身份会随态而变。 */
const rows = () =>
  ui.query<{ uri: string; project: string; y: number; padLeft: number }[]>(`(() => {
    const nav = document.querySelector(${JSON.stringify(NAV_MENU_SEL)});
    if (!nav) return [];
    return [...nav.querySelectorAll('[data-nav-tab]')].map((e) => {
      const r = e.getBoundingClientRect();
      return {
        uri: e.dataset.navTab ?? '',
        project: e.dataset.navProject ?? '',
        y: Math.round(r.y),
        padLeft: Math.round(parseFloat(e.style.paddingLeft)),
      };
    });
  })()`);

/** 点某个任务项的置顶开关（按 uri 定位它那一行 —— 按钮自己也有 title，不能裸用 [title]） */
async function clickPin(uri: string): Promise<void> {
  const nth = await ui.query<number>(
    `Array.from(document.querySelectorAll('[data-testid="nav-tab-pin"]'))
       .findIndex((b) => b.closest('div[title]')?.getAttribute('title') === ${JSON.stringify(uri)})`,
  );
  if (nth < 0) throw new Error(`[t302] nav 里找不到 ${uri} 的置顶按钮`);
  await ui.clickSelector('[data-testid="nav-tab-pin"]', { nth });
}

/** 组头的 y（按 id 取） */
const headY = async (pid: string): Promise<number | undefined> => {
  const ys = await ui.query<Record<string, number>>(`(() => {
    const nav = document.querySelector(${JSON.stringify(NAV_MENU_SEL)});
    const out = {};
    for (const e of nav ? nav.querySelectorAll('[data-nav-project-head]') : []) {
      out[e.dataset.navProjectHead ?? ''] = Math.round(e.getBoundingClientRect().y);
    }
    return out;
  })()`);
  return ys[pid];
};

describe("nav 按项目分类（##302）", () => {
  it("展开态：两个项目各一个组头（文案 = 项目 label），行标出归属项目", async () => {
    await lockNavOpen(ui);
    await waitUntil(() => heads(), (h) => h.length === 2, { label: "两个项目组头上屏" });

    const hs = await heads();
    // 组序 = 项目首次打开顺序（甲在前）
    expect(hs.map((h) => h.text)).toEqual(["📁 分组甲项目", "📁 分组乙项目"]);
    // 组头带项目 id（判据来自 projectFromUri，不是文案匹配）
    const pidA = (await rows()).find((r) => r.uri === uriA)!.project;
    const pidB = (await rows()).find((r) => r.uri === uriB)!.project;
    expect(pidA).not.toBe("");
    expect(pidB).not.toBe("");
    expect(pidA).not.toBe(pidB);
    expect(hs.map((h) => h.id)).toEqual([pidA, pidB]);
  });

  it("分组真的把同项目挪到一起：甲的两条都在甲的组头之下、乙的组头之上", async () => {
    const rs = await rows();
    const pidA = rs.find((r) => r.uri === uriA)!.project;
    const pidB = rs.find((r) => r.uri === uriB)!.project;
    const yA = (await headY(pidA))!;
    const yB = (await headY(pidB))!;

    const rowA = rs.find((r) => r.uri === uriA)!;
    const rowA1 = rs.find((r) => r.uri === uriA1)!;
    const rowB = rs.find((r) => r.uri === uriB)!;

    // 甲的两条（含后来才打开的「甲的子」）都落在甲的组头之下
    expect(rowA.y).toBeGreaterThan(yA);
    expect(rowA1.y).toBeGreaterThan(yA);
    // 且都在乙的组头之上 —— 这就是「挪到一起」
    expect(rowA1.y).toBeLessThan(yB);
    expect(rowB.y).toBeGreaterThan(yB);
    // 组内保持 tabStore 的顺序（甲顶级在甲的子之前）
    expect(rowA.y).toBeLessThan(rowA1.y);
  });

  it("缩进语义不变：顶级 28px、子级 42px（分组是显示层重排，不动父子缩进）", async () => {
    const rs = await rows();
    expect(rs.find((r) => r.uri === uriA)!.padLeft).toBe(28);
    expect(rs.find((r) => r.uri === uriB)!.padLeft).toBe(28);
    expect(rs.find((r) => r.uri === uriA1)!.padLeft).toBe(42);
  });

  it("rail（40px）态：装不下组头文字 → 不渲染组头，但每行仍带归属项目", async () => {
    const pidA = (await rows()).find((r) => r.uri === uriA)!.project; // 收起后展开态的行就没了，先取
    await unlockNav(ui);
    await ui.leaveSelector(NAV_MENU_SEL); // 移出侧栏 → 收起成 40px rail
    const w = await waitUntil(
      () => ui.query<number>(`Math.round(document.querySelector(${JSON.stringify(NAV_MENU_SEL)}).getBoundingClientRect().width)`),
      (v) => v <= 100,
      { label: "侧栏收起成 rail", timeoutMs: 3000 },
    );
    expect(w).toBeLessThanOrEqual(100);

    // 组头只在展开态渲染（rail 装不下文字）
    expect(await ui.query<number>(`document.querySelectorAll('[data-nav-project-head]').length`)).toBe(0);
    const railRows = await ui.query<{ uri: string; project: string }[]>(`(() => {
      const nav = document.querySelector(${JSON.stringify(NAV_MENU_SEL)});
      return [...(nav ? nav.querySelectorAll('[data-nav-tab]') : [])].map((e) => ({
        uri: e.dataset.navTab ?? '',
        project: e.dataset.navProject ?? '',
      }));
    })()`);
    expect(railRows.map((r) => r.uri).sort()).toEqual([uriA, uriA1, uriB, uriB2].sort());
    // 归属仍在（色条是那一态唯一的归属线索）：同项目的两条同 id，且真的渲染了色条
    expect(railRows.find((r) => r.uri === uriA)!.project).toBe(pidA);
    expect(railRows.find((r) => r.uri === uriA1)!.project).toBe(pidA);
    expect(railRows.find((r) => r.uri === uriB)!.project).not.toBe(pidA);
    const bars = await ui.query<number>(`(() => {
      const nav = document.querySelector(${JSON.stringify(NAV_MENU_SEL)});
      const rows = [...(nav ? nav.querySelectorAll('[data-nav-tab]') : [])];
      return rows.filter((b) => !!b.querySelector('span[style*="oklch"]')).length;
    })()`);
    expect(bars).toBe(railRows.length);
  });

  it("与置顶（##356）合流：钉住乙组的项 → 它在整条 nav 最前，乙组整体排到最前", async () => {
    await lockNavOpen(ui);
    await waitUntil(() => heads(), (h) => h.length === 2, { label: "回到展开态（两个组头）" });

    const pidA = (await rows()).find((r) => r.uri === uriA)!.project;
    const pidB = (await rows()).find((r) => r.uri === uriB)!.project;
    // 前置：甲组在前（甲先打开），且乙组内 uriB 在 uriB2 之前
    expect((await headY(pidA))!).toBeLessThan((await headY(pidB))!);
    expect((await rows()).find((r) => r.uri === uriB)!.y).toBeLessThan((await rows()).find((r) => r.uri === uriB2)!.y);

    await clickPin(uriB2);
    // 等置顶生效（点击异步落 signal → 重渲染）：乙组头跑到甲组头上面
    await waitUntil(
      async () => (await headY(pidB))! < (await headY(pidA))!,
      (v) => v,
      { label: "置顶后乙组排到最前" },
    );

    const rs = await rows();
    const rowB2 = rs.find((r) => r.uri === uriB2)!;
    const rowB = rs.find((r) => r.uri === uriB)!;
    // ##356 的语义原样保留：钉住的项在**整条 nav 最前**（比所有别的行都靠上）
    expect(Math.min(...rs.map((r) => r.y))).toBe(rowB2.y);
    // 组内置顶也生效：乙之二排到乙顶级之前
    expect(rowB2.y).toBeLessThan(rowB.y);
    // 分组没被拆散：它仍在**乙组头之下**（组是整体，整组一起上移）
    expect(rowB2.y).toBeGreaterThan((await headY(pidB))!);
    expect(await heads()).toHaveLength(2);
  });
});
