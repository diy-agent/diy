// tests/nav-helper.ts
// 侧栏（导航）测试的共用动作。
//
// 为什么单独成文件：多条意图测试都要走同一条**真人路径**——「鼠标移到侧栏 → 侧栏
// hover 展开 → 点顶栏的 pin 锁定」。这条路径有两个不能各自拍脑袋写的细节：
//   1. CDP 无法模拟 hover（见 ui-drive.hoverSelector 的说明），必须派发 DOM mouseenter
//   2. **不能在收起态直接点 pin**：收起态是 40px rail，没有按钮区；且按下瞬间侧栏
//      才展开、按钮已移位，down/up 落在不同元素上 → 点击不成立（实测抓到过）
//
// ⚠️ 这里所有动作**必须有终态校验 + 重试**，不能只发事件就返回：
//   实测事故 —— 从前的 lockNavOpen 发完 click 就 `waitUntil(...)`（到上限只返回、
//   不抛错），pin 没锁上却一路"成功"返回。测试随后把鼠标拖到侧栏之外（那本来就是
//   在拖宽度），hover 展开态于是被 mouseleave 收拢 → 断言看到宽度 40，报错却指向
//   拖拽那段代码，排查方向被带偏。故：每个动作要么到位，要么抛错说清现状。
import { waitUntil } from "./wait";
import type { UiDriver } from "./ui-drive";

/** 侧栏本体（DaisyUI drawer 的 .menu） */
export const NAV_MENU_SEL = ".drawer-side .menu";
/** 收起态 rail 宽度（px）：2.5rem */
export const NAV_RAIL_W = 40;

/** 侧栏当前渲染宽度（px）；展开态是用户宽度，收起态是 40px rail */
export const navWidth = (ui: UiDriver): Promise<number> =>
  ui.query<number>(`Math.round(document.querySelector(${JSON.stringify(NAV_MENU_SEL)}).getBoundingClientRect().width)`);

/** 是否已锁定展开（pin 处于「取消锁定」态） */
export const navLocked = (ui: UiDriver): Promise<boolean> =>
  ui.query<boolean>(`!!document.querySelector('.drawer-side button[title*="取消锁定"]')`);

/** 是否处于可锁定的展开态（pin 处于「锁定展开」态） */
const pinOffered = (ui: UiDriver): Promise<boolean> =>
  ui.query<boolean>(`!!document.querySelector('.drawer-side button[title="锁定展开"]')`);

/** 当前按钮区状态，用于报错时还原现场 */
async function navState(ui: UiDriver): Promise<string> {
  return `宽度=${await navWidth(ui)}px, 锁定=${(await navLocked(ui)) ? "是" : "否"}, ` +
    `pin=${(await pinOffered(ui)) ? "锁定展开" : "（无）"}`;
}

/**
 * 让鼠标「进入」侧栏，等它 hover 展开；到上限仍未展开则抛错（不静默继续）。
 *
 * 每次调用都重新派发 mouseenter：真实鼠标事件（测试里点击/拖拽会发）可能已把 hover
 * 态改掉，重试时必须重新建立这个前提，否则重试毫无意义。
 */
export async function hoverOpenNav(ui: UiDriver): Promise<void> {
  if (!(await ui.hoverSelector(NAV_MENU_SEL))) {
    throw new Error(`[nav-helper] 没找到侧栏: ${NAV_MENU_SEL}`);
  }
  await waitUntil(() => navWidth(ui), (w) => w > 100, { label: "侧栏 hover 展开", timeoutMs: 3000 });
  const w = await navWidth(ui);
  if (w <= 100) throw new Error(`[nav-helper] 侧栏未 hover 展开：${await navState(ui)}`);
}

/**
 * 锁定展开（pin）：hover 展开 → 点展开态顶栏的 pin → 校验进入锁定态。
 *
 * 为什么要重试：pin 的点击是真实鼠标事件（走命中测试），而侧栏展开是带过渡的——
 * 按钮在过渡中会移位，down/up 有可能落在不同元素上 → 点击不成立。加载重的整仓跑
 * 时更容易撞上（单独跑这个文件却总是过）。重试前先重新 hover、并先查一次是否已锁定
 * （避免把「其实已经锁上、只是校验慢了」误判成失败后**再点一次把它解锁**）。
 */
export async function lockNavOpen(ui: UiDriver, attempts = 3): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    await hoverOpenNav(ui);
    if (await navLocked(ui)) return;
    await ui.clickSelector('button[title="锁定展开"]');
    if (await waitUntil(() => navLocked(ui), (v) => v, { label: "侧栏进入锁定态", timeoutMs: 1500 })) return;
  }
  throw new Error(`[nav-helper] 锁定侧栏失败（试了 ${attempts} 次）：${await navState(ui)}`);
}

/**
 * 取消锁定（还原成「移开鼠标就收起」）。
 *
 * 只在侧栏**展开**时才有这个按钮（收起态没有按钮区），故先 hover 展开再点。
 * 用真实点击（不派发 DOM click）—— 否则绕开命中测试，测不出「按钮其实被遮住/移走」。
 */
export async function unlockNav(ui: UiDriver, attempts = 3): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    await hoverOpenNav(ui);
    if (!(await navLocked(ui))) return; // 已解锁（pin 回到「锁定展开」）
    await ui.clickSelector('button[title*="取消锁定"]');
    if (await waitUntil(() => pinOffered(ui), (v) => v, { label: "侧栏退出锁定态", timeoutMs: 1500 })) return;
  }
  throw new Error(`[nav-helper] 取消锁定失败（试了 ${attempts} 次）：${await navState(ui)}`);
}
