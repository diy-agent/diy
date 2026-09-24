// tests/cli.intent.ui-context.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 Context Tree 预览（任务 148）的**渲染**验证 + 原预览不受影响的回归。
//
// 为什么要有这条：CLI 的 RPC 返回成功 ≠ renderer 渲染正确（AGENTS.md 的教训）。
// 这里走「打开任务 → 打开提示词页 → 切右栏 tab」真实 UI 路径，读 a11y 树确认：
//   1. 新增的「系统上下文」view 真的上屏（树/places/step 投递/system/runtime 四块）
//   2. 切换 tab 能回到原来的 `_system.md` / `请求预览`（原能力一行未改）
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };

beforeAll(async () => {
  const electron = await startElectronTest();
  const HOME = electron.home;
  fx = {
    electron,
    HOME,
    sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
  };
});

afterAll(async () => {
  await fx?.electron?.stop();
});

/** a11y 树文本（ui inspect 才是 DOM 树；ui tree 是任务树，别混） */
function collectText(nodes: any[], acc: string[] = []): string[] {
  for (const n of nodes ?? []) {
    if (n?.text) acc.push(String(n.text));
    if (n?.children) collectText(n.children, acc);
  }
  return acc;
}

async function a11yText(): Promise<string> {
  const res = await fx.sh.getJson("./diy.sh ui inspect");
  return collectText([(res.data as any)?.data?.tree]).join("\n");
}

/** 展开/折叠右栏某个块（`ui view expand`，与左栏四个块同一个机制） */
async function fold(key: string, open: boolean): Promise<void> {
  const res = await fx.sh.getJson(`./diy.sh ui view expand ${key} ${open ? "open" : "closed"}`);
  expect((res.data as any)?.status, `折叠 ${key} 失败: ${JSON.stringify(res.data)}`).toBe("ok");
}

describe("Context Tree 预览：RPC 契约", () => {
  it("diy context scenarios / preview 可用，且返回树 + 每步投递", async () => {
    // 注：CLI stdout = RPC 的 output 本体（`ui inspect` 的 output 自带 {status,data} 外壳，
    // 而 context 域直接返回数据本身），故这里不再多剥一层
    const list = await fx.sh.getJson("./diy.sh context scenarios");
    const names = ((list.data as unknown as any[]) ?? []).map((s: any) => s.name);
    expect(names).toEqual(["basic", "template", "boundary"]);

    const p = await fx.sh.getJson("./diy.sh context preview basic");
    const d = p.data as any;
    expect(d.scenario).toBe("basic");
    expect(d.wireVersion).toMatch(/^[0-9a-f]{8}$/);
    // places 与容器归属（basic 最后一步删掉了 tasks，故这是**终态**）
    expect(d.places.map((x: any) => x.path)).toEqual(["diy", "instructions", "task"]);
    expect(d.places.filter((x: any) => x.container === "system").map((x: any) => x.path)).toEqual([
      "diy",
      "instructions",
      "task",
    ]);
    // 树节点带 valueHash
    expect(d.nodes.some((n: any) => n.path === "diy.cli")).toBe(true);
    // 逐步投递覆盖四种动作（runtime patch 的粒度是 **place**，不是叶子）
    const deliveries = d.steps.map((s: any) => s.delivery).join(" | ");
    expect(deliveries).toContain("snapshot（supersedes=all）");
    expect(deliveries).toContain("set tasks");
    expect(deliveries).toContain("不发（内容未变）");
    expect(deliveries).toContain("clear（显式清空）");
    // step-hash：删掉 tasks 后，父与子都记 1 次（不累加）
    const clearStep = d.steps.at(-1);
    expect(clearStep.changed).toContain("tasks");
    expect(clearStep.changed).toContain("tasks.140.status");
    // system 是模板渲染结果
    expect(d.system).toContain("<p>项目：diy（/repo/diy.sh）</p>");
  }, 60_000);
});

describe("Context Tree 预览：UI 上屏（右栏可折叠堆叠）", () => {
  it("右栏三个块与左栏同构：默认只展开 _system.md，展开「系统上下文」四块内容上屏", async () => {
    // 1. 造项目 + 任务（提示词页以选中任务为场景）
    const repo = `${fx.HOME}/ctxlab`;
    const p = await fx.sh.getJson(`./diy.sh project create ${repo} --label 上下文试验场`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 上下文试验场任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);

    // 2. 打开任务执行页 → 打开其子页面（提示词页）
    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await fx.sh.getJson(`./diy.sh ui tab open lab:${uri}`);

    // 3. 右栏三个块（折叠 header）先确认在，且**同构**：默认只展开 _system.md
    const before = await waitUntil(
      a11yText,
      (s) => s.includes("_system.md") && s.includes("请求预览") && s.includes("系统上下文"),
      { label: "右栏三个折叠块上屏" },
    );
    expect(before).not.toContain("PLACES（割点集合）"); // 系统上下文块默认是折叠的

    // 4. 展开「系统上下文」块
    await fold("ctxpreview", true);
    const ctx = await waitUntil(a11yText, (s) => s.includes("PLACES（割点集合）"), {
      label: "系统上下文 view 上屏",
    });
    expect(ctx).toContain("TREE（");
    expect(ctx).toContain("STEP 投递");
    expect(ctx).toContain("SYSTEM（全量重建）");
    expect(ctx).toContain("RUNTIME（增量投递内容）");
    // 默认场景 basic 的实内容
    expect(ctx).toContain("diy.cli");
    expect(ctx).toContain("tasks.140.status");
    expect(ctx).toContain("clear");
    expect(ctx).toContain("rebaseline");

    // 5. 展开「请求预览」块：原能力仍在（未受新增块影响），且与系统上下文**同时可见**
    //    （这正是折叠堆叠相对互斥 tab 的收益：不缺互斥，能并排对照）
    await fold("reqbody", true);
    const both = await waitUntil(a11yText, (s) => s.includes("PLACES（割点集合）") && s.includes("请求预览"), {
      label: "两块同时可见",
    });
    expect(both).toContain("dry-run");

    // 6. 折回：折叠块能收起，内容随之消失
    await fold("ctxpreview", false);
    const folded = await waitUntil(a11yText, (s) => !s.includes("PLACES（割点集合）"), {
      label: "系统上下文块折叠",
    });
    expect(folded).toContain("系统上下文"); // header 还在（可再展开）

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 180_000);
});
