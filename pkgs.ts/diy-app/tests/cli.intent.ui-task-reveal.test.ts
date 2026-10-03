// tests/cli.intent.ui-task-reveal.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 「切到任务管理 → 展开当前任务所在树节点并定位到它」的**行为**契约（##160）
//
// 需求原文：「切换到任务管理后当前任务没有正确展开所在 tree node、定位到当前任务行」
//
// 契约（用户能看见的行为）：
//   1. 从某任务的会话页点「任务管理」→ 该任务的**全部任务祖先自动展开**，任务行出现在树里
//   2. 该行被**定位到可视区**并**闪一下高亮**（2s 后自动消失，不留常驻噪音）
//   3. 已在任务管理页时再次点「任务管理」→ 重新定位（nonce 重触发，不是「只有第一次生效」）
//
// 关键前提：任务树默认**折叠**，故「祖先展开」只能来自本机制，不是默认态。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
let PID = "";

/** 建一棵三层树：t1 根 → t2 → t3（孙），用于验证「祖先链展开」 */
let t1 = "";
let t2 = "";
let t3 = "";

beforeAll(async () => {
  const electron = await startElectronTest();
  const HOME = electron.home;
  fx = {
    electron,
    HOME,
    sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
  };
  ui = await makeUiDriver(fx.electron.cdpUrl, () => a11y());

  const p = await fx.sh.getJson(`./diy.sh ui project create ${HOME}/reveal-repo --label 定位项目`);
  PID = String((p.data as any)?.data?.id);

  const mk = async (title: string, parent?: string): Promise<string> => {
    const cmd = `./diy.sh task create ${title} ${PID}${parent ? ` --parent ${parent}` : ""}`;
    const r = await fx.sh.getJson(cmd);
    return String((r.data as any)?.data?.uri);
  };
  t1 = await mk("根任务");
  t2 = await mk("子任务", t1);
  t3 = await mk("孙任务", t2);
});

afterAll(async () => {
  await fx?.electron?.stop();
});

async function a11y(): Promise<A11yNode | undefined> {
  const r = await fx.sh.getJson("./diy.sh ui inspect");
  return (r.data as any)?.data?.tree as A11yNode | undefined;
}

/** 树里任务行的 uri 顺序（上→下），从真实 DOM 读 */
function rowOrder(): Promise<string[]> {
  return ui.query<string[]>(
    `Array.from(document.querySelectorAll('tbody tr[data-uri]')).map(tr => tr.getAttribute('data-uri'))`,
  );
}

/** 某任务行的 class 列表 */
function rowClass(uri: string): Promise<string> {
  return ui.query<string>(`document.querySelector('tbody tr[data-uri=${JSON.stringify(uri)}]')?.className ?? ""`);
}

/** 某任务行是否落在树滚动容器可视区内 */
function rowInViewport(uri: string): Promise<boolean> {
  return ui.query<boolean>(`(() => {
    const tr = document.querySelector('tbody tr[data-uri=${JSON.stringify(uri)}]');
    const box = document.querySelector('div[tabindex="0"].overflow-auto');
    if (!tr || !box) return false;
    const r = tr.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return r.top >= b.top - 1 && r.bottom <= b.bottom + 1 && r.height > 0;
  })()`);
}

/** 点导航「任务管理」（走真实命中测试；收起态 rail 也能点到，故不依赖侧栏展开） */
async function goTaskManager(): Promise<void> {
  await ui.clickSelector('.drawer-side button[title="任务管理"]');
}

/** 已打开的 tab（active = 当前上屏的页） */
async function tabs(): Promise<{ opened: string[]; active: string }> {
  const r = await fx.sh.getJson("./diy.sh ui tab list");
  return (r.data as any)?.data ?? { opened: [], active: "" };
}

/** 等树渲染出任务行（应用异步挂载，首个命令可能早于 DOM） */
async function waitRowsReady(): Promise<void> {
  await waitUntil(async () => (await rowOrder()).length, (n) => n > 0, {
    label: "任务树渲染出任务行",
    timeoutMs: 8000,
  });
}

describe("任务管理：定位当前任务（##160）", () => {
  it("从会话页切到任务管理 → 祖先链自动展开、目标行定位并高亮", async () => {
    // 打开孙任务 t3 的会话 tab 并**切到该页**（openTab action 会 setRoute）——
    // 这才是「当前在会话页」的前提；只开不切，reveal 走的是 selectedUri 兜底，验不到主路径。
    await fx.sh.getJson(`./diy.sh ui tab open task-run:${t3}`);
    await waitUntil(() => tabs(), (t) => t.active === `task-run:${t3}`, {
      label: "会话页 tab 打开且成为 active",
      timeoutMs: 8000,
    });
    // 把展开缓存清空：保证随后看到的「祖先展开」只能来自 reveal 机制（任务默认折叠）
    await ui.query(`(() => { localStorage.setItem("diy_task_tree_expanded", "[]"); return true; })()`);

    await goTaskManager();
    await waitRowsReady();

    // 契约 1：祖先链 t1 → t2 → t3 全部出现在树里，且按树序
    const order = await waitUntil(rowOrder, (o) => o.includes(t3) && o.includes(t2) && o.includes(t1), {
      label: "祖先链展开：t1/t2/t3 都可见",
    });
    const i1 = order.indexOf(t1);
    const i2 = order.indexOf(t2);
    const i3 = order.indexOf(t3);
    expect(i1, "t1 在 t2 前").toBeLessThan(i2);
    expect(i2, "t2 在 t3 前").toBeLessThan(i3);

    // 契约 2a：目标行被高亮（outline 闪一下）
    const cls = await rowClass(t3);
    expect(cls, `t3 行应带定位高亮，实际 class: ${cls}`).toContain("outline-warning");

    // 契约 2b：目标行落在可视区（定位，不只是渲染出来）
    expect(await rowInViewport(t3), "t3 行应落在树滚动容器可视区内").toBe(true);
  });

  it("高亮 2s 后自动消失（不留常驻噪音）", async () => {
    const cleared = await waitUntil(rowClass.bind(null, t3), (c) => !c.includes("outline-warning"), {
      label: "定位高亮自动消失",
      timeoutMs: 4000,
    });
    expect(cleared).not.toContain("outline-warning");
  });

  it("已在任务管理页时再次点「任务管理」→ 重新定位（nonce 重触发）", async () => {
    // 先折叠 t1（点它行内的折叠按钮），t2/t3 随之隐藏
    await ui.clickSelector(`tbody tr[data-uri=${JSON.stringify(t1)}] button`, { nth: 0 });
    await waitUntil(rowOrder, (o) => !o.includes(t3), { label: "折叠 t1 后 t3 隐藏" });

    // 再次点「任务管理」→ 应重新展开并定位到当前任务（t3，此时 selectedUri 仍是它）
    await goTaskManager();
    const order = await waitUntil(rowOrder, (o) => o.includes(t3), { label: "再点导航重建展开" });
    expect(order.indexOf(t1)).toBeLessThan(order.indexOf(t3));
    const cls = await rowClass(t3);
    expect(cls, `t3 行应再次带定位高亮，实际 class: ${cls}`).toContain("outline-warning");
  });
});
