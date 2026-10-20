// tests/cli.intent.env-bar.test.ts
// ═══════════════════════════════════════════════════════════════
// ##384「环境感知」的**界面**契约 —— 真实 renderer + 真实 RPC。
//
// 用户原话：「刚才磁盘满了后出现几次卡住，需要更明确的识别…… 磁盘满这种极端情况，我们是否
// 能侦测并下次 pagebar 弹红色 error 提示之类的，类似网断了，磁盘满了。」
//
// 契约（用户能看见的行为）：
//   1. 磁盘满 → 顶栏**红条**，且**带数字**（可用/总量）、**带该干什么**（腾空间）
//   2. ✕ 关掉后**不再回放**（条件不变不弹 —— 否则 30s 轮询一次，✕ 等于没关）
//   3. 空间恢复 → 红条**自动消**（不要用户手动关）
//   4. 多条件共存 → **堆叠**（磁盘满与网断可以同时发生，只显示一条会漏掉另一件急事）
//   5. 订阅即回放（页面重载后红条能自己回来）
//
// 为什么用 `env simulate` 而不是真填盘/真断网：真填盘会毁现场数据（2026-10-18 已毁过
// ##166 正文一次），真断网会把本机所有实例一起搞断。simulate 走的是与真事件**同一条**判据 +
// 同一个 ring + 同一个 bar，差别只在事实来源 —— 这是唯一可复现的活体验证（判据本身的穷举
// 在 tests/core/env-watch.test.ts）。
//
// ⚠️ 每条磁盘事实都给**显式 mount**（`--disk-mount /probe`）：缺省 mount 是进程的探测目标
// （`/`），而 30s 轮询会按真实水位把它 resolve 掉 —— 用例会在负载高时偶发假红。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type UiDriver } from "./ui-drive";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
/** 探针挂载点：与轮询目标（`/`）分开，轮询不会误撤注入的事实 */
const PROBE_MOUNT = "/probe-tiny";

/** bar 上所有条目（type 列表 + 整条文本），直读 DOM（a11y 树对长文本有截断） */
const barState = () =>
  ui.query<{ types: string[]; text: string }>(`(() => {
    const root = document.querySelector('[data-env-status-bar]');
    if (!root) return { types: [], text: '' };
    const items = [...root.querySelectorAll('[data-env-status-bar-item]')];
    return {
      types: items.map((el) => el.getAttribute('data-env-status-bar-item')),
      text: root.textContent || '',
    };
  })()`);

/** 等 bar 里出现某 type 的条目 */
async function waitBar(type: string, present: boolean): Promise<{ types: string[]; text: string }> {
  return waitUntil(
    barState,
    (s) => s.types.includes(type) === present,
    { label: `bar ${type} ${present ? "出现" : "消失"}`, timeoutMs: 8000 },
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
    return ((r.data as Record<string, unknown>)?.data as Record<string, unknown>)?.tree as never;
  });
}, 120_000);

afterAll(async () => {
  ui?.close();
  await fx?.electron?.stop();
});

describe("##384 环境感知顶栏 bar", () => {
  it("磁盘满 → 红条出现，且带数字证据 + 该干什么", async () => {
    const r = await fx.sh.getJson(
      `./diy.sh env simulate --disk-avail ${100 * MiB} --disk-total ${500 * GiB} --disk-mount ${PROBE_MOUNT}`,
    );
    // getJson 返回的就是 `{ ok, data }` 那一层
    expect((r as any).ok).toBe(true);
    expect((r as any).data?.notice?.type).toBe("disk-full");

    const s = await waitBar("disk-full", true);
    // 数字证据（"更明确的识别"= 给数字，不是给形容词）
    expect(s.text).toContain("磁盘已满");
    expect(s.text).toContain(PROBE_MOUNT);
    expect(s.text).toContain("100.0 M");
    expect(s.text).toContain("500.0 G");
    // 该干什么
    expect(s.text).toContain("腾空间");
    // 红系（error）：用户原话「弹红色 error 提示」
    const cls = await ui.query<string>(
      `document.querySelector('[data-env-status-bar-item="disk-full"]').className`,
    );
    expect(cls).toContain("border-error");
  });

  it("✕ 关掉后不再回放：条件不变再注入也不弹（否则 30s 轮询一次，✕ 等于没关）", async () => {
    await ui.clickSelector(`[data-env-status-bar-item="disk-full"] button`);
    await waitBar("disk-full", false);

    // 同一条件再注入一次：main 侧已静音该槽 → 不该重新弹
    await fx.sh.getJson(
      `./diy.sh env simulate --disk-avail ${100 * MiB} --disk-total ${500 * GiB} --disk-mount ${PROBE_MOUNT}`,
    );
    // 给一轮渲染机会再断言（不是"立刻断言消失"—— 那样即使实现错了也可能过）
    await new Promise((r) => setTimeout(r, 800));
    expect((await barState()).types).not.toContain("disk-full");
    // main 侧 ring 也是空的（不是只关了界面）
    const ls = await fx.sh.run("./diy.sh env ls");
    expect(ls.stdout).not.toContain(PROBE_MOUNT);
  });

  it("空间恢复 → 红条**自动消**（不要用户手动关）", async () => {
    // 换一个挂载点重新注入（上一个已被静音，用它验不出"自动消"与"静音"的区别）
    const mount2 = "/probe-restore";
    await fx.sh.getJson(
      `./diy.sh env simulate --disk-avail ${100 * MiB} --disk-total ${500 * GiB} --disk-mount ${mount2}`,
    );
    await waitBar("disk-full", true);

    // 恢复：可用空间回到充裕
    await fx.sh.getJson(
      `./diy.sh env simulate --disk-avail ${200 * GiB} --disk-total ${500 * GiB} --disk-mount ${mount2}`,
    );
    const s = await waitBar("disk-full", false);
    expect(s.types).not.toContain("disk-full");
  });

  it("多条件共存 → 堆叠展示（磁盘 + 网络各一条）", async () => {
    await fx.sh.getJson(
      `./diy.sh env simulate --disk-avail ${100 * MiB} --disk-total ${500 * GiB} --disk-mount /probe-stack`,
    );
    await fx.sh.getJson(`./diy.sh env simulate --net-code ENOTFOUND --net-streak 3 --net-message "getaddrinfo ENOTFOUND"`);
    const s = await waitUntil(
      barState,
      (v) => v.types.includes("disk-full") && v.types.includes("network-down"),
      { label: "磁盘 + 网络两条同时出现", timeoutMs: 8000 },
    );
    expect(s.types).toContain("disk-full");
    expect(s.types).toContain("network-down");
    // 网络那条也要带数字证据（连败次数 + 错误码）+ 该干什么
    expect(s.text).toContain("网络不可达");
    expect(s.text).toContain("连续 3 次");
    expect(s.text).toContain("ENOTFOUND");
    expect(s.text).toContain("检查网络");
  });

  it("网络恢复 → 自动消（一次成功轮次即撤掉）", async () => {
    // 没有真发：用 simulate 传 0 次连败 = "未达阈值" → 判据给 null → 撤掉
    await fx.sh.getJson(`./diy.sh env simulate --net-code ETIMEDOUT --net-streak 0`);
    await waitUntil(barState, (v) => !v.types.includes("network-down"), {
      label: "network-down 自动消",
      timeoutMs: 8000,
    });
  });

  it("订阅即回放：页面重载后红条能自己回来", async () => {
    // 留一条未关闭的磁盘通知，然后重载渲染进程
    await fx.sh.getJson(
      `./diy.sh env simulate --disk-avail ${100 * MiB} --disk-total ${500 * GiB} --disk-mount /probe-replay`,
    );
    await waitBar("disk-full", true);

    await ui.eval("location.reload()");
    // 重载后 DOM 重建：先等 bar 重新出现（回放），再断言是**同一条**（mount 一致）
    const s = await waitUntil(
      barState,
      (v) => v.types.includes("disk-full") && v.text.includes("/probe-replay"),
      { label: "重载后回放磁盘红条", timeoutMs: 20_000 },
    );
    expect(s.text).toContain("/probe-replay");
  });

  it("`diy env ls` 人读表格带数字与 id（CLI 出口）", async () => {
    const r = await fx.sh.run("./diy.sh env ls");
    expect(r.stdout).toContain("/probe-replay");
    expect(r.stdout).toContain("disk-full");
    expect(r.stdout).toContain("可用");
    expect(r.stdout).toMatch(/id=env-disk-full-/);
  });
});
