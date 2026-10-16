// tests/cli.intent.ui-task-parent.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 任务树 / nav 操作增强（##356）——走真实 renderer
//
// 契约（用户能看见的行为）：
//   ① 三条父子入口都能点通：
//        a. 任务树行内 ＋ = **层级菜单**（新建子任务 / 添加已有任务为子任务）
//        b. 「添加已有任务为子任务」→ 选中某任务 → 它成为本行的子任务
//        c. 任务详情「父级」行 → 重设父节点（含「提升为一级任务」）
//   ② nav 任务项可置顶：钉住的项固定在最前，**不被新开的挤下去**；落视图 cache；关掉即剪枝
//   ③ NavSearch 弹层的 Tab 是**焦点陷阱**：焦点不跑到弹层外（Esc 仍只关这一层）
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type UiDriver } from "./ui-drive";
import { lockNavOpen, unlockNav } from "./nav-helper";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
let pid = "";
let A = "";
let B = "";

const taskRow = (uri: string) => `tr[data-uri="${uri}"]`;
const addBtn = (uri: string) => `${taskRow(uri)} [data-testid="task-add-menu-button"]`;
const MENU = `[data-testid="task-add-menu"]`;
const PICKER = `[data-testid="task-parent-picker"]`;

/** nav 里任务项的行序（行 div 的 title = 任务 uri） */
const navOrder = (): Promise<string[]> =>
  ui.query<string[]>(
    `Array.from(document.querySelectorAll('.drawer-side [title^="projects/"]'))
       .map((el) => el.getAttribute('title'))
       .filter((v, i, a) => a.indexOf(v) === i)`,
  );

/** 点某个任务项的置顶开关（按 uri 定位到它那一行）。
 *  ⚠️ 找行必须用 `div[title]`：**按钮自己也有 title**（「置顶（固定在上部）」），
 *  用裸 `[title]` 会命中按钮自身，永远匹配不到 uri。 */

async function clickPin(uri: string): Promise<void> {
  const nth = await ui.query<number>(
    `Array.from(document.querySelectorAll('[data-testid="nav-tab-pin"]'))
       .findIndex((b) => b.closest('div[title]')?.getAttribute('title') === ${JSON.stringify(uri)})`,
  );
  if (nth < 0) throw new Error(`[t356] nav 里找不到 ${uri} 的置顶按钮`);
  await ui.clickSelector('[data-testid="nav-tab-pin"]', { nth });
}

const pinnedCache = (): Promise<string[]> => ui.query<string[]>(`JSON.parse(localStorage.getItem('diy_nav_pinned') ?? '[]')`);

async function parentOf(uri: string): Promise<string> {
  const r = await fx.sh.getJson(`./diy.sh task show ${uri}`);
  const d = (r.data as any)?.data ?? {};
  return String(d.frontmatter?.parent ?? d.parent ?? "");
}

async function waitAppReady(): Promise<void> {
  await waitUntil(
    async () => ui.query<boolean>(`!!document.querySelector('.drawer-side .menu')`),
    (v) => v,
    { label: "侧栏渲染", timeoutMs: 20000 },
  );
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
  await lockNavOpen(ui);

  // 造数据：一个项目 + 两个一级任务（A 与 B 同项目，符合 main 的同项目约束）
  const p = await fx.sh.getJson(`./diy.sh project create ${HOME}/t356 --label T356`);
  pid = String((p.data as any)?.data?.id);
  await fx.sh.getJson(`./diy.sh task create 父任务A ${pid}`);
  await fx.sh.getJson(`./diy.sh task create 子任务B ${pid}`);
  const list = ((await fx.sh.getJson(`./diy.sh task list --project ${pid}`)).data as any).data.tasks as string[];
  A = list[0]!;
  B = list[1]!;
  // 任务表出现在页面上（默认路由就是任务管理页）
  await waitUntil(
    async () => ui.query<number>(`document.querySelectorAll('tr[data-uri]').length`),
    (n) => n >= 2,
    { label: "任务表出现两行", timeoutMs: 20000 },
  );
}, 120000);

afterAll(async () => {
  await ui?.close();
  await fx?.electron?.stop();
});

describe("① 任务树行内 ＋ = 层级菜单", () => {
  it("菜单有『新建子任务 / 添加已有任务为子任务』两项", async () => {
    await ui.clickSelector(addBtn(B));
    const text = await waitUntil(
      () => ui.query<string>(`document.querySelector(${JSON.stringify(MENU)})?.innerText ?? ""`),
      (t) => t.includes("新建子任务"),
      { label: "层级菜单弹出" },
    );
    expect(text).toContain("添加已有任务为子任务");
  });

  it("『添加已有任务为子任务』→ 选 A → A 挂到 B 下", async () => {
    await ui.clickSelector(`${MENU} [data-testid="task-add-menu-existing"]`);
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector(${JSON.stringify(PICKER)})`),
      (v) => v,
      { label: "任务选择器弹出" },
    );
    await ui.clickSelector(`[data-testid="task-parent-picker-item"][data-uri="${A}"]`);
    expect(await waitUntil(() => parentOf(A), (p) => p === B, { label: "A 的父变成 B", timeoutMs: 15000 })).toBe(B);
    // 选择器用完即关（不留一个盖住页面的浮层）
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector(${JSON.stringify(PICKER)})`),
      (v) => !v,
      { label: "选择器已关闭" },
    );
  });

  it("『新建子任务』→ 创建出来的任务直接挂在 B 下", async () => {
    await ui.clickSelector(addBtn(B));
    await waitUntil(
      () => ui.query<string>(`document.querySelector(${JSON.stringify(MENU)})?.innerText ?? ""`),
      (t) => t.includes("新建子任务"),
      { label: "层级菜单弹出" },
    );
    await ui.clickSelector(`${MENU} [data-testid="task-add-menu-new"]`);
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('dialog.modal[open] input')`),
      (v) => v,
      { label: "新建子任务对话框弹出" },
    );
    await ui.clickSelector('dialog.modal[open] input');
    await ui.type("新建的子任务C");
    await ui.clickSelector('dialog.modal[open] .btn-primary');
    const created = await waitUntil(
      async () => {
        const list = ((await fx.sh.getJson(`./diy.sh task list --project ${pid}`)).data as any).data.tasks as string[];
        return list.find((u) => u !== A && u !== B) ?? "";
      },
      (u) => !!u,
      { label: "新任务出现在列表" },
    );
    expect(await parentOf(created)).toBe(B);
  });
});

describe("① 任务详情重设父节点", () => {
  it("父级行显示当前父；重设为『（无）提升为一级任务』后生效", async () => {
    // A 此时挂在 B 下 → 任务表里默认折叠，先把 B 行展开（A 行才存在）
    if (!(await ui.query<boolean>(`!!document.querySelector('tr[data-uri="${A}"]')`))) {
      await ui.clickSelector(`${taskRow(B)} button[class*="w-5"]`);
    }
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('tr[data-uri="${A}"]')`),
      (v) => v,
      { label: "展开 B 后 A 行可见" },
    );
    // 选中 A（点任务表行标题）→ 详情面板上屏
    await ui.clickSelector(`${taskRow(A)} .diy-link`);
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('[data-task-detail-panel]')`),
      (v) => v,
      { label: "任务详情面板打开" },
    );
    const shown = await waitUntil(
      () => ui.query<string>(`document.querySelector('[data-testid="task-parent-edit"]')?.closest('.task-field-row')?.innerText ?? ""`),
      (t) => t.includes("父级"),
      { label: "父级行出现" },
    );
    expect(shown).toContain("子任务B"); // 当前父的名字（来自任务树现查）

    await ui.clickSelector('[data-testid="task-parent-edit"]');
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector(${JSON.stringify(PICKER)})`),
      (v) => v,
      { label: "重设父选择器弹出" },
    );
    await ui.clickSelector('[data-testid="task-parent-picker-root"]');
    expect(await waitUntil(() => parentOf(A), (p) => p === "", { label: "A 成为一级任务", timeoutMs: 15000 })).toBe("");
  });
});

describe("② nav 任务项置顶", () => {
  it("置顶后固定在最前，且新开的 tab 挤不掉它", async () => {
    await fx.sh.getJson(`./diy.sh ui tab open ${A}`);
    await fx.sh.getJson(`./diy.sh ui tab open ${B}`);
    await waitUntil(async () => (await navOrder()).length, (n) => n === 2, { label: "nav 出现两个任务项" });

    const before = await navOrder();
    const pinnedOne = before[before.length - 1]!; // 钉住排在**最后**那一项：它前移才说明置顶真的生效
    await clickPin(pinnedOne);
    const order = await waitUntil(navOrder, (o) => o[0] === pinnedOne, { label: "置顶项移到最前" });
    expect(order[0]).toBe(pinnedOne);
    expect(await pinnedCache()).toContain(`task-run:${pinnedOne}`);

    // 跨重启保持（验收②）：**重载渲染进程** —— 置顶集合住在 localStorage，重载后
    // 仍固定在最前（缓存丢了才需要重钉，那说明落位选错了）。
    await ui.eval("location.reload()");
    await waitAppReady();
    await lockNavOpen(ui);
    await waitUntil(async () => (await navOrder()).length, (n) => n >= 2, { label: "重载后 nav 恢复" });
    expect((await navOrder())[0]).toBe(pinnedOne);

    // 新开一个 tab（D），置顶项仍固定在第一 —— 这正是「不被新开的挤下去」的判据
    await fx.sh.getJson(`./diy.sh task create 挤一挤D ${pid}`);
    const list = ((await fx.sh.getJson(`./diy.sh task list --project ${pid}`)).data as any).data.tasks as string[];
    const D = list[list.length - 1]!;
    await fx.sh.getJson(`./diy.sh ui tab open ${D}`);
    await waitUntil(async () => (await navOrder()).length, (n) => n >= 3, { label: "第三个任务项出现" });
    expect((await navOrder())[0]).toBe(pinnedOne);

    // 收尾：关掉置顶项 → 置顶键被剪掉（不留历史垃圾）
    await fx.sh.getJson(`./diy.sh ui tab close task-run:${pinnedOne}`);
    await waitUntil(
      pinnedCache,
      (keys) => !keys.includes(`task-run:${pinnedOne}`),
      { label: "关掉的 tab 被剪出置顶集合" },
    );
  });
});

describe("③ NavSearch 焦点陷阱", () => {
  it("Tab / Shift+Tab 都在弹层内循环，Esc 只关这一层", async () => {
    await ui.clickSelector('[data-testid="nav-search-open"]');
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('[data-testid="nav-search-panel"]')`),
      (v) => v,
      { label: "搜索弹层打开" },
    );
    // 敲一个词让列表出现可聚焦项（只靠 input 时 Tab 陷阱不明显）
    await ui.type("父任务");
    await waitUntil(
      () => ui.query<number>(`document.querySelectorAll('[data-testid="nav-search-item"]').length`),
      (n) => n > 0,
      { label: "搜索有命中" },
    );
    const inside = () =>
      ui.query<boolean>(`!!document.querySelector('[data-testid="nav-search-panel"]')?.contains(document.activeElement)`);
    for (let i = 0; i < 6; i++) {
      await ui.press("Tab");
      expect(await inside()).toBe(true);
    }
    for (let i = 0; i < 4; i++) {
      await ui.press("Shift+Tab");
      expect(await inside()).toBe(true);
    }
    // Esc：弹层关掉，且焦点归还触发元素
    await ui.press("Escape");
    await waitUntil(
      () => ui.query<boolean>(`!!document.querySelector('[data-testid="nav-search-panel"]')`),
      (v) => !v,
      { label: "Esc 关闭弹层" },
    );
    // 侧栏仍在（Esc 没顺手把别的东西也关了）
    expect(await ui.query<boolean>(`!!document.querySelector('.drawer-side .menu')`)).toBe(true);
    await unlockNav(ui);
  });
});
