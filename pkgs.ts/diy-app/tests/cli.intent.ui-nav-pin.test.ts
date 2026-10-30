// tests/cli.intent.ui-nav-pin.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 nav 置顶（##356 ②）的两条**跨项目 / 层级**契约（##466 回归）
//
// 用户报的两个 bug（真实数据复现过）：
//   ① `projects/14/tasks/1` 置顶后到不了 nav 顶部 —— 因为置顶当时只在**组内**做，
//      另一个项目组排在前面就永远压着它（实测：置顶后仍在第 39 行）。
//   ② `projects/4/tasks/166` 置顶后被读成 `266` 的父级 —— 因为缩进按「开着的祖先个数」算，
//      266 的父 87 虽然开着但被置顶挤到了别处，266 于是带着 1 级缩进坐在 166 下面。
//
// 判据（走真实 renderer + 真实点击）：
//   · 跨项目置顶 → 该项进入最上的置顶段（行序第 1）；刷新后仍在
//   · 置顶把子任务/祖先拆开后，缩进不再指向无关任务（顶层行的 padding-left = 28px）
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type UiDriver } from "./ui-drive";
import { lockNavOpen } from "./nav-helper";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
/** 项目 1（组序在前）里的任务 */
let A = "";
/** 项目 2（组序在后）里的任务 —— 跨项目置顶的主角 */
let E = "";
/** 同项目里的父子对（验缩进不说谎） */
let P = "";
let C = "";

/** nav 里任务项的行序（行 div 的 title 首行 = 任务 uri；##358 起 title 可能带会话状态第二行） */
const navOrder = (): Promise<string[]> =>
  ui.query<string[]>(
    `Array.from(document.querySelectorAll('.drawer-side [data-nav-tab]'))
       .map((el) => el.getAttribute('data-nav-tab'))
       .filter((v, i, a) => a.indexOf(v) === i)`,
  );

/** 某任务行当前的左内边距（px）：顶层 = 28，每多一层 +14（见 App 的 indentPx） */
const rowPadLeft = (uri: string): Promise<number> =>
  ui.query<number>(
    `(() => {
       const el = Array.from(document.querySelectorAll('.drawer-side [data-nav-tab]'))
         .find((e) => e.getAttribute('data-nav-tab') === ${JSON.stringify(uri)});
       return el ? parseFloat(getComputedStyle(el).paddingLeft) : -1;
     })()`,
  );

/** 点某个任务项的置顶开关（按 uri 定位到它那一行） */
async function clickPin(uri: string): Promise<void> {
  const nth = await ui.query<number>(
    `Array.from(document.querySelectorAll('[data-testid="nav-tab-pin"]'))
       .findIndex((b) => (b.closest('div[title]')?.getAttribute('title') ?? '').split('\\n')[0] === ${JSON.stringify(uri)})`,
  );
  if (nth < 0) throw new Error(`[t466] nav 里找不到 ${uri} 的置顶按钮`);
  await ui.clickSelector('[data-testid="nav-tab-pin"]', { nth });
}

async function waitAppReady(): Promise<void> {
  await waitUntil(
    async () => ui.query<boolean>(`!!document.querySelector('.drawer-side .menu')`),
    (v) => v,
    { label: "侧栏渲染", timeoutMs: 20000 },
  );
}

/** 开一个 tab 并等它出现在 nav 里 */
async function openTab(uri: string): Promise<void> {
  const before = (await navOrder()).length;
  await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
  await waitUntil(async () => (await navOrder()).length, (n) => n > before, { label: `nav 出现 ${uri}` });
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

  // 项目 1（先出现 → 组序在前的那个）
  const p1 = await fx.sh.getJson(`./diy.sh project create ${HOME}/t466-a --label T466A`);
  const pid1 = String((p1.data as any)?.data?.id);
  await fx.sh.getJson(`./diy.sh task create 甲项目任务A ${pid1}`);
  const list1 = ((await fx.sh.getJson(`./diy.sh task list --project ${pid1}`)).data as any).data.tasks as string[];
  A = list1[0]!;

  // 项目 2（后出现 → 组序在后；它的任务置顶时必须能跨到最顶）
  const p2 = await fx.sh.getJson(`./diy.sh project create ${HOME}/t466-b --label T466B`);
  const pid2 = String((p2.data as any)?.data?.id);
  await fx.sh.getJson(`./diy.sh task create 乙项目任务E ${pid2}`);
  await fx.sh.getJson(`./diy.sh task create 乙项目子任务C ${pid2}`);
  const list2 = ((await fx.sh.getJson(`./diy.sh task list --project ${pid2}`)).data as any).data.tasks as string[];
  E = list2.find((u: string) => !list1.includes(u) && ![A].includes(u))!;
  C = list2.find((u: string) => u !== E)!;
  // 建完才知道 uri → 补一次父子关系（同项目约束由 task edit 校验）
  await fx.sh.getJson(`./diy.sh task edit ${C} --parent ${E}`);
  P = E;
  // 父子关系必须真的落盘（否则后面的缩进断言测的是空气）
  const show = await fx.sh.getJson(`./diy.sh task show ${C}`);
  const fm = (show.data as any)?.data?.frontmatter ?? (show.data as any)?.data ?? {};
  if (String(fm.parent ?? "") !== E) throw new Error(`[t466] 夹具失败：${C} 的 parent=${JSON.stringify(fm.parent)}，期望 ${E}`);
  // 等任务树把新父子关系刷进 renderer（fileWatcher 500ms 防抖）
  await new Promise((r) => setTimeout(r, 1200));

  await waitUntil(
    async () => ui.query<number>(`document.querySelectorAll('tr[data-uri]').length`),
    (n) => n >= 2,
    { label: "任务表出现", timeoutMs: 20000 },
  );
}, 120000);

afterAll(async () => {
  await ui?.close();
  await fx?.electron?.stop();
});

describe("① 跨项目置顶（##466 ①）", () => {
  it("置顶后进入最上的置顶段，刷新后仍在", async () => {
    await openTab(A); // 项目 1 的任务先开 → 项目 1 组排在前面
    await openTab(E); // 项目 2 的任务：不置顶时天然在它自己那组里，位置靠后
    expect((await navOrder()).indexOf(E)).toBeGreaterThan((await navOrder()).indexOf(A));

    await clickPin(E);
    const order = await waitUntil(navOrder, (o) => o[0] === E, { label: "跨项目置顶到 nav 最顶" });
    expect(order[0]).toBe(E);

    // 刷新（重载渲染进程）后仍在最顶 —— 置顶集合住 localStorage
    await ui.eval("location.reload()");
    await waitAppReady();
    await lockNavOpen(ui);
    expect(await waitUntil(navOrder, (o) => o[0] === E, { label: "重载后仍在最顶" })).toContain(E);
  });
});

describe("② 置顶不改层级（##466 ②）", () => {
  it("子任务被置顶到顶部、父不在置顶段 → 不缩进（不挂到无关任务下面）", async () => {
    // ① 里把 E（= C 的父）钉住了：先取消，让父子回到同一个项目段里
    if ((await navOrder())[0] === E) await clickPin(E);
    await waitUntil(navOrder, (o) => o[0] !== E, { label: "取消置顶 E" });

    // 先开父再开子：正常顺序里子任务缩进一级（28 + 14 = 42）
    await openTab(P);
    await openTab(C);
    expect(await waitUntil(() => rowPadLeft(C), (px) => px === 42, { label: "子任务正常缩进一级" })).toBe(42);

    // 只钉子任务：它被提到置顶段，父留在项目组里 → 顶部那段里它上面没有任何祖先
    await clickPin(C);
    const order = await waitUntil(navOrder, (o) => o[0] === C, { label: "子任务置顶到最顶" });
    expect(order[0]).toBe(C);
    // 缩进必须是顶层（28），否则就是在说「它是下面那一项的子」
    expect(await rowPadLeft(C)).toBe(28);

    // 父仍在项目组里且保持顶层缩进（置顶不改任务树，也不改父的层级）
    expect(await rowPadLeft(P)).toBe(28);
    // 收尾：取消置顶（还原，便于重跑）
    await clickPin(C);
  });
});
