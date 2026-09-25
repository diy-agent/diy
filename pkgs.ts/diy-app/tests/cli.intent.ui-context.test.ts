// tests/cli.intent.ui-context.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 上下文树页（任务 148）的 RPC 契约 + **渲染**验证。
//
// 关键前提：数据是**当前任务的真实上下文**（与真发同一条 assembleGlobals 链），
// 不是示范数据。所以这里先造真实的 AGENTS.md 链与任务，再断言它出现在投递里。
//
// 页面是**独立子页面**（与提示词页 lab 平级），故还要验证互不干扰。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
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

/** 展开/折叠该页的块（key 带 ctx. 前缀，与提示词页的块分开命名空间） */
async function fold(key: string, open: boolean): Promise<void> {
  const res = await fx.sh.getJson(`./diy.sh ui view expand ctx.${key} ${open ? "open" : "closed"}`);
  expect((res.data as any)?.status, `折叠 ${key} 失败: ${JSON.stringify(res.data)}`).toBe("ok");
}

describe("上下文树：RPC 契约（真实数据）", () => {
  it("candidates 给出候选单元与推荐名单；lab 返回真实 globals 与两份投递", async () => {
    const cand = await fx.sh.getJson("./diy.sh context candidates");
    const c = cand.data as unknown as any;
    const paths = c.candidates.map((x: any) => x.path);
    expect(paths).toContain("diy");
    expect(paths).toContain("task.body");
    // task 的稳定字段与易变字段被拆成不同单元（否则"按第一层划分"的毛病就回来了）
    expect(paths).toContain("task.title");
    expect(c.defaultSystem).toContain("task.title");
    expect(c.defaultSystem).not.toContain("task.body");

    // 造一个真实的项目目录 + AGENTS.md 链，让 chain 有内容
    const repo = `${fx.HOME}/ctxlab`;
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(fx.HOME, "AGENTS.md"), "# 家目录规范\n- 中文回复\n");
    writeFileSync(join(repo, "AGENTS.md"), "# 项目规范\n- 先读代码\n");
    const p = await fx.sh.getJson(`./diy.sh project create ${repo} --label 上下文树`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 上下文树任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);
    await fx.sh.run(`./diy.sh task edit ${uri} --body $'任务正文第一行\\n正文第二行'`);

    const res = await fx.sh.getJson(`./diy.sh context lab ${pid} --taskUri ${uri}`);
    const d = res.data as any;
    expect(d.taskUri).toBe(uri);
    expect(d.source).toContain("真实上下文");

    // 真实 AGENTS.md 链进了 system 份，内容以 YAML 块标量落盘
    expect(d.system.text).toContain("chain:");
    expect(d.system.text).toContain("家目录规范");
    expect(d.system.text).toContain("项目规范");
    expect(d.system.text).toContain("content: |"); // 多行文本用块标量
    // 纯 YAML：不再有自创的 XML 外壳
    expect(d.system.text).not.toContain("<context path=");

    // 任务正文（易变）归 runtime；任务身份（稳定）归 system
    expect(d.runtime.text).toContain("body:");
    expect(d.system.text).toContain('title: "上下文树任务"');

    // 请求体：与真发同一条构造链，messages 用「system 份 + runtime 份」
    expect(d.request.body).toBeTruthy();
    const msgs = d.request.body.messages as any[];
    expect(msgs[0].role).toBe("system");
    expect(String(msgs[0].content)).toContain("家目录规范");
    const lastUser = msgs[msgs.length - 1];
    expect(lastUser.role).toBe("user");
    expect(String(lastUser.content)).toContain("body:"); // runtime 份进了末条 user
    expect(d.request.model).toBeTruthy();

    // 行号映射与文本同源（选中联动高亮靠它）
    expect(d.system.lines["chain"]).toBeTruthy();
    expect(d.runtime.lines["task.body"]).toBeTruthy();

    // 变量树：父层级不显示值（值在下面几行里），容器标 hasValue
    const root = d.tree.find((n: any) => n.path === "task");
    expect(root.preview).toBe("");

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 90_000);

  it("改 system 名单 → 归属随之变化（task.body 从 runtime 移到 system）", async () => {
    const repo = `${fx.HOME}/ctxlab2`;
    mkdirSync(repo, { recursive: true });
    const p = await fx.sh.getJson(`./diy.sh project create ${repo} --label 划分`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 划分任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);

    const base = (await fx.sh.getJson(`./diy.sh context lab ${pid} --taskUri ${uri}`)).data as any;
    expect(base.runtime.places).toContain("task.body");
    expect(base.system.places).not.toContain("task.body");

    // 把 task.body 划进 system（其余用推荐名单）
    const sys = JSON.stringify([...base.system.places, "task.body"]);
    const moved = (
      await fx.sh.getJson(`./diy.sh context lab ${pid} --taskUri ${uri} --systemPlaces '${sys}'`)
    ).data as any;
    expect(moved.system.places).toContain("task.body");
    expect(moved.runtime.places).not.toContain("task.body");
    expect(moved.system.text).toContain("body:");
    // 变量树上的归属标记跟着变
    const row = moved.tree.find((n: any) => n.path === "task.body");
    expect(row.container).toBe("system");

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 90_000);
});

describe("上下文树：UI 上屏（三列 + 真实请求体）", () => {
  it("三列各自上屏；结构树标注归属；请求体是真实 JSON；与提示词页互不干扰", async () => {
    const repo = `${fx.HOME}/ctxlab3`;
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "## 本项目的规范\n- 精简\n");
    const p = await fx.sh.getJson(`./diy.sh project create ${repo} --label 上屏`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 上屏任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);

    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await fx.sh.getJson(`./diy.sh ui tab open ctxlab:${uri}`);

    // 三列：结构树（左）/ 两份投递（中）/ 投递单元 + 变量树（右）
    const base = await waitUntil(
      a11yText,
      (s) => s.includes("变量（契约）") && s.includes("system 份") && s.includes("投递单元"),
      { label: "上下文树页三列上屏" },
    );
    expect(base).toContain("runtime 份");
    expect(base).toContain("变量树");
    expect(base).toContain("真实上下文");

    // 真实 AGENTS.md 内容上屏（等 RPC；首帧 system 名单还没加载完）
    const withChain = await waitUntil(a11yText, (s) => s.includes("本项目的规范"), {
      label: "真实 AGENTS.md 链上屏",
    });
    // 结构树是契约（含类型/描述与无值的变量）
    expect(withChain).toContain("AGENTS.md 链");
    expect(withChain).toContain("技能清单");
    // 与提示词页互不干扰：另一个 page 的块不该出现
    expect(withChain).not.toContain("_system.md");

    // 展开请求体 → 真实 JSON（与真发同一条构造链）
    await fold("request", true);
    const req = await waitUntil(a11yText, (s) => s.includes("tool_choice") || s.includes("max_tokens"), {
      label: "请求体上屏",
    });
    expect(req).toContain("model");
    expect(req).toContain("messages");

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 180_000);
});
