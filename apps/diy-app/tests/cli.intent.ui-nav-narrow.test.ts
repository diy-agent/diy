// tests/cli.intent.ui-nav-narrow.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 窄窗（视口 <1024）导航契约（##297）
//
// 需求原文：「侧栏应该用不内缩吧？如果我用 pad 或手机浏览，那咋导航呢？
//            可以缩回最窄但不能消失吧」
//
// 契约（用户能看见的行为）：
//   1. 窄窗 rail **常驻**：侧栏永不消失，最窄 40px rail，主区只让出这 40px
//   2. 点 rail 顶部的 ◉ → 展开成盖住主区的浮层（遮罩可见可点）；点遮罩收回
//   3. 浮层里选定导航项 → 浮层自动收回（窄窗没有 hover/mouseleave 那条兜底）
//   4. 浮层宽度被压在视口内 → 遮罩与右上 ✕ 永不挤出屏外（任何宽度都收得回来）
//   5. 宽窗（≥1024）语义不变：悬停展开 + pin，且不带 rail 相关类
//
// 为什么坚持真实点击（CDP 命中测试）：##297 的原始症状正是「DOM 在、点不着」——
// 侧栏被挪到 x=-224，按钮 rect 中心 x=-26，`elementFromPoint` 落在别处。只断言
// 「元素存在 / 宽度非零」会完整漏掉它。故凡是「能不能用」都走 elementFromPoint
// 或 clickSelector/clickPoint（真实事件 + 命中测试），不走 DOM `.click()`。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, afterEach, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type UiDriver } from "./ui-drive";
import { NAV_RAIL_W, hoverOpenNav, lockNavOpen, navLocked, navWidth } from "./nav-helper";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;

const NARROW_W = 820;
/** 浮层右侧留白：CSS 里 `.menu` 的 max-width 是 `calc(100vw - 3rem)` */
const OVERLAY_STRIP = 48;

const rootCls = () => ui.query<string>(`document.querySelector('.drawer').className`);
const menuSel = `.drawer-side .menu`;
const railToggle = `[data-testid=nav-rail-toggle]`;
const contentLeft = () =>
  ui.query<number>(`Math.round(document.querySelector('.drawer-content').getBoundingClientRect().left)`);
const contentInert = () => ui.query<boolean>(`document.querySelector('.drawer-content').hasAttribute('inert')`);
const sideGeom = () =>
  ui.query<{ x: number; w: number; vis: string; pos: string }>(`(() => {
    const el = document.querySelector('.drawer-side');
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { x: Math.round(r.x), w: Math.round(r.width), vis: cs.visibility, pos: cs.position };
  })()`);

/** 某坐标的命中元素是否落在给定选择器内（真实可达性，不是「元素存在」） */
const hitIs = (sel: string, x: number, y: number) =>
  ui.query<boolean>(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    const hit = document.elementFromPoint(${x}, ${y});
    return !!el && !!hit && (hit === el || el.contains(hit));
  })()`);

/** 等侧栏宽度稳定到期望值。
 *  `.menu` 有 `transition-[width] duration-200`：类名切换是同步的，宽度不是 ——
 *  直接量会抓到过渡中间值（首跑实测「收回 rail」处抓到 61px 而断言 40）。 */
async function navWidthIs(expected: number): Promise<number> {
  return waitUntil(() => navWidth(ui), (v) => Math.abs(v - expected) <= 1, {
    label: `侧栏宽度稳定到 ${expected}px`,
    timeoutMs: 3000,
  });
}

/** 等 renderer 就绪（应用异步挂载，首条命令可能早于 DOM） */
async function waitAppReady(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (await ui.query<boolean>(`!!document.querySelector(${JSON.stringify(menuSel)})`)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("[nav-narrow] 等侧栏渲染超时");
}

/** 切到窄窗并等 rail 生效 */
async function goNarrow(width = NARROW_W): Promise<void> {
  await ui.setViewport(width, 650);
  const cls = await waitUntil(rootCls, (c) => c.includes("diy-nav-rail"), { label: "窄窗 rail 生效", timeoutMs: 3000 });
  if (!cls.includes("diy-nav-rail")) throw new Error(`[nav-narrow] 窄窗 rail 未生效，类名=${cls}`);
}

/** 点 ◉ 展开浮层 */
async function openRail(): Promise<void> {
  await ui.clickSelector(railToggle);
  const cls = await waitUntil(rootCls, (c) => c.includes("diy-nav-rail-open"), { label: "浮层展开", timeoutMs: 3000 });
  if (!cls.includes("diy-nav-rail-open")) throw new Error(`[nav-narrow] 浮层没展开，类名=${cls}`);
}

beforeAll(async () => {
  const electron = await startElectronTest();
  const HOME = electron.home;
  fx = {
    electron,
    HOME,
    sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
  };
  ui = await makeUiDriver(electron.cdpUrl, async () => {
    const r = await fx.sh.getJson("./diy.sh ui inspect");
    return (r.data as any)?.data?.tree;
  });
  await waitAppReady();
}, 60000);

afterEach(async () => {
  await ui?.clearViewport(); // 视口覆写会漏给同文件后续用例
});

afterAll(async () => {
  ui?.close();
  await fx?.electron?.stop();
});

describe("窄窗导航：rail 常驻 + 点开浮层", () => {
  it("rail 常驻：侧栏不消失、主区只让 40px、图标真的点得到", async () => {
    await goNarrow();
    const side = await sideGeom();
    expect(side.vis).toBe("visible"); // 修前是 hidden + x=-224（整块被推出画面）
    expect(side.x).toBe(0);
    expect(await navWidthIs(NAV_RAIL_W)).toBeCloseTo(NAV_RAIL_W, 0); // 最窄 40px，永不 0
    expect(await contentLeft()).toBe(NAV_RAIL_W); // 主区只让出这一列，不是整块消失

    // 真实可达：rail 上「搜索任务/会话」入口的中心点必须命中它自己。
    // 修前 nav 内容还停在 translate:-100%（menu x=-40）—— 侧栏占了列也点不到。
    const box = await ui.query<{ x: number; y: number } | null>(`(() => {
      const el = document.querySelector('[data-testid=nav-search-open]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    expect(box, "rail 上应有搜索入口").not.toBeNull();
    expect(await hitIs("[data-testid=nav-search-open]", box!.x, box!.y)).toBe(true);
  });

  it("点 ◉ 展开浮层、点遮罩收回；浮层期间主区 inert", async () => {
    await goNarrow();
    expect(await contentInert()).toBe(false); // rail 态主区可用

    await openRail();
    // 展成 224px 浮层（宽度有过渡，等它落定再断言）
    expect(await waitUntil(() => navWidth(ui), (v) => v > 100, { label: "浮层展开发宽", timeoutMs: 3000 })).toBeGreaterThan(100);
    expect((await sideGeom()).pos).toBe("fixed"); // 浮层盖在主区上
    expect(await contentInert()).toBe(true); // 被盖住的主区不该还能 Tab/点击

    // 遮罩在主区上方（浮层右侧那条带）必须真实命中遮罩
    expect(await hitIs(".drawer-side .drawer-overlay", NARROW_W - 20, 300)).toBe(true);

    await ui.clickPoint({ x: NARROW_W - 20, y: 300 });
    const cls = await waitUntil(rootCls, (c) => !c.includes("diy-nav-rail-open"), { label: "点遮罩收浮层", timeoutMs: 3000 });
    expect(cls).not.toContain("diy-nav-rail-open");
    expect(await navWidthIs(NAV_RAIL_W)).toBeCloseTo(NAV_RAIL_W, 0); // 收回 rail，不是收成 0
    expect(await contentInert()).toBe(false);
  });

  it("浮层里选定导航项 → 浮层自动收回（窄窗没有 mouseleave 兜底）", async () => {
    await goNarrow();
    await openRail();
    await ui.clickSelector('.drawer-side button[title="设置"]');
    const cls = await waitUntil(rootCls, (c) => !c.includes("diy-nav-rail-open"), { label: "切页后浮层收回", timeoutMs: 3000 });
    expect(cls).not.toContain("diy-nav-rail-open");
    // 且确实切到了设置页（该导航项进入选中态），不是「浮层收了、页面没动」
    const active = await ui.query<boolean>(
      `document.querySelector('.drawer-side button[title="设置"]').className.includes('bg-primary/30')`,
    );
    expect(active).toBe(true);
  });

  it("浮层宽度压在视口内：很窄的窗口也收得回来", async () => {
    // 视口 240 → 可用的浮层上限 = 240-48 = 192px < 默认 nav 宽 224。
    // 没有这条 clamp 时 nav 会撑满甚至超出视口，遮罩与 ✕ 被挤出屏外 → 点哪儿都收不回来（死局）。
    await goNarrow(240);
    await openRail();
    // 先等浮层真的展开到位，否则量到的是过渡中间值，这条 clamp 断言就成了空的
    const w = await waitUntil(() => navWidth(ui), (v) => v > 100, { label: "极窄窗浮层展开", timeoutMs: 3000 });
    expect(w).toBeLessThanOrEqual(240 - OVERLAY_STRIP + 1);
    // 浮层右侧仍留有一条可点的遮罩带
    expect(await hitIs(".drawer-side .drawer-overlay", 220, 300)).toBe(true);
    await ui.clickPoint({ x: 220, y: 300 });
    const cls = await waitUntil(rootCls, (c) => !c.includes("diy-nav-rail-open"), { label: "极窄窗点遮罩收回" });
    expect(cls).not.toContain("diy-nav-rail-open");
  });
});

describe("宽窗导航：语义不变（回归守卫）", () => {
  it("≥1024 无 rail 相关类；仍是悬停展开 + pin", async () => {
    await ui.setViewport(1280, 700);
    const cls = await waitUntil(rootCls, (c) => !c.includes("diy-nav-rail"), { label: "宽窗清掉 rail 类", timeoutMs: 3000 });
    expect(cls).not.toContain("diy-nav-rail");
    expect(await ui.query<boolean>(`!!document.querySelector(${JSON.stringify(railToggle)})`)).toBe(false);
    expect(await navWidthIs(NAV_RAIL_W)).toBeCloseTo(NAV_RAIL_W, 0); // 收起态仍是 40px rail
    expect(await contentLeft()).toBe(NAV_RAIL_W);

    await hoverOpenNav(ui); // 悬停即展开（窄窗那条路已被 rail 取代，宽窗这条必须还在）
    expect(await waitUntil(() => navWidth(ui), (v) => v > 100, { label: "宽窗悬停展开", timeoutMs: 3000 })).toBeGreaterThan(100);
    await lockNavOpen(ui);
    expect(await navLocked(ui)).toBe(true);
  });
});
