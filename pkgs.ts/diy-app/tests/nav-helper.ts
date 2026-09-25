// tests/nav-helper.ts
// 侧栏（导航）测试的共用动作。
//
// 为什么单独成文件：多条意图测试都要走同一条**真人路径**——「鼠标移到侧栏 → 侧栏
// hover 展开 → 点顶栏的 pin 锁定」。这条路径有两个不能各自拍脑袋写的细节：
//   1. CDP 无法模拟 hover（见 ui-drive.hoverSelector 的说明），必须派发 DOM mouseenter
//   2. **不能在收起态直接点 pin**：收起态是 40px rail，没有按钮区；且按下瞬间侧栏
//      才展开、按钮已移位，down/up 落在不同元素上 → 点击不成立（实测抓到过）
import { waitUntil } from "./wait";
import type { UiDriver } from "./ui-drive";

/** 侧栏本体（DaisyUI drawer 的 .menu） */
export const NAV_MENU_SEL = ".drawer-side .menu";

/** 侧栏当前渲染宽度（px）；展开态是用户宽度，收起态是 40px rail */
export const navWidth = (ui: UiDriver): Promise<number> =>
  ui.query<number>(`Math.round(document.querySelector(${JSON.stringify(NAV_MENU_SEL)}).getBoundingClientRect().width)`);

/** 让鼠标「进入」侧栏，等它 hover 展开（返回时按钮区已就位、展开动画已走完） */
export async function hoverOpenNav(ui: UiDriver): Promise<void> {
  if (!(await ui.hoverSelector(NAV_MENU_SEL))) {
    throw new Error(`[nav-helper] 没找到侧栏: ${NAV_MENU_SEL}`);
  }
  await waitUntil(() => navWidth(ui), (w) => w > 100, { label: "侧栏 hover 展开" });
}

/** 锁定展开（pin）：hover 展开 → 点展开态顶栏的 pin → 等到进入锁定态 */
export async function lockNavOpen(ui: UiDriver): Promise<void> {
  await hoverOpenNav(ui);
  await ui.clickSelector('button[title="锁定展开"]');
  await waitUntil(
    () => ui.query<boolean>(`!!document.querySelector('.drawer-side button[title*="取消锁定"]')`),
    (v) => v,
    { label: "侧栏进入锁定态" },
  );
}

/**
 * 取消锁定（还原成「移开鼠标就收起」）。
 *
 * 只在侧栏**展开**时才有这个按钮（收起态没有按钮区），故先 hover 展开再点 ——
 * 直接用 DOM 派发 click 会绕开命中测试，宁可多两步。
 */
export async function unlockNav(ui: UiDriver): Promise<void> {
  await hoverOpenNav(ui);
  await ui.clickSelector('button[title*="取消锁定"]');
  await waitUntil(
    () => ui.query<boolean>(`!!document.querySelector('.drawer-side button[title="锁定展开"]')`),
    (v) => v,
    { label: "侧栏退出锁定态" },
  );
}
