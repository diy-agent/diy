// tests/cli.intent.ui-state.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 UI 状态快照契约：`diy.ui.state`（单读）与 `diy.ui.watch.uiState`（事件流）
//
// 为什么单独成文件：它们是「外部观察/等待 UI」的**正式能力**（任务 223 引入），
// 此前只在调查探针里验证过，tests/ 下 0 覆盖。这里固化两条契约：
//   1. 单读与流**同形状**（rev/uiRev/dataRev + tabs/selectedUri/tree）；
//   2. 版本号语义：本地 UI 写 → uiRev 前进；跨进程数据（CLI 落盘）到 renderer → dataRev 前进。
// 另含「写命令自检」的回归：写不生效要回 status=error（而不是无条件 ok）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { HttpClientBinding } from "@diy/rpc/http";
import { createTypedClient } from "@diy/rpc";
import { apiDef } from "../src/main/services/api-def";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };

interface Snap {
  rev: number;
  uiRev: number;
  dataRev: number;
  active: string;
  tabs: { key: string; pageId: string; ctx: string | null; indent: number }[];
  selectedUri: string | null;
  tree: { count: number; sig: string; loading: boolean };
}

/** 单读快照 */
async function snapshot(): Promise<Snap> {
  const r = await fx.sh.getJson("./diy.sh ui state");
  return (r.data as any).data as Snap;
}

beforeAll(async () => {
  const electron = await startElectronTest();
  const HOME = electron.home;
  fx = {
    electron,
    HOME,
    sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
  };
}, 60000);

afterAll(async () => {
  await fx?.electron?.stop();
});

describe("diy.ui.state — 单读快照", () => {
  it("返回完整形状（rev/uiRev/dataRev + tabs/selectedUri/tree）", async () => {
    const s = await snapshot();
    expect(typeof s.rev).toBe("number");
    expect(typeof s.uiRev).toBe("number");
    expect(typeof s.dataRev).toBe("number");
    expect(Array.isArray(s.tabs)).toBe(true);
    expect(s.selectedUri === null || typeof s.selectedUri === "string").toBe(true);
    expect(typeof s.tree.count).toBe("number");
    expect(typeof s.tree.sig).toBe("string");
  });

  it("写命令自检：tab open 回 status + rev/uiRev + 目标 active；uiRev 随之前进", async () => {
    const before = await snapshot();
    const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/state --label ST`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 状态任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);

    const res = await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    // CLI unary 回包：{ ok, data: <handler 结果> }；handler 结果是 { status, data: 载荷 }
    const handler = (res.data as any);
    expect(handler.status).toBe("ok");
    expect(handler.data.active).toBe(`task-run:${uri}`);
    expect(typeof handler.data.rev).toBe("number");
    expect(typeof handler.data.uiRev).toBe("number");

    const after = await snapshot();
    expect(after.uiRev).toBeGreaterThan(before.uiRev);
    expect(after.tabs.some((x) => x.ctx === uri)).toBe(true);
  });

  it("写失败可诊断：激活不存在的 tab → status=error 且带 reason（不再无条件 ok）", async () => {
    const res = await fx.sh.getJson(`./diy.sh ui tab active task-run:projects/999/tasks/9`);
    const handler = (res.data as any);
    expect(handler.status).toBe("error");
    expect(String(handler.data?.reason ?? "")).toBeTruthy();
  });
});

describe("diy.ui.watch.uiState — 事件流", () => {
  it("订阅即得当前态；本地 UI 写与跨进程数据链都各推一帧（uiRev / dataRev 前进）", async () => {
    // 用**进程内 RPC 客户端**直接连 app 的 HTTP/2 端口订阅流：
    // 不起子进程、无 CLI 冷启动、无 JSON 行解析 —— 只测 serverStream 传输本身，
    // 在机器繁忙/全量套件下也稳定（曾用 `./diy.sh ui watch uiState` 子进程，负载下首帧 >8s 而假红）。
    const binding = new HttpClientBinding(`http://127.0.0.1:${fx.electron.port}`);
    await binding.ready();
    const client = createTypedClient(binding, apiDef);

    const frames: Snap[] = [];
    const handle: any = await (client as any).diy.ui.watch.uiState({});
    const pump = (async () => {
      try {
        for await (const frame of handle) {
          const d = (frame as any)?.data;
          if (d && typeof d.rev === "number") frames.push(d as Snap);
        }
      } catch {
        /* 流结束/dispose：忽略 */
      }
    })();

    const latest = () => frames.at(-1);
    const waitLatest = async (ok: (s: Snap) => boolean, label: string, ms = 8000): Promise<Snap> => {
      const v = await waitUntil(async () => latest(), (x) => !!x && ok(x), { timeoutMs: ms, label });
      if (!v) throw new Error(`[ui-state] 等「${label}」超时（已收 ${frames.length} 帧）`);
      return v;
    };

    try {
      // ① 订阅即刻有当前快照（防丢唤醒）
      const first = await waitLatest(() => true, "首帧快照");
      expect(first.rev).toBeGreaterThan(0);

      // ② 本地 UI 写 → uiRev 前进
      const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/watch --label W`);
      const pid = String((p.data as any)?.data?.id);
      const t = await fx.sh.getJson(`./diy.sh task create 流任务 ${pid}`);
      const uri = String((t.data as any)?.data?.uri);
      const beforeUi = latest()!;

      await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
      const afterUi = await waitLatest((s) => s.tabs.some((x) => x.ctx === uri), "tab 出现在快照");
      expect(afterUi.uiRev).toBeGreaterThan(beforeUi.uiRev);

      // ③ 跨进程数据链：另起 shell 建任务 → 任务树刷新 → dataRev 前进（终点信号，不需建模中间链）
      const beforeData = latest()!;
      const sh2 = new ShellTest({
        cwd: join(__dirname, "..", "..", ".."),
        env: { HOME: fx.HOME, DIY_HOME: fx.HOME },
      });
      try {
        await sh2.run(`./diy.sh task create 链外任务 ${pid}`);
      } finally {
        sh2.close();
      }
      const afterData = await waitLatest(
        (s) => s.tree.count > beforeData.tree.count,
        "新任务进入任务树快照",
        10000,
      );
      expect(afterData.dataRev).toBeGreaterThan(beforeData.dataRev);
    } finally {
      try {
        await handle?.return?.();
      } catch {
        /* ignore */
      }
      binding.dispose();
      void pump;
    }
  }, 60000);
});

describe("就绪保证 — 外部刚建任务即可开 tab（跨进程链，不依赖 CLI 慢）", () => {
  it("CLI 建三层嵌套后立刻开 tab → 祖孙相邻（依赖任务树已含该 ctx）", async () => {
    const p = await fx.sh.getJson(`./diy.sh project create ${fx.HOME}/ready --label RD`);
    const pid = String((p.data as any)?.data?.id);
    const uriOf = (r: any) => String((r.data as any)?.data?.uri);
    const a = uriOf(await fx.sh.getJson(`./diy.sh task create 就绪-祖父 ${pid}`));
    const b = uriOf(await fx.sh.getJson(`./diy.sh task create 就绪-父 ${pid} --parent ${a}`));
    const c = uriOf(await fx.sh.getJson(`./diy.sh task create 就绪-孙 ${pid} --parent ${b}`));

    // 清掉其它用例遗留 tab，保证打开顺序确定
    for (const k of (await fx.sh.getJson("./diy.sh ui tab list") as any).data.data.opened as string[]) {
      await fx.sh.getJson(`./diy.sh ui tab close ${k}`);
    }
    // 先开孙、再开祖父 —— 若任务树未含层次，孙会被当顶级排在祖父之前
    await fx.sh.getJson(`./diy.sh ui tab open ${c}`);
    await fx.sh.getJson(`./diy.sh ui tab open ${a}`);

    const list = ((await fx.sh.getJson("./diy.sh ui tab list") as any).data.data.opened as string[]);
    const ia = list.indexOf(`task-run:${a}`);
    const ic = list.indexOf(`task-run:${c}`);
    expect(ia).toBeGreaterThanOrEqual(0);
    expect(ic).toBe(ia + 1); // 孙紧跟祖父之后
  });
});
