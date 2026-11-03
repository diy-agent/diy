// tests/cli.intent.cache-expiry.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 冷缓存提示（##477）的**用户可见行为** —— 真实 renderer + 真实 RPC。
//
// 用户的需求点（2026-10-30 定稿）：
//   「距离上次请求太久，缓存就冷了，这一轮整段上下文按全价重付」——这件事实原本完全沉默。
//   要的是**自适应的边界**，不是一张人维护的概率表：成功多了安全期自然放宽，失败一次就收紧一格。
//   提示必须**只有一行**（不弹窗、不叠加），因为它只是「提醒你看一眼」，不是要打断你干活。
//
// 六条契约（都是用户语言，别改成实现术语）：
//   ① 无历史（内存型 app 刚起来）⇒ 安全期用 60 秒保护值、失效点未知、**不提示**
//   ② 100 次 5 分钟的「真命中」⇒ 安全期≈5 分钟（P90）
//   ③ 一次 10 分钟的首步失败 ⇒ 失效点降到 10 分钟，并**当场亮一次**（用户刚按全价付完）
//   ④ 安全期(11min) 比失效点(10min) 更长时**不提示** —— 成功案例更多，那次失败更可能是异常
//   ⑤ 失效落在安全期保护区内（4min 失败 / 安全期 5min）⇒ **忽略、不收紧**（否则提示过多）
//   ⑥ 连续多次越界，顶栏那条 bar 的 DOM 节点数**恒为 1**（新提示替换旧的，不是叠加）
//
// 为什么用探针 `cacheHint simulate` 而不是真跑模型几百轮：这六条要的是「间隔 + 首步命中率」
// 两件事实，真跑不可复现、要钱、且慢；探针走的是与真发**同一条** noteRequest /
// noteFirstStepResult，只换事实来源（与 `env simulate` 同一取舍）。判据本身的穷举在
// tests/core/cache-hint.test.ts。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type UiDriver } from "./ui-drive";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;

const MIN = 60_000;

/** simulate 的返回（`diy cacheHint simulate` 的 data 层） */
interface SimResult {
  channel: string;
  safePointMs: number;
  failPointMs: number | null;
  lastRequestAt: number | null;
  samples: number;
  hintsToday: number;
  hint: { gapMs: number; thresholdMs: number; thresholdKind: "safe" | "fail"; todayCount: number } | null;
}

/** 走 CLI 探针造一次首步事实 */
async function simulate(args: string): Promise<SimResult> {
  const r = await fx.sh.getJson(`./diy.sh cacheHint simulate ${args}`);
  expect((r as any).ok).toBe(true);
  return (r as any).data as SimResult;
}

/** 关掉当前那条（每个契约从干净的一行起，避免上一条盖住这一条） */
async function dismiss(): Promise<void> {
  await fx.sh.getJson(`./diy.sh cacheHint dismiss`);
}

/** 顶栏那条 bar：节点数 + 文本（a11y 树对长文本有截断，直读 DOM） */
const barState = (): Promise<{ count: number; text: string }> =>
  ui.query<{ count: number; text: string }>(`(() => {
    const bars = [...document.querySelectorAll('[data-cache-hint-bar]')];
    return { count: bars.length, text: bars.map((b) => b.textContent || '').join(' | ') };
  })()`);

async function waitBar(present: boolean, label: string): Promise<{ count: number; text: string }> {
  return waitUntil(barState, (s) => (s.count === 1) === present, { label, timeoutMs: 8000 });
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
}, 120000);

afterAll(async () => {
  await ui?.close();
  await fx?.electron?.stop();
});

describe("① 无历史：60 秒保护值 + 失效点未知 + 不提示", () => {
  it("刚起来的实例没有任何历史，用 60 秒保护值，且不吓人（不提示）", async () => {
    await dismiss();
    const d = await simulate("--provider probe-no-history --model fresh --gap-ms 1800000 --hit none");
    expect(d.safePointMs).toBe(60_000);
    expect(d.failPointMs).toBeNull();
    expect(d.hint).toBeNull();
    // 界面上什么都不该多出来
    expect((await barState()).count).toBe(0);
  });
});

describe("② 100 次 5 分钟真命中 → 安全期≈5 分钟（成功的 P90）", () => {
  it("成功多了，安全期自己放宽到 5 分钟；没有失败证据仍然不提示", async () => {
    const d = await simulate("--provider probe --model five-min --gap-ms 300000 --hit success --repeat 100");
    expect(d.samples).toBe(100);
    expect(Math.abs(d.safePointMs - 5 * MIN)).toBeLessThanOrEqual(1000);
    expect(d.failPointMs).toBeNull();
    expect(d.hint).toBeNull();
    expect((await barState()).count).toBe(0);
  });
});

describe("③ 一次 10 分钟首步失败 → 失效点降到 10 分钟，并当场亮一次", () => {
  it("刚花完全价的那一刻就把事实摆出来（这是最该看到它的时刻）", async () => {
    const d = await simulate("--provider probe --model five-min --gap-ms 600000 --hit miss");
    expect(d.failPointMs).toBe(10 * MIN);
    expect(d.hint).not.toBeNull();
    expect(d.hint!.thresholdMs).toBe(10 * MIN);
    expect(d.hint!.thresholdKind).toBe("fail");

    const s = await waitBar(true, "冷缓存提示出现");
    expect(s.text).toContain("缓存可能已冷");
    expect(s.text).toContain("距上次 10min");
    expect(s.text).toContain("超过记录的 10min 失效点");
    // 该干什么（一级信息必须带下一步，不然用户只知道"糟了"）
    expect(s.text).toContain("换个模型或先压缩");
    await dismiss();
  });
});

describe("④ 安全期(11min) 比失效点(10min) 更长时不提示（安全点优先）", () => {
  it("10.5 分钟落在安全期内 ⇒ 静默；过了 11 分钟才提示", async () => {
    // 先造失效点 10min（此刻安全期还是 60s 保护值）
    await simulate("--provider probe-guard --model guard --gap-ms 600000 --hit miss");
    // 再用 100 次 11min 的成功把安全期撑过失效点
    const seeded = await simulate("--provider probe-guard --model guard --gap-ms 660000 --hit success --repeat 100");
    expect(seeded.safePointMs).toBe(11 * MIN);
    expect(seeded.failPointMs).toBe(10 * MIN);
    await dismiss();

    // 10.5min：越过了失效点、但没越过安全期 → 不提示（这是最容易被写错的一条）
    const quiet = await simulate("--provider probe-guard --model guard --gap-ms 630000 --hit none");
    expect(quiet.hint).toBeNull();
    expect((await barState()).count).toBe(0);

    // 12min：安全期也越过了 → 提示，且说的是"安全期"
    const loud = await simulate("--provider probe-guard --model guard --gap-ms 720000 --hit none");
    expect(loud.hint).not.toBeNull();
    expect(loud.hint!.thresholdKind).toBe("safe");
    expect(loud.hint!.thresholdMs).toBe(11 * MIN);
    await dismiss();
  });
});

describe("⑤ 失效落在安全期保护区内 ⇒ 忽略、不收紧（否则提示过多）", () => {
  it("5 分钟安全期里 4 分钟就失败一次，不算数：失效点仍然未知、也不提示", async () => {
    await simulate("--provider probe-zone --model safe-zone --gap-ms 300000 --hit success --repeat 100");
    const d = await simulate("--provider probe-zone --model safe-zone --gap-ms 240000 --hit miss");
    expect(d.safePointMs).toBe(5 * MIN);
    expect(d.failPointMs).toBeNull();
    expect(d.hint).toBeNull();
    expect((await barState()).count).toBe(0);
  });
});

describe("⑥ 只出一条横条：连续越界，DOM 里该 bar 节点数恒为 1", () => {
  it("新提示替换旧的，不叠加、不弹窗", async () => {
    // 造出失效点 10min（第一次就会亮）
    await simulate("--provider probe-bar --model bar --gap-ms 600000 --hit miss");
    await waitBar(true, "先有第一条");

    for (const gap of [11, 15, 20, 30]) {
      await simulate(`--provider probe-bar --model bar --gap-ms ${gap * MIN} --hit none`);
      const s = await waitUntil(
        barState,
        (v) => v.count === 1 && v.text.includes(`距上次 ${gap}min`),
        { label: `第 ${gap}min 那条替换上一行`, timeoutMs: 8000 },
      );
      // 恒为 1：不是"又开了一条"，而是同一行更新
      expect(s.count).toBe(1);
    }
    // 近期次数也在累计（跨 turn 不归零），但仍然是那一行
    const s = await barState();
    expect(s.text).toMatch(/今日第 \d+ 次/);
    expect(s.count).toBe(1);
    await dismiss();
  });
});
