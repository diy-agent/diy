// tests/cli.intent.ui-nav-hover-detail.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 悬停导航任务项 → 任务详情覆盖层
//
// 需求原文：「再加个导航条上的打开的任务都应该在显示一个类似任务管理里弹出的任务
//             详情那种边栏……显示的位置为 nav 右侧页面区域的左侧，内容用任务聊天
//             page 的左侧『任务详情』view 即可，组件复用一下」「hover 事件就展开……
//             鼠标移走就隐藏」「是覆盖层，不是挤走」
//
// 契约：
//   1. 悬停 nav 上的任务项 → 出现任务详情覆盖层，内容是**被悬停那个任务**的详情
//   2. 是覆盖（主区宽度不变），不是分栏挤压
//   3. 鼠标移走 → 覆盖层消失
//   4. 覆盖层与任务执行页左栏**两个实例并存**：各自取数，不因全局 selectedTask
//      指向别的任务而卡在「加载中…」（这正是 TaskSideView 从单例改独立取数的回归）
//   5. **只跳过「正在看的那一个」**：悬停已开在 nav 里但**非激活**的任务（a）要弹；
//      悬停**当前激活**的任务（b）不弹 —— 它的详情已在屏上，再弹就是同屏两份（##183 C-1）。
//      ⚠️ 回归教训：C-1 曾写成「凡是开在 nav 里的都跳过」→ nav hover 大面积失效
//
// 交互模拟的说明：真实鼠标 hover 无法由 CDP 注入复现（`Input.dispatchMouseEvent`
// 不更新 hover 状态，详见 tests/ui-drive.ts 注释），故这里派发原生 mouseenter/
// mouseleave。为免「假绿」，另外断言该元素的 rect 非零且 `elementFromPoint` 命中它
// —— 即「这一项真的在鼠标可达的位置上，不是被遮挡/零尺寸」。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { makeUiDriver, type UiDriver } from "./ui-drive";
import { waitUntil } from "./wait";
import { lockNavOpen } from "./nav-helper";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
/** 造两个任务：a 用于「悬停的目标」，b 用于「全局 selectedTask 指向别人」 */
let uriA = "";
let uriB = "";
let titleA = "";

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
  for (let i = 0; i < 60; i++) {
    if (await ui.query<boolean>(`!!document.querySelector('.drawer-side .menu')`)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const p = await fx.sh.getJson(`./diy.sh project create ${HOME}/hovdetail --label Hov`);
  const pid = String((p.data as any)?.data?.id);
  titleA = "悬停目标任务A";
  const rA = await fx.sh.getJson(`./diy.sh task create ${titleA} ${pid}`);
  uriA = String((rA.data as any)?.data?.uri);
  const rB = await fx.sh.getJson(`./diy.sh task create 另一个任务B ${pid}`);
  uriB = String((rB.data as any)?.data?.uri);
  // 两个都打开成 tab（nav 上才会出现），且**最后激活 b** → b 是「正在看的那一个」，
  // 全局 selectedTask 指向 b；a 已开但非激活 —— 正好覆盖 C-1 的两种情形
  await fx.sh.getJson(`./diy.sh ui tab open ${uriA}`);
  await fx.sh.getJson(`./diy.sh ui tab open ${uriB}`);
  // 展开侧栏：展开态的任务项 title 才是 uri（收起态 title 是短标签）
  await lockNavOpen(ui);
}, 90000);

afterAll(async () => {
  ui?.close();
  await fx?.electron?.stop();
});

/** 主区宽度（用于断言覆盖层不挤压主区） */
const contentWidth = () =>
  ui.query<number>(`Math.round(document.querySelector('.drawer-content').getBoundingClientRect().width)`);

/** 覆盖层：存在则返回其文本与左缘 x */
const hoverPanel = () =>
  ui.query<{ text: string; x: number; w: number } | null>(`(() => {
    const el = document.querySelector('aside[aria-label^="任务详情"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { text: el.innerText, x: Math.round(r.x), w: Math.round(r.width) };
  })()`);

/**
 * 悬停 nav 上 title = uri 的那一项：先断言「该项可被鼠标命中」，再派发 mouseenter。
 * 返回 false = 没找到该项（测试失败在断言里，不静默跳过）。
 */
const hoverNavItem = (uri: string) =>
  ui.query<{ found: boolean; hittable: boolean }>(`(() => {
    const el = [...document.querySelectorAll('.drawer-side [title]')].find(
      (d) => d.getAttribute('title') === ${JSON.stringify(uri)},
    );
    if (!el) return { found: false, hittable: false };
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const top = r.width > 0 && r.height > 0 ? document.elementFromPoint(cx, cy) : null;
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    return { found: true, hittable: !!top && el.contains(top) };
  })()`);

const leaveNavItem = (uri: string) =>
  ui.query<boolean>(`(() => {
    const el = [...document.querySelectorAll('.drawer-side [title]')].find(
      (d) => d.getAttribute('title') === ${JSON.stringify(uri)},
    );
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    return true;
  })()`);

describe("悬停导航任务项 → 任务详情覆盖层", () => {
  it("setup: 两个任务都已打开，且全局选中任务不是 a", async () => {
    const list = await fx.sh.getJson("./diy.sh ui tab list");
    const opened = ((list.data as any)?.data?.opened ?? []) as string[];
    expect(opened).toContain(`task-run:${uriA}`);
    expect(opened).toContain(`task-run:${uriB}`);
    expect(uriA).not.toBe(uriB);
    expect(titleA.length).toBeGreaterThan(0);
  });

  it("悬停 a 的导航项 → 覆盖层出现，且内容是 a 的详情（不是 b、不是加载中）", async () => {
    expect(await hoverPanel()).toBeNull(); // 起始无覆盖层

    const probe = await hoverNavItem(uriA);
    expect(probe.found).toBe(true);
    expect(probe.hittable).toBe(true); // 该项真的可被鼠标命中

    const panel = await waitUntil(hoverPanel, (p) => p !== null, { label: "覆盖层出现" });
    expect(panel!.text).toContain(titleA);
    // 回归：全局 selectedTask 此刻指向 b（最后打开的 tab），旧实现会卡在「加载中…」
    expect(panel!.text).not.toContain("加载中");
  });

  it("是覆盖层：主区宽度不变（不挤压）", async () => {
    // 先确保无覆盖层，再量基线 —— 否则量到的基线本身带着覆盖层
    await leaveNavItem(uriA);
    await waitUntil(hoverPanel, (p) => p === null, { label: "覆盖层消失" });
    const before = await contentWidth();

    await hoverNavItem(uriA);
    const panel = await waitUntil(hoverPanel, (p) => p !== null, { label: "覆盖层出现" });
    expect(panel).not.toBeNull();
    expect(panel!.text).toContain(titleA);
    expect(await contentWidth()).toBe(before);
  });

  it("鼠标移走 → 覆盖层消失", async () => {
    await hoverNavItem(uriA);
    await waitUntil(hoverPanel, (p) => p !== null, { label: "覆盖层出现" });
    expect(await leaveNavItem(uriA)).toBe(true);
    // 隐藏有 180ms 延迟（给鼠标跨到面板上的时间），故用轮询而不是固定 sleep
    await waitUntil(hoverPanel, (p) => p === null, { label: "覆盖层消失" });
  });

  it("悬停 a（已开但**非激活**）→ 覆盖层换成 a 的详情（不是 b 的残留）", async () => {
    await hoverNavItem(uriA);
    const panel = await waitUntil(hoverPanel, (p) => p !== null, { label: "覆盖层出现" });
    expect(panel).not.toBeNull();
    expect(panel!.text).toContain(titleA);
    // a / b 是**顶级根任务**，各成一棵：a 的任务树块只含「自己 + 子孙」，不再平铺同级根
    // b（##258 / R4 收回了 RV-04 的越界）。断言仍只看**属性块**（属性块只属于当前任务；
    // b 残留时属性块会是 b 的标题）—— 与树块内容解耦，免得树的策略再变又得改这条。
    const attrsBlock = panel!.text.split("任务树")[0];
    expect(attrsBlock).toContain(titleA);
    expect(attrsBlock).not.toContain("另一个任务B");
  });

  it("详情主标题 = 14px 语义档 + 血缘树行链接带上 min-w-0（RV-02/RV-05）", async () => {
    // 覆盖层出着（上一用例 hover a 之后未 leave）—— 直接查；若已收则重新 hover
    if ((await hoverPanel()) === null) await hoverNavItem(uriA);
    const panel = await waitUntil(hoverPanel, (p) => p !== null, { label: "覆盖层在位" });
    // RV-02：h3 内 TaskNameLink 显示 14px（原硬编码 text-body=11px，压过 h3.text-title）
    const size = await ui.query<string>(`(() => {
      const aside = [...document.querySelectorAll('aside')].find(a => (a.getAttribute('aria-label')||'').includes('任务详情'));
      const link = aside && aside.querySelector('h3 button');
      return link ? getComputedStyle(link).fontSize : '';
    })()`);
    expect(size).toBe("14px");
    // RV-05：调用方传的 class（血缘树行 min-w-0）真实进了模板（原为死代码被丢弃）
    const rowLinkHasMinW = await ui.query<boolean>(`(() => {
      const aside = [...document.querySelectorAll('aside')].find(a => (a.getAttribute('aria-label')||'').includes('任务详情'));
      const link = aside && [...aside.querySelectorAll('button')].find(b =>
        String(b.className).includes('diy-link') && b.closest('div[title^="projects/"]'));
      return link ? String(link.className).includes('min-w-0') : false;
    })()`);
    expect(rowLinkHasMinW).toBe(true);
    expect(panel!.text).toContain(titleA);
  });

  it("覆盖层点 📋 → 任务表定位到**目标**任务 + 覆盖层立即收（RV-01/RV-06）", async () => {
    // 前置：覆盖层悬停 a（a 非激活）；当前激活仍是 b（活动 tab 的任务）
    if ((await hoverPanel()) === null) await hoverNavItem(uriA);
    await waitUntil(hoverPanel, (p) => p !== null, { label: "覆盖层在位" });
    const clicked = await ui.query<boolean>(`(() => {
      const aside = [...document.querySelectorAll('aside')].find(a => (a.getAttribute('aria-label')||'').includes('任务详情'));
      const btn = aside && [...aside.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '跳转任务管理');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    expect(clicked).toBe(true);
    // RV-01：flash 定位到**目标 a**（原缺陷：取活动 tab 的任务 b）
    await waitUntil(
      () =>
        ui.query<string | null>(
          `document.querySelector('[class*="outline-warning"][data-uri]')?.getAttribute('data-uri') ?? null`,
        ),
      (v) => v === uriA,
      { label: "任务表定位到目标 a（不是活动 tab 的 b）", timeoutMs: 6000 },
    );
    // RV-06：切页入口统一收覆盖层（原缺陷：残留到 mouseleave 才消失）
    await waitUntil(hoverPanel, (p) => p === null, { label: "覆盖层随切页立即收", timeoutMs: 4000 });
  });

  it("悬停 b（**当前激活**任务）→ 不弹覆盖层（详情已在屏上，##183 C-1）", async () => {
    // 先确保无激活干扰：激活 b（它本就是最后打开的 active）
    await fx.sh.getJson(`./diy.sh ui tab active task-run:${uriB}`);
    await leaveNavItem(uriA);
    await waitUntil(hoverPanel, (p) => p === null, { label: "覆盖层先清空" });

    await hoverNavItem(uriB);
    // 给足 180ms 延迟 + 余量：若会被弹，这段时间早该出现
    await new Promise((r) => setTimeout(r, 400));
    expect(await hoverPanel(), "悬停当前激活任务不该弹覆盖层").toBeNull();
  });
});
