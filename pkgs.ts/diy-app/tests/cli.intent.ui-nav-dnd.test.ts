// tests/cli.intent.ui-nav-dnd.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 nav 任务项拖拽改父子的**行为**契约（任务 242 / ##87，用户 2026-10-03 澄清）
//
// 需求原文：「就是只在nav间拖动改变parent关系，不拖动到其他view/page」
//
// 契约（用户能看见的行为）：
//   1. 展开态 nav 里把任务 B 拖到任务 A 上 → B 成为 A 的子任务
//      （task move 生效：树上 parentUri 变化 —— 数据层真值）
//   2. 拖完 nav 缩进**自动跟上**（树变 → tabStore 祖先链重算，##159 链路）：
//      B 的 nav 行 paddingLeft 从顶级(28px) 变为子级(42px)
//   3. 拖拽不破坏 tab 本身：拖完 B 的 tab 仍打开、可点
//
// 语义边界（与任务管理树同款，TaskTree handleDragEnd）：
//   同项目校验 / 拖到直接父级 no-op / 同任务多 tab 互拖 no-op。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode, type UiDriver } from "./ui-drive";
import { lockNavOpen } from "./nav-helper";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;
let PID = "";
let uriA = "";
let uriB = "";

beforeAll(async () => {
  const electron = await startElectronTest();
  const HOME = electron.home;
  fx = {
    electron,
    HOME,
    sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
  };
  ui = await makeUiDriver(fx.electron.cdpUrl, () => a11y());

  const p = await fx.sh.getJson(`./diy.sh ui project create ${HOME}/navdnd-repo --label 拖拽项目`);
  PID = String((p.data as any)?.data?.id);
  const mk = async (title: string): Promise<string> => {
    const r = await fx.sh.getJson(`./diy.sh task create ${title} ${PID}`);
    return String((r.data as any)?.data?.uri);
  };
  uriA = await mk("根甲");
  uriB = await mk("根乙");
  // 两个都开成 nav tab（拖拽对象是「已打开的任务项」）
  await fx.sh.getJson(`./diy.sh ui tab open ${uriA}`);
  await fx.sh.getJson(`./diy.sh ui tab open ${uriB}`);
});

afterAll(async () => {
  ui?.close();
  await fx?.electron?.stop();
});

async function a11y(): Promise<A11yNode | undefined> {
  const r = await fx.sh.getJson("./diy.sh ui inspect");
  return (r.data as any)?.data?.tree as A11yNode | undefined;
}

/** ui tree：JSON {status, data: 节点数组} —— 层级靠 children 嵌套，节点无 parentUri */
async function tree(): Promise<any[]> {
  const r = await fx.sh.getJson("./diy.sh ui tree");
  return ((r.data as any)?.data ?? []) as any[];
}
/** 某任务的直接父 uri：null=顶层，undefined=树里找不到（与「确是顶层」区分开） */
function parentOf(nodes: any[], uri: string, parentUri?: string): string | null | undefined {
  for (const n of nodes ?? []) {
    if (n.uri === uri) return parentUri ?? null;
    const f = parentOf(n.children ?? [], uri, n.uri ?? parentUri);
    if (f !== undefined) return f;
  }
  return undefined;
}

/** nav 展开态任务项的中心坐标（限定侧栏内 —— 主区血缘树同 title 会撞） */
async function navItemCenter(uri: string): Promise<{ x: number; y: number }> {
  const c = await ui.query<{ x: number; y: number } | null>(
    `(() => {
      const nav = document.querySelector('.drawer-side .menu');
      if (!nav) return null;
      const el = [...nav.querySelectorAll('div[title]')].find(d => d.getAttribute('title') === ${JSON.stringify(uri)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 4) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`,
  );
  if (!c) throw new Error(`[nav-dnd] 侧栏里找不到任务项: ${uri}`);
  return c;
}

/** nav 项的 padding-left（缩进真值：顶级 28 / 子级 42） */
const navPadLeft = (uri: string) =>
  ui.query<number>(
    `(() => {
      const nav = document.querySelector('.drawer-side .menu');
      const el = nav && [...nav.querySelectorAll('div[title]')].find(d => d.getAttribute('title') === ${JSON.stringify(uri)});
      return el ? Math.round(parseFloat(el.style.paddingLeft)) : -1;
    })()`,
  );

describe("nav 任务项拖拽改父子", () => {
  it("拖 B → A：B 成为 A 的子任务，nav 缩进自动跟上", async () => {
    // 前置：两任务都是顶级；侧栏 pin 锁定展开（拖拽需要看得见的项）
    expect(await tree()).not.toEqual([]);
    expect(parentOf(await tree(), uriB)).toBe(null); // 前置：B 顶层
    await lockNavOpen(ui);
    expect(await navPadLeft(uriB)).toBe(28); // 顶级缩进

    const from = await navItemCenter(uriB);
    const to = await navItemCenter(uriA);
    await ui.drag(from, to, 10);

    // 数据真值：task move 生效（B 被嵌进 A 的 children）
    await waitUntil(async () => parentOf(await tree(), uriB), (v) => v === uriA, {
      label: "B 的 parent 变为 A",
      timeoutMs: 5000,
    });
    expect(parentOf(await tree(), uriB)).toBe(uriA);

    // nav 缩进跟上（28 → 42，##159 响应式链）
    await waitUntil(() => navPadLeft(uriB), (v) => v === 42, { label: "B 的 nav 缩进变子级", timeoutMs: 3000 });
    expect(await navPadLeft(uriB)).toBe(42);

    // 拖拽不破坏 tab：B 的 tab 仍在（tab list 含它）
    const tabs = await fx.sh.getJson("./diy.sh ui tab list");
    const opened = ((tabs.data as any)?.data?.opened ?? []) as string[];
    expect(opened).toContain(`task-run:${uriB}`);
  }, 30_000);

  it("拖到直接父级 = no-op（已是子级，不动数据）", async () => {
    // 此时 B 已是 A 的子级 —— 再拖到 A 上应无操作（parent 不变、树不重建扰动）
    const before = parentOf(await tree(), uriB);
    expect(before).toBe(uriA); // 用例1 已完成的前提
    const from = await navItemCenter(uriB);
    const to = await navItemCenter(uriA);
    await ui.drag(from, to, 10);
    await new Promise((r) => setTimeout(r, 800));
    expect(parentOf(await tree(), uriB)).toBe(uriA);
  }, 30_000);
});
