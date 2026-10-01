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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode } from "./ui-drive";

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

    // 请求体：与真发同一条构造链。形态 = [system 段, ...历史, user(runtime), user(占位输入)]
    // （真发同理：runtime 作为独立 user 消息插在**本轮输入之前**，见 runTurn 的 withRuntime）
    //
    // ⚠️ 形状随缺省模型的 **API 面** 变（缺省模型是 responses 面的 gpt-5.6-luna）：
    //   chat 面      → messages[]，首项 role=system
    //   responses 面 → input[]，首项 role=developer（system 装在首项）
    // 断言两面都覆盖，别把测试绑死在 chat 面（main 的 template.test.ts 踩过同一个坑）。
    expect(d.request.body).toBeTruthy();
    const items = (d.request.body.input ?? d.request.body.messages) as any[];
    expect(items).toBeTruthy();
    expect(["system", "developer"]).toContain(items[0].role);
    expect(String(items[0].content)).toContain("家目录规范");
    // 末两条 user：倒数第二条 = runtime 份，末条 = "下一轮真实输入"的占位
    const lastUser = items[items.length - 1];
    const runtimeUser = items[items.length - 2];
    expect(lastUser.role).toBe("user");
    expect(runtimeUser.role).toBe("user");
    // responses 面里 user 的 content 是 [{type:"input_text",text}]，取文本要比出两种形状
    const textOf = (m: any): string =>
      typeof m.content === "string" ? m.content : (m.content ?? []).map((p: any) => p.text ?? "").join("");
    expect(textOf(runtimeUser)).toContain("body:");
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

/** 与 main 的 keyOf 同算法（会话文件名的唯一性由 sha256 前 12 位负责） */
function keyOf(taskUri: string): string {
  const readable = taskUri.replace(/[^\w.-]+/g, "_").slice(0, 64);
  const sum = createHash("sha256").update(taskUri).digest("hex").slice(0, 12);
  return `${readable}-${sum}`;
}

describe("上下文树：划分规则（真源）", () => {
  it("默认读推荐名单；setConfig 落盘成 context.yaml；lab 不传名单时读的也是它", async () => {
    const repo = `${fx.HOME}/ctxlab-config`;
    mkdirSync(repo, { recursive: true });
    const p = await fx.sh.getJson(`./diy.sh project create ${repo} --label 划分真源`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 划分任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);
    // 正文有 10 字下限（`task edit` 会拒绝过短输入）
    await fx.sh.run(`./diy.sh task edit ${uri} --body $'划分验证正文\\n第二行也在这里'`);

    // ① 没有 context.yaml → 推荐名单（fromFile=false），且 task.body 不在 system
    const base = (await fx.sh.getJson(`./diy.sh context config`)).data as any;
    expect(base.fromFile).toBe(false);
    expect(base.systemPlaces).toEqual(base.defaults);
    expect(base.systemPlaces).not.toContain("task.body");

    // ② lab **不传** systemPlaces → 读真源（与真发同一份）；task.body 在 runtime
    const labBase = (await fx.sh.getJson(`./diy.sh context lab ${pid} --taskUri ${uri}`)).data as any;
    expect(labBase.runtime.places).toContain("task.body");
    expect(labBase.system.places).not.toContain("task.body");

    // ③ 把它划进 system（页面 ⇄ 走的就是这条 RPC）
    const next = [...base.systemPlaces, "task.body"];
    const set = await fx.sh.getJson(
      `./diy.sh context setConfig --systemPlaces '${JSON.stringify(next)}'`,
    );
    expect((set.data as any).systemPlaces).toContain("task.body");
    // 落盘了（真源在文件里，不是页面内存）
    const raw = readFileSync(join(fx.HOME, "context.yaml"), "utf-8");
    expect(raw).toContain("task.body");
    expect((await fx.sh.getJson(`./diy.sh context config`)).data as any).toMatchObject({ fromFile: true });

    // ④ ★ 关键：lab 不传名单时**读真源** → 划分跟着变（真发走的是同一个 loadSystemPlaces）
    const labMoved = (await fx.sh.getJson(`./diy.sh context lab ${pid} --taskUri ${uri}`)).data as any;
    expect(labMoved.system.places).toContain("task.body");
    expect(labMoved.runtime.places).not.toContain("task.body");
    expect(labMoved.system.text).toContain("划分验证正文");

    // ⑤ 非法输入被拒（写侧不允许存下坏数据）
    const bad = await fx.sh.run(
      `./diy.sh context setConfig --systemPlaces '["task","task.body"]'`,
    );
    expect(bad.code).not.toBe(0);
    expect(bad.stderr + bad.stdout).toContain("非法投递单元");

    await fx.sh.run(`./diy.sh project remove ${pid}`);
    // ★ 清场：context.yaml 是**全局真源**（不属于某个项目/任务），留在共享 HOME 里会改掉
    //   后续用例的默认划分 —— 实测让 steps 与 UI 两个用例失败（它们假定推荐名单）。
    rmSync(join(fx.HOME, "context.yaml"), { force: true });
  }, 120_000);
});

describe("上下文树：投递快照（steps）", () => {
  it("空会话 0 条；写入快照后能读出，且相邻 diff 算在 main 侧（默认只给统计）", async () => {
    const repo = `${fx.HOME}/ctxlab-steps`;
    mkdirSync(repo, { recursive: true });
    const p = await fx.sh.getJson(`./diy.sh project create ${repo} --label 快照`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 快照任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);

    const empty = await fx.sh.getJson(`./diy.sh context steps ${uri}`);
    expect((empty.data as any).total).toBe(0);
    expect((empty.data as any).steps).toEqual([]);

    // 手写两条快照（模拟两轮真发；真发本身需要 LLM key，故这里只验读取 + 汇总链路）
    const rec = (over: Record<string, unknown>) => ({
      ts: "2026-09-25T00:00:00.000Z",
      turnId: "t1",
      model: "mimo-v2.5",
      wireVersion: "aaaa1111",
      systemPlaces: ["diy"],
      runtimePlaces: ["task.body"],
      valueHashes: { diy: "h1", "task.body": "b1" },
      systemText: "diy:\n  cli: /repo",
      runtimeText: 'task:\n  body: "一"',
      ...over,
    });
    const localDir = join(fx.HOME, "local");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(
      join(localDir, `${keyOf(uri)}.steps.jsonl`),
      [
        rec({}),
        rec({ turnId: "t2", valueHashes: { diy: "h1", "task.body": "b2" }, runtimeText: 'task:\n  body: "二"' }),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );

    const r = await fx.sh.getJson(`./diy.sh context steps ${uri} --diff`);
    const d = r.data as any;
    expect(d.total).toBe(2);
    expect(d.steps.map((s: any) => s.index)).toEqual([1, 2]);
    // 首步是 baseline：没有"上一步"
    expect(d.steps[0].sincePrev).toBeNull();
    // 第 2 步：只有 runtime 变（system 一份未变 → 可缓存）
    expect(d.steps[1].sincePrev.changed).toEqual(["task.body"]);
    expect(d.steps[1].sincePrev.systemDiffers).toBe(false);
    expect(d.steps[1].sincePrev.runtimeDiffers).toBe(true);
    expect(d.steps[1].sincePrev.incomparable).toBe(false);
    // --diff 才带行内容；且原文（中文）能正确回传
    expect(d.steps[1].diff.runtime.some((l: any) => l.t === "+" && l.s.includes("二"))).toBe(true);

    // 默认不带行内容（避免下发整份文本；也不会塞进 sincePrev）
    const plain = await fx.sh.getJson(`./diy.sh context steps ${uri}`);
    expect((plain.data as any).steps[1].diff).toBeUndefined();
    expect((plain.data as any).steps[1].sincePrev.runtimeSize.add).toBeGreaterThan(0);
    expect(Object.keys((plain.data as any).steps[1].sincePrev)).not.toContain("runtimeDiff");

    // ── diff：两种模式（都在 main 侧算完） ──
    // ① 选中某步 → 与上一步比
    const stepDiff = await fx.sh.getJson(`./diy.sh context diff ${pid} ${uri} --step 2`);
    const sd = stepDiff.data as any;
    expect(sd.mode).toBe("step");
    expect(sd.base.index).toBe(1);
    expect(sd.target.index).toBe(2);
    expect(sd.changed).toEqual(["task.body"]);
    expect(sd.systemDiffers).toBe(false); // 稳定项没变 → 可缓存
    expect(sd.runtimeDiffers).toBe(true);
    expect(sd.runtimeDiff.some((l: any) => l.t === "+" && l.s.includes("二"))).toBe(true);

    // ② 不给 --step → **当前变量树** vs 最后一步（"我现在改的会不会变"）
    // （正文有 10 字下限：`task edit` 会拒绝过短输入，这里给足）
    await fx.sh.run(`./diy.sh task edit ${uri} --body $'又改了一版正文\\n第三行也在这里'`);
    const liveDiff = await fx.sh.getJson(`./diy.sh context diff ${pid} ${uri}`);
    const ld = liveDiff.data as any;
    expect(ld.mode).toBe("live");
    expect(ld.base.index).toBe(2);
    expect(ld.target).toBeNull();
    expect(ld.changed).toContain("task.body");
    expect(ld.runtimeDiff.some((l: any) => l.t === "+" && l.s.includes("第三行也在这里"))).toBe(true);

    // 没有真发记录时 → null（界面显示"还没有真发记录"）
    const other = await fx.sh.getJson(`./diy.sh task create 空任务 ${pid}`);
    const none = await fx.sh.getJson(
      `./diy.sh context diff ${pid} ${String((other.data as any).data.uri)}`,
    );
    expect(none.data).toBeNull();

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 90_000);
});

describe("上下文树：变更统计（按项目累计）", () => {
  it("空项目 0 轮；手写统计后能聚合出变了几次/共多少轮；可按任务过滤", async () => {
    const repo = `${fx.HOME}/ctxlab-stats`;
    mkdirSync(repo, { recursive: true });
    const p = await fx.sh.getJson(`./diy.sh project create ${repo} --label 统计`);
    const pid = String((p.data as any)?.data?.id);
    const t1 = await fx.sh.getJson(`./diy.sh task create 统计任务一 ${pid}`);
    const uri1 = String((t1.data as any)?.data?.uri);
    const t2 = await fx.sh.getJson(`./diy.sh task create 统计任务二 ${pid}`);
    const uri2 = String((t2.data as any)?.data?.uri);

    const empty = await fx.sh.getJson(`./diy.sh context stats ${pid}`);
    expect((empty.data as any).turns).toBe(0);
    expect((empty.data as any).paths).toEqual([]);

    // 手写统计（真发需要 LLM key）：任务一 3 轮（chain.0 变 2 次），任务二 1 轮
    const stat = (ts: string, taskUri: string, changed: string[]) =>
      JSON.stringify({ ts, taskUri, turnId: `t-${ts}`, changed });
    const fp = join(fx.HOME, "projects", pid, "context-stats.jsonl");
    mkdirSync(join(fx.HOME, "projects", pid), { recursive: true });
    writeFileSync(
      fp,
      [
        stat("2026-09-26T01:00:00.000Z", uri1, ["chain.0", "diy"]),
        stat("2026-09-26T02:00:00.000Z", uri1, ["chain.0"]),
        stat("2026-09-26T03:00:00.000Z", uri1, []),
        stat("2026-09-26T04:00:00.000Z", uri2, ["task.body"]),
      ].join("\n") + "\n",
    );

    // 整个项目累计：4 轮
    const all = (await fx.sh.getJson(`./diy.sh context stats ${pid}`)).data as any;
    expect(all.turns).toBe(4);
    expect(all.since).toBe("2026-09-26T01:00:00.000Z");
    expect(all.until).toBe("2026-09-26T04:00:00.000Z");
    const chain = all.paths.find((x: any) => x.path === "chain.0");
    expect(chain.changes).toBe(2);
    expect(chain.rate).toBeCloseTo(0.5); // 分母是总轮数（含没变的那轮）
    expect(chain.turns).toEqual([1, 2]);

    // 按任务过滤：只有任务一的 3 轮
    const only1 = (await fx.sh.getJson(`./diy.sh context stats ${pid} --taskUri ${uri1}`)).data as any;
    expect(only1.turns).toBe(3);
    expect(only1.paths.find((x: any) => x.path === "task.body")).toBeUndefined();

    // limit 取最近 N 轮
    const last2 = (await fx.sh.getJson(`./diy.sh context stats ${pid} --limit 2`)).data as any;
    expect(last2.records).toBe(4); // 总数仍报 4（未被 limit 掩盖）
    expect(last2.turns).toBe(2);

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 90_000);
});

describe("上下文树：UI 上屏（两列 + 请求预览）", () => {
  it("结构树与请求预览上屏；单份视图已删；与提示词页互不干扰", async () => {
    const repo = `${fx.HOME}/ctxlab3`;
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "## 本项目的规范\n- 精简\n");
    const p = await fx.sh.getJson(`./diy.sh project create ${repo} --label 上屏`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 上屏任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);

    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await fx.sh.getJson(`./diy.sh ui tab open ctxlab:${uri}`);

    // 两列：结构树（左）/ 请求预览（中）。单份视图（变量树 / system 份 / runtime 份 / 变更详情）
    // 已删 —— 同一份文本的展开形态就在请求预览的树里，不必看两遍。
    const base = await waitUntil(
      a11yText,
      (s) => s.includes("变量（契约）") && s.includes("请求预览"),
      { label: "上下文树页两列上屏" },
    );
    expect(base).toContain("真实上下文");
    // 判据用**被删视图自己的标题/栏位**（不用裸词"变量树"：说明头正文里就有「一棵变量树」）
    for (const g of ["system 份（稳定", "runtime 份（易变", " 个变量\n"]) {
      expect(base, `已删的视图不该再上屏：${g}`).not.toContain(g);
    }
    // 「变更详情」回来了（数据换成真发快照）：标题常驻，默认收起
    expect(base).toContain("变更详情");

    // 真实 AGENTS.md 内容上屏（等 RPC；首帧 system 名单还没加载完）
    const withChain = await waitUntil(a11yText, (s) => s.includes("本项目的规范"), {
      label: "真实 AGENTS.md 链上屏",
    });
    // 结构树是契约（含类型/描述与无值的变量）
    expect(withChain).toContain("AGENTS.md 链");
    expect(withChain).toContain("技能清单");
    // 与提示词页互不干扰：另一个 page 的块不该出现
    expect(withChain).not.toContain("_system.md");

    // 链内容进了请求预览（真实数据：AGENTS.md 链 → system 段）
    const withArray = await waitUntil(a11yText, (s) => s.includes("chain"), { label: "chain 上屏" });
    expect(withArray).toContain("chain");

    // 变更列表：左栏折叠块的标题常驻（默认收起；数据来自**真发快照**）
    expect(withChain).toContain("变更（真发轮次）");
    // 「投递单元」view 已删（划分结果已在请求预览里体现）
    expect(withChain).not.toContain("投递单元");

    // 请求预览（默认 YAML 形态）：内嵌的 system 文本**就地解析展开** ——
    // 「`# 以下是…` 这类 token 只可能由（说明头 → 注释）产生」：整坨字符串/块标量下
    // 这些行不带 `# ` 前缀，整段会是一个多行 token。这就是"展开"与"没展开"的判据。
    await fold("request", true);
    const yamlView = await waitUntil(
      a11yText,
      (s) => s.includes("# 以下是本次会话的系统上下文，以 YAML 序列化的一棵变量树呈现。"),
      { label: "请求预览 YAML 上屏（内嵌 system 已解析展开）" },
    );
    expect(yamlView).toContain("# 系统上下文（Context Tree）");
    // 说明头（guide.ts）的结构行：它随 wire 语义变（本次加了 behavior-contract 三个顶层键），
    // 断言的是"说明头 → YAML 注释"这条渲染机制，故跟着说明头同步即可。
    // ⚠️ 只断言到反引号之前：CM 的 a11y 树把 `` ` `` 拆成独立 token（行内代码会插进分隔节点），
    // 带反引号的整行在 a11y 文本里不存在 —— 与下面 messages/input 那条"判据必须是整行"同一类坑。
    expect(yamlView).toContain("# - 顶层键分两类");
    // 顶层容器随 API 面变：chat 面 messages / responses 面 input（缺省模型是 responses）。
    // ⚠️ 判据必须是**整行**：CM 编辑器的 a11y 树把 token 拆成独立节点（键与 `:` 各一行），
    // 连写的 `messages:` 在 a11y 文本里根本不存在。
    expect(/^(messages|input)$/m.test(yamlView)).toBe(true);
    expect(yamlView).toContain("model");

    // 切「原文」= 真发 JSON（wire 一字不改）：JSON 的顶层键进屏（tool_choice / stream 是 YAML 里
    // 排在很后面的键，只有 JSON 折叠视图能一眼看到）；再切回 YAML 复原。
    // ⚠️ 键名随 API 面变（chat / responses 两套），下面两处断言都按两面写。
    const ui = await makeUiDriver(fx.electron.cdpUrl, async () => {
      const r = await fx.sh.getJson("./diy.sh ui inspect");
      return (r.data as any)?.data?.tree as A11yNode | undefined;
    });
    try {
      await ui.clickSelector('button[title*="原始 JSON"]');
      const jsonView = await waitUntil(a11yText, (s) => s.includes("tool_choice"), {
        label: "原文（真发 JSON）上屏",
      });
      // 输出上限键名同样随 API 面变：chat 面 max_tokens / responses 面 max_output_tokens
      expect(["max_tokens", "max_output_tokens"].some((k) => jsonView.includes(k))).toBe(true);
      expect(jsonView).not.toContain("# - 顶层键是变量命名空间");
      await ui.clickSelector('button[title*="内嵌的 system/runtime"]');
      const back = await waitUntil(a11yText, (s) => s.includes("# - 顶层键是变量命名空间"), {
        label: "切回 YAML 预览",
      });
      expect(back).toContain("# 系统上下文（Context Tree）");
    } finally {
      ui.close();
    }

    // ★ 变更列表读的是**真发快照文件**（不是页面自己轮询攒的）：
    //   没有实时推送 —— 改任务文件后界面**不该自己变**（"不做轮询"的可观测判据），
    //   按「⟳ 刷新」才会变。
    await fold("steps", true);
    const taskFile = join(fx.HOME, uri, "AGENTS.md");
    const before = await fx.sh.run(`cat ${taskFile}`);
    writeFileSync(taskFile, `${before.stdout}\n\n<!-- 意图测试改动 -->\n`);
    await new Promise((r) => setTimeout(r, 3000)); // 旧实现在这里是 2 秒轮询，改完 3 秒内必上屏
    const noAuto = await a11yText();
    expect(noAuto, "没有实时推送，界面不该自己变（轮询已删）").not.toContain("意图测试改动");
    // 手写一条快照（真发需要 LLM key）→ 刷新后列表 + 变更详情都要到位
    const localDir = join(fx.HOME, "local");
    mkdirSync(localDir, { recursive: true });
    const rec = (over: Record<string, unknown>) => ({
      ts: new Date().toISOString(),
      turnId: "t-intent",
      model: "mimo-v2.5",
      wireVersion: "aaaa1111",
      systemPlaces: ["diy"],
      runtimePlaces: ["task.body"],
      valueHashes: { diy: "h1", "task.body": "b1" },
      systemText: "diy:\n  cli: /repo",
      runtimeText: 'task:\n  body: "一"',
      ...over,
    });
    writeFileSync(
      join(localDir, `${keyOf(uri)}.steps.jsonl`),
      [
        rec({}),
        rec({ turnId: "t-intent-2", valueHashes: { diy: "h1", "task.body": "b2" }, runtimeText: 'task:\n  body: "二（意图测试）"' }),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    await fx.sh.getJson(`./diy.sh ui page navigate ctxlab:${uri}`); // 重挂页面 = 重拉资源
    const withSteps = await waitUntil(a11yText, (s) => s.includes("2 轮真发"), {
      label: "刷新后真发轮次上屏",
    });
    expect(withSteps).toContain("task.body");

    // 点第 2 步 → 变更详情显示"第 2 步 vs 上一步"+ 行级 diff（详情块默认收起，先展开）
    await fold("change", true);
    const ui2 = await makeUiDriver(fx.electron.cdpUrl, async () => {
      const r = await fx.sh.getJson("./diy.sh ui inspect");
      return (r.data as any)?.data?.tree as A11yNode | undefined;
    });
    try {
      // 变更列表里 reverse 过（最新在前）：nth=0 就是第 2 步那条
      await ui2.clickSelector("ul.menu li button", { nth: 0 });
      const detail = await waitUntil(a11yText, (s) => s.includes("第 2 步") && s.includes("第 1 步"), {
        label: "变更详情（步 vs 步）上屏",
      });
      expect(detail).toContain("runtime 份变化");
      expect(detail).toContain("二（意图测试）");
      expect(detail).toContain("未变（可缓存）"); // system 份没变
    } finally {
      ui2.close();
    }

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 180_000);
});
