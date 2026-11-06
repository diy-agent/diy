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
import { legacySessionFileRel, sessionFileRel } from "../src/main/core/local-paths";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type A11yNode } from "./ui-drive";
import { lockNavOpen } from "./nav-helper";

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

/** 表格里某一行（a11y 文本按行）的**单元格序列**：定位含该 path 的整行，取其后 `n` 个非空行
 *  （默认 4 = 变了 / 变化率 / 归属 / 最后）。比整页 substring 精确 —— 断言"这一行的这一列"，
 *  不会被别处文本满足（review RV-07）。a11y 文本按 **text node** 分行，所以一格若由多个
 *  span 拼成（如 `一` `→` `二`）会各占一行 —— `n` 就是给这种行留的。 */
function rowCells(text: string, needle: string, after?: string, n = 4): string[] {
  // `after` = 作用域起点（如统计块标题）：同名文本可能出现在别处（steps 列表也列变化路径），
  // 不限定作用域会命中错行。
  let body = text;
  if (after) {
    const j = body.indexOf(after);
    body = j >= 0 ? body.slice(j) : "";
  }
  const lines = body.split("\n").map((l) => l.trim());
  const i = lines.findIndex((l) => l === needle);
  if (i < 0) return [];
  return lines.slice(i + 1).filter(Boolean).slice(0, n);
}

/**
 * 清掉某 uri 的**会话落盘文件**（local/<key>.*）。
 *
 * 为什么必须清：本文件的用例**共用一个 home**（一个 Electron 实例），而 project / task 的
 * 数字 id 在 remove 之后会被**回收** —— 于是后一个用例常拿到与前面某个用例**完全相同的 uri**，
 * 同名 `local/<key>.jsonl` 就带着上一个用例的数据。多数用例是"覆盖写"（天然免疫），
 * 但断言"空任务 0 轮"、或写的是**另开的文件**（changelog）时，残留会真的把结论带偏。
 */
/** 会话文件绝对路径（跨进程：产品在真 Electron 实例的 home 里，本进程 DIY_HOME 是另一个） */
function homeFile(uri: string, kind: "ops" | "llm" | "steps" | "compact" | "changelog" | "usage" | "raw"): string {
  return join(fx.HOME, sessionFileRel(uri, kind));
}

function clearLocal(uri: string): void {
  for (const kind of ["steps", "changelog", "usage"] as const) {
    rmSync(homeFile(uri, kind), { force: true }); // 新落位
    rmSync(join(fx.HOME, legacySessionFileRel(uri, kind)), { force: true }); // 旧平铺（读侧兜底会认它）
  }
}

/** 展开/折叠该页的块（key 带 ctx. 前缀，与提示词页的块分开命名空间） */
async function fold(key: string, open: boolean): Promise<void> {
  const res = await fx.sh.getJson(`./diy.sh ui view expand ctx.${key} ${open ? "open" : "closed"}`);
  expect((res.data as any)?.status, `折叠 ${key} 失败: ${JSON.stringify(res.data)}`).toBe("ok");
}

describe("上下文树：RPC 契约（真实数据）", () => {
  it("candidates 给出候选单元；lab 返回真实 globals 与信封全文", async () => {
    const cand = await fx.sh.getJson("./diy.sh context candidates");
    const c = cand.data as unknown as any;
    const paths = c.candidates.map((x: any) => x.path);
    expect(paths).toContain("diy");
    expect(paths).toContain("task.body");
    // task 的稳定字段与易变字段被拆成不同单元（否则"按第一层划分"的毛病就回来了）
    expect(paths).toContain("task.title");
    // ##520：不再有「默认 system 名单」这层 —— 单元只由常量候选决定
    expect(c.defaultSystem).toBeUndefined();

    // 造一个真实的项目目录 + AGENTS.md 链，让 chain 有内容
    const repo = `${fx.HOME}/ctxlab`;
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(fx.HOME, "AGENTS.md"), "# 家目录规范\n- 中文回复\n");
    writeFileSync(join(repo, "AGENTS.md"), "# 项目规范\n- 先读代码\n");
    const p = await fx.sh.getJson(`./diy.sh project create "${repo}" --label 上下文树`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 上下文树任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);
    clearLocal(uri); // 撞名残留会混进断言（见 clearLocal 头注）
    await fx.sh.run(`./diy.sh task edit ${uri} --body $'任务正文第一行\\n正文第二行'`);

    const res = await fx.sh.getJson(`./diy.sh context lab ${pid} --taskUri ${uri}`);
    const d = res.data as any;
    expect(d.taskUri).toBe(uri);
    expect(d.source).toContain("真实上下文");

    // 真实 AGENTS.md 链进了信封，内容以 YAML 块标量落盘
    expect(d.text.text).toContain("chain:");
    expect(d.text.text).toContain("家目录规范");
    expect(d.text.text).toContain("项目规范");
    expect(d.text.text).toContain("content: |"); // 多行文本用块标量
    // 纯 YAML：不再有自创的 XML 外壳
    expect(d.text.text).not.toContain("<context path=");

    // 只有一份全量：任务身份（uri/dir/created/parent）与正文/易变头字段都在同一段
    expect(d.data.text).toContain("body:");
    expect(d.data.text).toContain('title: "上下文树任务"');
    expect(d.data.text).toContain("uri: ");

    // 请求体：与真发同一条构造链。形态 = [system 段, ...历史, user(runtime), user(占位输入)]
    // （真发同理：runtime 作为独立 user 消息插在**本轮输入之前**，见 runTurn 的 withRuntime）
    //
    // ⚠️ 形状随缺省模型的 **API 面** 变（缺省模型 = mimo-v2.6-flash，**chat 面**；
    //    换模型/换面时这里要跟着看）：
    //   chat 面      → messages[]，首项 role=system
    //   responses 面 → input[]，首项 role=developer（system 装在首项）
    // 断言两面都覆盖，别把测试绑死在 chat 面（main 的 template.test.ts 踩过同一个坑）。
    expect(d.request.body).toBeTruthy();
    const items = (d.request.body.input ?? d.request.body.messages) as any[];
    expect(items).toBeTruthy();
    expect(["system", "developer"]).toContain(items[0].role);
    expect(String(items[0].content)).toContain("家目录规范");
    // 末条 user = runtime 份 + "下一轮真实输入"占位 —— ⚠️ 两者**合并成一条**：
    //   投递前必过 normalizeUserRuns（provider 拒绝连续同角色；真发同样是
    //   normalizeUserRuns(withRuntime(历史, runtime))，见 local-agent）。所以别指望能
    //   数出两条 user —— 曾经那样断言过，是错的（本用例因此在 main 上一直是红的，无 CI 未暴露）。
    const lastUser = items[items.length - 1];
    expect(lastUser.role).toBe("user");
    // responses 面里 user 的 content 是 [{type:"input_text",text}]，取文本要比出两种形状
    const textOf = (m: any): string =>
      typeof m.content === "string" ? m.content : (m.content ?? []).map((p: any) => p.text ?? "").join("");
    // ##520：**信封里只有 help + vars 一份全量**，变量不再单独进尾部 user 消息
    // ⇒ 末条 user 只有 `chat:`（占位输入）。
    expect(textOf(lastUser)).toContain("chat:");
    expect(textOf(lastUser)).toContain("仿真占位");
    expect(textOf(lastUser)).not.toContain("vars:"); // 防有人把全量变量又塞回尾部（砸缓存）
    // 变量树全量在 system 里，task.body 确实在内
    expect(d.text.text).toContain("vars:");
    expect(d.text.text).toContain("body:");
    expect(d.request.model).toBeTruthy();

    // 行号映射与文本同源（选中联动高亮靠它）
    expect(d.text.lines["chain"]).toBeTruthy();
    expect(d.text.lines["task.body"]).toBeTruthy();

    // 变量树：父层级不显示值（值在下面几行里），容器标 hasValue
    const root = d.tree.find((n: any) => n.path === "task");
    expect(root.preview).toBe("");

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 90_000);

  it("候选单元来自常量名单；不再有 system 名单入口（##520）", async () => {
    const repo = `${fx.HOME}/ctxlab2`;
    mkdirSync(repo, { recursive: true });
    const p = await fx.sh.getJson(`./diy.sh project create "${repo}" --label 划分`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 划分任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);
    clearLocal(uri); // 撞名残留会混进断言（见 clearLocal 头注）

    const cand = (await fx.sh.getJson(`./diy.sh context candidates`)).data as any;
    expect(cand.candidates.length).toBeGreaterThan(0);
    expect(cand.candidates.every((c: any) => c.path && c.reason)).toBe(true);
    // 旧字段（默认 system 名单）已删
    expect(cand.defaultSystem).toBeUndefined();

    // lab 的单元集合只由值决定：task.body 是单元（它在正文里）
    const base = (await fx.sh.getJson(`./diy.sh context lab ${pid} --taskUri ${uri}`)).data as any;
    expect(base.text.places).toContain("task.body");

    // 旧 RPC（改名单）已删干净：CLI 应明确报未知命令，而不是静默忽略
    const old = await fx.sh.run(`./diy.sh context setConfig --inputLimitChars 5000`);
    expect(old.code).not.toBe(0);

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 90_000);
});

describe("上下文树：投递划分已删（##520）", () => {
  it("context.yaml 不再被读：页面/真发都不再有「名单」这一层", async () => {
    const repo = `${fx.HOME}/ctxlab-config`;
    mkdirSync(repo, { recursive: true });
    const p = await fx.sh.getJson(`./diy.sh project create "${repo}" --label 划分真源`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 划分任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);
    clearLocal(uri); // 撞名残留会混进断言（见 clearLocal 头注）
    // 正文有 10 字下限（`task edit` 会拒绝过短输入）
    await fx.sh.run(`./diy.sh task edit ${uri} --body $'划分验证正文\n第二行也在这里'`);

    // ① 旧文件存在也不影响任何东西（不再有读它的入口）
    writeFileSync(
      join(fx.HOME, "context.yaml"),
      "inputLimitChars: 5000\n",
      "utf-8",
    );
    const lab = (await fx.sh.getJson(`./diy.sh context lab ${pid} --taskUri ${uri}`)).data as any;
    expect(lab.text.places).toContain("task.body");
    expect(lab.text.places).toContain("diy");
    expect(lab.data.text).toContain("划分验证正文");

    // ② 旧 RPC 已删（读也不再有）
    const cfg = await fx.sh.run(`./diy.sh context config`);
    expect(cfg.code).not.toBe(0);

    await fx.sh.run(`./diy.sh project remove ${pid}`);
    rmSync(join(fx.HOME, "context.yaml"), { force: true });
  }, 120_000);
});

describe("上下文树：投递快照（steps）", () => {
  it("空会话 0 条；写入快照后能读出，且相邻 diff 算在 main 侧（默认只给统计）", async () => {
    const repo = `${fx.HOME}/ctxlab-steps`;
    mkdirSync(repo, { recursive: true });
    const p = await fx.sh.getJson(`./diy.sh project create "${repo}" --label 快照`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 快照任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);
    clearLocal(uri); // 撞名残留会混进断言（见 clearLocal 头注）

    const empty = await fx.sh.getJson(`./diy.sh context steps ${uri}`);
    expect((empty.data as any).total).toBe(0);
    expect((empty.data as any).steps).toEqual([]);

    // 手写两条快照（模拟两轮真发；真发本身需要 LLM key，故这里只验读取 + 汇总链路）
    const rec = (over: Record<string, unknown>) => ({
      ts: "2026-09-25T00:00:00.000Z",
      turnId: "t1",
      model: "mimo-v2.5",
      wireVersion: "aaaa1111",
      places: ["diy", "task.body"],
      valueHashes: { diy: "h1", "task.body": "b1" },
      systemText: 'help:\n  about: x\nvars:\n  diy:\n    cli: /repo\n  task:\n    body: "一"',
      ...over,
    });
    const stepsFile = homeFile(uri, "steps");
    mkdirSync(dirname(stepsFile), { recursive: true });
    writeFileSync(
      stepsFile,
      [
        rec({}),
        rec({ turnId: "t2", valueHashes: { diy: "h1", "task.body": "b2" }, systemText: 'help:\n  about: x\nvars:\n  diy:\n    cli: /repo\n  task:\n    body: "二"' }),
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
    // 第 2 步：正文变 → changed 命中，全文 diff 里看到新值
    expect(d.steps[1].sincePrev.changed).toEqual(["task.body"]);
    expect(d.steps[1].sincePrev.systemDiffers).toBe(true);
    expect(d.steps[1].sincePrev.incomparable).toBe(false);
    // --diff 才带行内容；且原文（中文）能正确回传
    expect(d.steps[1].diff.system.some((l: any) => l.t === "+" && l.s.includes("二"))).toBe(true);

    // 默认不带行内容（避免下发整份文本；也不会塞进 sincePrev）
    const plain = await fx.sh.getJson(`./diy.sh context steps ${uri}`);
    expect((plain.data as any).steps[1].diff).toBeUndefined();
    expect((plain.data as any).steps[1].sincePrev.systemSize.add).toBeGreaterThan(0);
    expect(Object.keys((plain.data as any).steps[1].sincePrev)).not.toContain("systemDiff");

    // ── diff：两种模式（都在 main 侧算完） ──
    // ① 选中某步 → 与上一步比
    const stepDiff = await fx.sh.getJson(`./diy.sh context diff ${pid} ${uri} --step 2`);
    const sd = stepDiff.data as any;
    expect(sd.mode).toBe("step");
    expect(sd.base.index).toBe(1);
    expect(sd.target.index).toBe(2);
    expect(sd.changed).toEqual(["task.body"]);
    expect(sd.systemDiffers).toBe(true); // 全文里能看到正文变
    expect(sd.systemDiff.some((l: any) => l.t === "+" && l.s.includes("二"))).toBe(true);

    // ② 不给 --step → **当前变量树** vs 最后一步（"我现在改的会不会变"）
    // （正文有 10 字下限：`task edit` 会拒绝过短输入，这里给足）
    await fx.sh.run(`./diy.sh task edit ${uri} --body $'又改了一版正文\\n第三行也在这里'`);
    const liveDiff = await fx.sh.getJson(`./diy.sh context diff ${pid} ${uri}`);
    const ld = liveDiff.data as any;
    expect(ld.mode).toBe("live");
    expect(ld.base.index).toBe(2);
    expect(ld.target).toBeNull();
    expect(ld.changed).toContain("task.body");
    expect(ld.systemDiff.some((l: any) => l.t === "+" && l.s.includes("第三行也在这里"))).toBe(true);

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
    const p = await fx.sh.getJson(`./diy.sh project create "${repo}" --label 统计`);
    const pid = String((p.data as any)?.data?.id);
    const t1 = await fx.sh.getJson(`./diy.sh task create 统计任务一 ${pid}`);
    const uri1 = String((t1.data as any)?.data?.uri);
    const t2 = await fx.sh.getJson(`./diy.sh task create 统计任务二 ${pid}`);
    const uri2 = String((t2.data as any)?.data?.uri);

    const empty = await fx.sh.getJson(`./diy.sh context stats ${pid}`);
    expect((empty.data as any).turns).toBe(0);
    expect((empty.data as any).paths).toEqual([]);

    // 手写统计（真发需要 LLM key）：任务一 4 轮 / 任务二 1 轮。
    // ⚠️ 每个任务的**首轮基线**按老写入器的样子写（把当时存在的 path 全记成 changed）——
    // RV-15 实测的存量污染正是这样落盘的，读侧必须抹平（否则从不变过的 diy 会显示成"变了 N 次"）。
    const stat = (ts: string, taskUri: string, changed: string[]) =>
      JSON.stringify({ ts, taskUri, turnId: `t-${ts}`, changed });
    const fp = join(fx.HOME, "projects", pid, "context-stats.jsonl");
    mkdirSync(join(fx.HOME, "projects", pid), { recursive: true });
    writeFileSync(
      fp,
      [
        stat("2026-09-26T00:30:00.000Z", uri1, ["chain.0", "diy", "task.body"]), // 任务一首轮基线（污染）
        stat("2026-09-26T01:00:00.000Z", uri1, ["chain.0"]), // ← 唯一一次真变化
        stat("2026-09-26T02:00:00.000Z", uri1, []),
        stat("2026-09-26T03:00:00.000Z", uri1, []),
        stat("2026-09-26T04:00:00.000Z", uri2, ["task.body", "chain.0"]), // 任务二首轮基线（污染）
      ].join("\n") + "\n",
    );

    // 整个项目累计：5 轮（首轮也算真发轮 —— 分母口径不能被"没变"或"基线"改写）
    const all = (await fx.sh.getJson(`./diy.sh context stats ${pid}`)).data as any;
    expect(all.turns).toBe(5);
    expect(all.since).toBe("2026-09-26T00:30:00.000Z");
    expect(all.until).toBe("2026-09-26T04:00:00.000Z");
    const chain = all.paths.find((x: any) => x.path === "chain.0");
    expect(chain.changes).toBe(1); // ★ 首轮基线那一次不算（RV-15）；旧口径会算成 2
    expect(chain.rate).toBeCloseTo(1 / 5); // 分母是总轮数（含没变的那轮）
    expect(chain.turns).toEqual([2]); // 只剩那一次真变化
    // ★ 从没真变过的节点不再上榜（旧口径：diy 记了 1 次首轮 → 谎报"变了"）
    expect(all.paths.find((x: any) => x.path === "diy")).toBeUndefined();
    // ★ 任务二只有首轮基线 → task.body 也不该上榜
    expect(all.paths.find((x: any) => x.path === "task.body")).toBeUndefined();

    // 按任务过滤：只有任务一的 4 轮
    const only1 = (await fx.sh.getJson(`./diy.sh context stats ${pid} --taskUri ${uri1}`)).data as any;
    expect(only1.turns).toBe(4);
    expect(only1.paths.find((x: any) => x.path === "task.body")).toBeUndefined();

    // ★ 抹平发生在 filter/slice **之前**：limit 切掉的若含首轮，也不影响别的任务
    // （若在切片后抹平，任务二那条基线会被当成"真变化"）
    const last2 = (await fx.sh.getJson(`./diy.sh context stats ${pid} --limit 2`)).data as any;
    expect(last2.records).toBe(5); // 总数仍报 5（未被 limit 掩盖）
    expect(last2.turns).toBe(2);
    expect(last2.paths.find((x: any) => x.path === "task.body")).toBeUndefined();

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 90_000);
});

describe("上下文树：变更历史（事件粒度）", () => {
  it("空任务 0 轮；无日志时从投递快照**折算**（只有 path）；有日志时按事件回放（op + 旧→新）", async () => {
    const repo = `${fx.HOME}/ctxlab-log`;
    mkdirSync(repo, { recursive: true });
    const p = await fx.sh.getJson(`./diy.sh project create "${repo}" --label 变更历史`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 变更历史任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);
    clearLocal(uri); // 本用例断言"空任务 0 轮" —— 先清掉可能撞名的残留（见 clearLocal 头注）

    const empty = await fx.sh.getJson(`./diy.sh context changelog ${uri}`);
    expect((empty.data as any).total).toBe(0);
    expect((empty.data as any).entries).toEqual([]);

    // 手写两条**真发投递快照**（老任务的样子：有快照、还没有变更日志）→ 读侧折算
    const rec = (over: Record<string, unknown>) => ({
      ts: "2026-09-30T00:00:00.000Z",
      turnId: "t1",
      model: "mimo-v2.5",
      wireVersion: "aaaa1111",
      places: ["diy", "task.body"],
      valueHashes: { diy: "h1", "task.body": "b1" },
      systemText: 'help:\n  about: x\nvars:\n  diy:\n    cli: /repo\n  task:\n    body: "一"',
      ...over,
    });
    const stepsFile = homeFile(uri, "steps");
    mkdirSync(dirname(stepsFile), { recursive: true });
    writeFileSync(
      stepsFile,
      [
        rec({}),
        rec({ turnId: "t2", valueHashes: { diy: "h1", "task.body": "b2" }, systemText: 'help:\n  about: x\nvars:\n  diy:\n    cli: /repo\n  task:\n    body: "二"' }),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    const derived = await fx.sh.getJson(`./diy.sh context changelog ${uri}`);
    const dv = derived.data as any;
    expect(dv.source).toBe("derived");
    expect(dv.total).toBe(2);
    expect(dv.entries.map((x: any) => x.ref.step)).toEqual([1, 2]);
    expect(dv.entries[0].type).toBe("baseline");
    // 折算拿不到值（快照不存值）→ 只到 path 粒度，不编预览
    expect(dv.entries[1].changes).toEqual([
      { kind: "update", path: "task.body", before: null, after: null },
    ]);
    // ref 从投递快照按 turnId join：第 2 轮的划分 + 两份容器是否变
    expect(dv.entries[1].systemDiffers).toBe(true);
    expect(dv.entries[1].incomparable).toBe(false);
    expect(dv.entries[1].cost).toBeNull(); // 没有用量账本 → 不编数

    const op = (over: Record<string, unknown>) => ({
      ts: "2026-09-30T00:00:00.000Z",
      turnId: "t1",
      model: "mimo-v2.5",
      wireVersion: "aaaa1111",
      ops: [] as unknown[],
      ...over,
    });
    const logFile = homeFile(uri, "changelog");
    mkdirSync(dirname(logFile), { recursive: true });
    writeFileSync(
      logFile,
      [
        op({ ops: [{ kind: "add", path: "task.body", preview: "一" }] }),
        op({ turnId: "t2", ops: [{ kind: "update", path: "task.body", preview: "二" }] }),
        op({ turnId: "t3", ops: [{ kind: "remove", path: "task.body", preview: null }] }),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    const log = await fx.sh.getJson(`./diy.sh context changelog ${uri}`);
    const lv = log.data as any;
    expect(lv.source).toBe("log"); // 有日志就以日志为准（预览/方向只有它有）
    expect(lv.total).toBe(3);
    // 老→新由回放得出：落盘只存"改成了什么"
    expect(lv.entries[0].changes).toEqual([{ kind: "add", path: "task.body", before: null, after: "一" }]);
    expect(lv.entries[1].changes).toEqual([{ kind: "update", path: "task.body", before: "一", after: "二" }]);
    expect(lv.entries[2].changes).toEqual([{ kind: "remove", path: "task.body", before: "二", after: null }]);

    // --limit 只截尾（total 仍是全部）
    const limited = await fx.sh.getJson(`./diy.sh context changelog ${uri} --limit 1`);
    expect((limited.data as any).total).toBe(3);
    expect((limited.data as any).entries.map((x: any) => x.ref.step)).toEqual([3]);

    // 重置起点：命令只**置位**（落盘要等下一次真发 —— 起点只能在轮首写），故这里只验契约
    const rl = await fx.sh.getJson(`./diy.sh context rebaseline ${uri}`);
    expect((rl.data as any).ok).toBe(true);
    expect(String((rl.data as any).message)).toContain("baseline");

    // 清干净再走：后面还有用例会撞名（它们只覆盖写 steps，会被这份 changelog 压过）
    clearLocal(uri);
    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 90_000);
});

describe("上下文树：变更历史**表格**上屏（轮次 | 步 | 实际请求）", () => {
  it("三列表格：只到「步」这一层（不列具体变化字段）；点行选中该步", async () => {
    const repo = `${fx.HOME}/ctxlab-logui`;
    mkdirSync(repo, { recursive: true });
    const p = await fx.sh.getJson(`./diy.sh project create "${repo}" --label 变更历史上屏`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 变更历史上屏任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);
    clearLocal(uri); // 撞名的残留会混进这份历史（见 clearLocal 头注）

    // 手写变更日志（真发需要 LLM key）：baseline（task.body = 一）→ update（一 → 二）
    const op = (over: Record<string, unknown>) => ({
      ts: "2026-09-30T00:00:00.000Z",
      turnId: "t1",
      model: "mimo-v2.5",
      wireVersion: "aaaa1111",
      ops: [] as unknown[],
      ...over,
    });
    const changelogFile = homeFile(uri, "changelog");
    mkdirSync(dirname(changelogFile), { recursive: true });
    writeFileSync(
      changelogFile,
      [
        op({ ops: [{ kind: "add", path: "task.body", preview: "一" }] }),
        op({ turnId: "t2", ops: [{ kind: "update", path: "task.body", preview: "二" }] }),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );

    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await fx.sh.getJson(`./diy.sh ui tab open ctxlab:${uri}`);
    await fx.sh.getJson(`./diy.sh ui page navigate ctxlab:${uri}`);
    await fold("history", true);

    const s = await waitUntil(
      a11yText,
      (x) => x.includes("变更历史（真发轮次）") && x.includes("实际请求") && x.includes("2 条记录"),
      { label: "变更历史表格上屏" },
    );
    // 折叠块口径：记录数 + 变更次数（基线不算"变更"）
    expect(s).toContain("2 条记录 · 1 次变更");
    // 三列表格（表头）：轮次 | 步 | 实际请求
    expect(s).toContain("轮次");
    expect(s).toContain("实际请求");
    // ★ 表格只到"步"这一层：**不列具体变化的值**（值预览在中栏「变量树变更」里；行 title 只有
    //    路径级的"本步改了哪几处"，供鼠标悬停时按需查看 —— 不进表格正文、不占版面）
    expect(s).not.toContain("一 → 二");
    // 有日志 → 不该出现折算的说明（那是降级路径）
    expect(s).not.toContain("降级视图");

    const ui = await makeUiDriver(fx.electron.cdpUrl, async () => {
      const r = await fx.sh.getJson("./diy.sh ui inspect");
      return (r.data as any)?.data?.tree as A11yNode | undefined;
    });
    try {
      // 点表格第一行（最新在前 = 第 2 步那条）→ 选中该步。
      // ⚠️ 点 `<td>` 而不是 `tr`：行尾「查看实际请求」链接会 `stopPropagation`，
      //    点它只弹抽屉、不选中行。判据 = 该行拿到选中态 class（`ring-primary`）。
      await ui.clickSelector("table tbody tr td", { nth: 0 });
      const hasSel = async (): Promise<boolean> =>
        ui.query<boolean>(
          "Array.from(document.querySelectorAll('table tbody tr')).some((r) => r.className.includes('ring-primary'))",
        );
      const selWait = await waitUntil(hasSel, (x) => x === true, { label: "点行 → 选中该步" });
      expect(selWait).toBe(true);
    } finally {
      ui.close();
    }

    clearLocal(uri); // 清干净再走（后面的用例会撞名）
    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 120_000);
});

describe("上下文树：UI 上屏（两列 + 信封原始数据 `<>`）", () => {
  it("两列上屏；已删的「请求预览 / 变更详情」不复现；点行 → 两侧 diff；`<>` 切原始数据", async () => {
    const repo = `${fx.HOME}/ctxlab3`;
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "## 本项目的规范\n- 精简\n");
    const p = await fx.sh.getJson(`./diy.sh project create "${repo}" --label 上屏`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 上屏任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);
    clearLocal(uri);

    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await fx.sh.getJson(`./diy.sh ui tab open ctxlab:${uri}`);

    // 两列：结构树（左）/ 中栏（变量树变更 · system diff · 该步实际请求）
    const base = await waitUntil(
      a11yText,
      (s) => s.includes("变量（契约）") && s.includes("变量树变更（整棵树 + 标注）"),
      { label: "上下文树页两列上屏" },
    );
    expect(base).toContain("真实上下文");
    // 已删的两个 view 不该再上屏（##310 六轮：仿真请求体与错位的"变更详情"都不要了）
    for (const g of ["请求预览（实际发送格式）", "变更详情", "system 份（稳定", "runtime 份（易变", "投递单元"]) {
      expect(base, `已删的视图不该再上屏：${g}`).not.toContain(g);
    }
    // 中栏三块标题常驻（##520：信封只有一份，不再有 runtime diff 那一块）
    expect(base).toContain("system diff（逐行 · 真发全文）");
    expect(base).not.toContain("runtime diff");
    expect(base).toContain("该步实际请求（真发 · 流量）");

    // 真实 AGENTS.md 内容上屏（等 RPC；首帧 system 名单还没加载完）
    const withChain = await waitUntil(a11yText, (s) => s.includes("本项目的规范"), {
      label: "真实 AGENTS.md 链上屏",
    });
    // 结构树是契约（含类型/描述与无值的变量）
    expect(withChain).toContain("AGENTS.md 链");
    expect(withChain).toContain("技能清单");
    // 与提示词页互不干扰：另一个 page 的块不该出现
    expect(withChain).not.toContain("_system.md");
    expect(withChain).toContain("chain");
    expect(withChain).toContain("变更历史（真发轮次）");

    // ★ `<>` 原始数据（每个 view 都有）：结构树那一块切出来的是**契约 JSON**
    const ui = await makeUiDriver(fx.electron.cdpUrl, async () => {
      const r = await fx.sh.getJson("./diy.sh ui inspect");
      return (r.data as any)?.data?.tree as A11yNode | undefined;
    });
    try {
      await ui.clickSelector('button[title*="结构树"]');
      const raw = await waitUntil(a11yText, (s) => s.includes('"name"') && s.includes("chain"), {
        label: "结构树 `<>` 原始数据上屏",
      });
      expect(raw).toContain('"name"');
      // 再点一下切回视图
      await ui.clickSelector('button[title*="结构树"]');
      const back = await waitUntil(a11yText, (s) => s.includes("变量（契约）"), {
        label: "切回结构树视图",
      });
      expect(back).toContain("变量（契约）");
    } finally {
      ui.close();
    }

    // 真发快照（手写）+ 变更日志 → 左栏表格一行；点行 → 中栏两侧 diff（轮级 · 文本级）
    const stepsFile = homeFile(uri, "steps");
    mkdirSync(dirname(stepsFile), { recursive: true });
    const rec = (over: Record<string, unknown>) => ({
      ts: "2026-10-15T00:00:00.000Z",
      turnId: "t-intent",
      model: "mimo-v2.5",
      wireVersion: "aaaa1111",
      places: ["diy", "task.body"],
      valueHashes: { diy: "h1", "task.body": "b1" },
      systemText: "help:\n  about: x\nsystem:\n  diy:\n    cli: /repo",
      ...over,
    });
    writeFileSync(
      stepsFile,
      [
        rec({}),
        rec({
          turnId: "t-intent-2",
          valueHashes: { diy: "h1", "task.body": "b2" },
          systemText: "help:\n  about: x\nsystem:\n  diy:\n    cli: /repo/v2",
        }),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    const clEntry = (over: Record<string, unknown>) => ({
      seq: 0,
      type: "baseline",
      ts: "2026-10-15T00:00:00.000Z",
      model: "mimo-v2.5",
      wireVersion: "aaaa1111",
      ref: { turnId: "t-intent", stepId: "t-intent_s1", step: 1 },
      data: { tree: { values: { task: { body: "一" } }, renderers: {}, places: [], placement: {}, wireVersion: "aaaa1111" } },
      ...over,
    });
    const logFile = homeFile(uri, "changelog");
    mkdirSync(dirname(logFile), { recursive: true });
    writeFileSync(
      logFile,
      [
        clEntry({}),
        clEntry({
          seq: 1,
          type: "changed",
          ts: "2026-10-15T00:00:05.000Z",
          ref: { turnId: "t-intent-2", stepId: "t-intent-2_s1", step: 1 },
          data: { changes: [{ type: "update", path: "task.body", data: { before: "一", after: "二（意图测试）" } }] },
        }),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    // ⚠️ 别拿 `ui page navigate` 当"重挂页面"：App.tsx 的 `VALID_PAGES` 只收
    //    task / task-run / lab / llm / settings，`ctxlab:...` 会被**直接忽略**（no-op）。
    //    这里点页面自己的「⟳ 刷新」—— 也正是"没有实时推送"这条契约的正当用法。
    await fold("history", true);
    await fold("sysdiff", true);
    await fold("vardiff", true);
    const uiRefresh = await makeUiDriver(fx.electron.cdpUrl, async () => {
      const r = await fx.sh.getJson("./diy.sh ui inspect");
      return (r.data as any)?.data?.tree as A11yNode | undefined;
    });
    try {
      await uiRefresh.clickSelector('button[title*="重新计算"]');
    } finally {
      uiRefresh.close();
    }
    const withSteps = await waitUntil(a11yText, (s) => s.includes("2 条记录"), {
      label: "刷新后真发轮次上屏",
    });
    // 表格只到"步"这一层：**不列具体变化的字段**
    expect(withSteps).toContain("实际请求");
    expect(withSteps).not.toContain("一 → 二（意图测试）");

    // 点表格第一行（最新在前 = 第 2 步那条）→ 中栏两侧 diff 上屏
    const ui2 = await makeUiDriver(fx.electron.cdpUrl, async () => {
      const r = await fx.sh.getJson("./diy.sh ui inspect");
      return (r.data as any)?.data?.tree as A11yNode | undefined;
    });
    try {
      await ui2.clickSelector("table tbody tr td", { nth: 0 });
    } finally {
      ui2.close();
    }
    const detail = await waitUntil(a11yText, (s) => s.includes("第 2 轮") && s.includes("第 1 轮"), {
      label: "两侧 diff（轮 vs 轮）上屏",
    });
    expect(detail).toContain("/repo/v2");
    expect(detail).toContain("二（意图测试）");
    expect(detail).toContain("绿 = 新增行，红 = 删除行");

    // ★ `<>` 的说明走 view 顶的 **info bar**，**不掺进原始数据正文**（用户 2026-10-15：
    // 「上面这一段不要出现，不要人误会这也是发出去的」）。判据：说明句在（info bar），
    // 而带 `#` 前缀的那一份**不在**（正文只留真发字节）。
    const ui3 = await makeUiDriver(fx.electron.cdpUrl, async () => {
      const r = await fx.sh.getJson("./diy.sh ui inspect");
      return (r.data as any)?.data?.tree as A11yNode | undefined;
    });
    try {
      await ui3.clickSelector('button[title*="system diff"]');
    } finally {
      ui3.close();
    }
    const rawSys = await waitUntil(a11yText, (s) => s.includes("该步真发的 system 参数全文"), {
      label: "system `<>` 原始数据 + info bar 上屏",
    });
    expect(rawSys).not.toContain("# 该步真发的 system 参数全文"); // 注释不再进正文
    expect(rawSys).toContain("二（意图测试）"); // 正文 = 真发的组装字节

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 180_000);
});

describe("上下文树：可见性增强（统计接页 / 变更原因 / tab 标题）", () => {
  it("统计块上屏（行单元格）；sys 徽章标出段首重建；nav tab 标题为「上下文树」", async () => {
    const repo = `${fx.HOME}/ctxlab-vis`;
    mkdirSync(repo, { recursive: true });
    const p = await fx.sh.getJson(`./diy.sh project create "${repo}" --label 可见性`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 可见性任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);
    clearLocal(uri); // 撞名残留会混进断言（见 clearLocal 头注）

    // 手写两条快照：第二条 `chain.0` 值变 → 全文 diff 非空 ⇒ 标一个 sys 徽章。
    const rec = (over: Record<string, unknown>) => ({
      ts: "2026-09-27T00:00:00.000Z",
      turnId: "v1",
      model: "mimo-v2.5",
      wireVersion: "aaaa1111",
      places: ["chain", "task.body"],
      valueHashes: { "chain.0": "c1", "task.body": "b1" },
      systemText: "chain:\n  - path: /a",
      ...over,
    });
    const stepsFile = homeFile(uri, "steps");
    mkdirSync(dirname(stepsFile), { recursive: true });
    writeFileSync(
      stepsFile,
      [
        rec({}),
        rec({
          turnId: "v2",
          valueHashes: { "chain.0": "c2", "task.body": "b1" },
          systemText: "chain:\n  - path: /b",
        }),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );

    // 手写项目累计统计（真发需 LLM key）：chain.0 变 2 次 / 共 4 轮 → 变化率 50%
    // （第 1 条是该任务的首轮基线，按 RV-15 记成 changed: []）
    const stat = (ts: string, changed: string[]) =>
      JSON.stringify({ ts, taskUri: uri, turnId: `s-${ts}`, changed });
    mkdirSync(join(fx.HOME, "projects", pid), { recursive: true });
    writeFileSync(
      join(fx.HOME, "projects", pid, "context-stats.jsonl"),
      [
        stat("2026-09-27T00:00:00.000Z", []),
        stat("2026-09-27T01:00:00.000Z", ["chain.0", "diy"]),
        stat("2026-09-27T02:00:00.000Z", ["chain.0"]),
        stat("2026-09-27T03:00:00.000Z", []),
      ].join("\n") + "\n",
    );

    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await fx.sh.getJson(`./diy.sh ui tab open ctxlab:${uri}`);
    await fx.sh.getJson(`./diy.sh ui page navigate ctxlab:${uri}`);

    const ui = await makeUiDriver(fx.electron.cdpUrl, async () => {
      const r = await fx.sh.getJson("./diy.sh ui inspect");
      return (r.data as any)?.data?.tree as A11yNode | undefined;
    });
    try {
      // R3: nav 侧栏 tab 标题 = 「上下文树 #N」（收起态是 rail，label 要展开侧栏才看得到）
      await lockNavOpen(ui);
      const nav = await waitUntil(a11yText, (s) => /上下文树 #\d+/.test(s), {
        label: "nav tab 标题为「上下文树 #N」",
      });
      expect(nav).toMatch(/上下文树 #\d+/);

      // R1: 展开「变更统计」块 → 表头口径 + **该行单元格序列**（不是整页模糊匹配）
      await fold("stats", true);
      const st = await waitUntil(
        a11yText,
        (s) => s.includes("项目累计 · 4 轮 · 1 个任务") && s.includes("chain.0"),
        { label: "变更统计（项目累计）上屏" },
      );
      expect(st).toContain("项目累计 · 4 轮 · 1 个任务"); // RV-04：口径写清（轮数 + 任务数）
      // chain.0：变了 2 次 / 4 轮 = 50%；归属收拢到投递单元 chain
      expect(rowCells(st, "chain.0", "变更统计（项目累计）").slice(0, 3)).toEqual(["2", "50%", "chain"]);

      // R2: 展开「变更历史」→ 全文变了的轮次带 sys 徽章（##520 起不再编「由谁引起」）
      await fold("history", true);
      const sp = await waitUntil(a11yText, (s) => /^sys$/m.test(s), {
        label: "sys 徽章标出段首重建",
      });
      expect(sp).toMatch(/^sys$/m);
    } finally {
      ui.close();
    }

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 120_000);
});

describe("上下文树：归属三态与中间容器折叠（review RV-01 / RV-03）", () => {
  it("单元 / 未投递 分别标注；中间容器（task）折叠不单列", async () => {
    const repo = `${fx.HOME}/ctxlab-attr`;
    mkdirSync(repo, { recursive: true });
    const p = await fx.sh.getJson(`./diy.sh project create "${repo}" --label 归属`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 归属任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);
    clearLocal(uri); // 撞名残留会混进断言（见 clearLocal 头注）

    // 统计：task（中间容器，子字段横跨 system/runtime）/ persona.name（根本不在投递里）/
    // chain.0（system 单元 chain 的叶子）/ skills（runtime 单元）/ task.body（runtime 单元）
    const stat = (ts: string, changed: string[]) =>
      JSON.stringify({ ts, taskUri: uri, turnId: `s-${ts}`, changed });
    mkdirSync(join(fx.HOME, "projects", pid), { recursive: true });
    writeFileSync(
      join(fx.HOME, "projects", pid, "context-stats.jsonl"),
      [
        stat("2026-09-27T23:00:00.000Z", []), // 首轮基线（RV-15）
        stat("2026-09-28T00:00:00.000Z", ["chain.0", "persona.name", "task", "skills"]),
        stat("2026-09-28T01:00:00.000Z", ["task.body"]),
      ].join("\n") + "\n",
    );

    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await fx.sh.getJson(`./diy.sh ui tab open ctxlab:${uri}`);
    await fx.sh.getJson(`./diy.sh ui page navigate ctxlab:${uri}`);
    await fold("stats", true);

    const st = await waitUntil(a11yText, (s) => s.includes("persona.name") && s.includes("变更统计（项目累计）"), {
      label: "归属统计表上屏",
    });
    // ① chain.0 → 归到投递单元 chain（system）
    expect(rowCells(st, "chain.0", "变更统计（项目累计）").slice(0, 3)).toEqual(["1", "33%", "chain"]);
    // ② persona.name → 未投递（不谎报 runtime）
    expect(rowCells(st, "persona.name", "变更统计（项目累计）").slice(0, 3)).toEqual(["1", "33%", "未投递"]);
    // ③ skills → runtime 单元 skills
    expect(rowCells(st, "skills", "变更统计（项目累计）").slice(0, 3)).toEqual(["1", "33%", "skills"]);
    // ④ task.body → runtime 单元 task.body
    expect(rowCells(st, "task.body", "变更统计（项目累计）").slice(0, 3)).toEqual(["1", "33%", "task.body"]);
    // ⑤ task（中间容器）折叠，不单列（否则会显示与事实相反的归属）
    expect(st).toContain("已折叠 1 个中间容器");

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 120_000);
});

describe("上下文树：sys 徽章只看快照自身（##520）", () => {
  it("同一历史轮次反复重开页面，徽章与全文 diff 结论不变（不依赖当前状态）", async () => {
    const repo = `${fx.HOME}/ctxlab-cause`;
    mkdirSync(repo, { recursive: true });
    const p = await fx.sh.getJson(`./diy.sh project create "${repo}" --label 归因`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 归因任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);
    clearLocal(uri); // 撞名残留会混进断言（见 clearLocal 头注）

    const rec = (over: Record<string, unknown>) => ({
      ts: "2026-09-29T00:00:00.000Z",
      turnId: "v1",
      model: "mimo-v2.5",
      wireVersion: "aaaa1111",
      places: ["chain", "task.body"],
      valueHashes: { "chain.0": "c1", "task.body": "b1" },
      systemText: "chain:\n  - path: /a",
      ...over,
    });
    const stepsFile = homeFile(uri, "steps");
    mkdirSync(dirname(stepsFile), { recursive: true });
    writeFileSync(
      stepsFile,
      [
        rec({}),
        rec({ turnId: "v2", valueHashes: { "chain.0": "c2", "task.body": "b1" }, systemText: "chain:\n  - path: /b" }),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );

    const open = async () => {
      await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
      await fx.sh.getJson(`./diy.sh ui tab open ctxlab:${uri}`);
      await fx.sh.getJson(`./diy.sh ui page navigate ctxlab:${uri}`);
      await fold("history", true);
    };
    const sysBadge = (text: string): string =>
      text.split("\n").map((l) => l.trim()).find((l) => /^sys(\s|$)/.test(l)) ?? "(无)";

    try {
      await open();
      const before = await waitUntil(a11yText, (s) => /^sys$/m.test(s), { label: "徽章上屏" });
      expect(sysBadge(before)).toBe("sys");
      await open(); // 重挂页面 = 重拉资源
      const after = await waitUntil(a11yText, (s) => s.includes("变更历史（真发轮次）"), {
        label: "重开页面",
      });
      // 结论只由快照字节决定，与页面当前统计/列表状态无关
      expect(sysBadge(after)).toBe("sys");
    } finally {
      await fx.sh.run(`./diy.sh project remove ${pid}`);
    }
  }, 120_000);
});

describe("上下文树：统计与归因的边界（review RV-07 / RV-08）", () => {
  it("统计空态有出口；sys 徽章无原因时不谎报原因", async () => {
    // ① 空项目：stats 空态文案（不是永久「加载中…」）
    const repoA = `${fx.HOME}/ctxlab-empty`;
    mkdirSync(repoA, { recursive: true });
    const pa = await fx.sh.getJson(`./diy.sh project create "${repoA}" --label 空统计`);
    const pidA = String((pa.data as any)?.data?.id);
    const ta = await fx.sh.getJson(`./diy.sh task create 空统计任务 ${pidA}`);
    const uriA = String((ta.data as any)?.data?.uri);
    clearLocal(uriA); // 撞名残留会混进断言（见 clearLocal 头注）
    await fx.sh.getJson(`./diy.sh ui tab open ${uriA}`);
    await fx.sh.getJson(`./diy.sh ui tab open ctxlab:${uriA}`);
    await fx.sh.getJson(`./diy.sh ui page navigate ctxlab:${uriA}`);
    await fold("stats", true);
    const empty = await waitUntil(a11yText, (s) => s.includes("还没有变化记录"), {
      label: "统计空态",
    });
    expect(empty).toContain("还没有变化记录");
    await fx.sh.run(`./diy.sh project remove ${pidA}`);

    // ② sys 徽章「无原因」fallback：systemText 变了但没有 system 单元值变化 → 只显示 sys，不编原因
    const repoB = `${fx.HOME}/ctxlab-nocause`;
    mkdirSync(repoB, { recursive: true });
    const pb = await fx.sh.getJson(`./diy.sh project create "${repoB}" --label 无原因`);
    const pidB = String((pb.data as any)?.data?.id);
    const tb = await fx.sh.getJson(`./diy.sh task create 无原因任务 ${pidB}`);
    const uriB = String((tb.data as any)?.data?.uri);
    clearLocal(uriB); // 撞名残留会混进断言（见 clearLocal 头注）
    const rec = (over: Record<string, unknown>) => ({
      ts: "2026-09-30T00:00:00.000Z",
      turnId: "n1",
      model: "mimo-v2.5",
      wireVersion: "aaaa1111",
      places: ["chain", "task.body"],
      valueHashes: { "chain.0": "c1", "task.body": "b1" },
      systemText: "chain:\n  - path: /a",
      ...over,
    });
    const stepsFileB = homeFile(uriB, "steps");
    mkdirSync(dirname(stepsFileB), { recursive: true });
    writeFileSync(
      stepsFileB,
      [
        rec({}),
        // systemText 变了，但变化的只有 runtime 的 task.body → 无 system 原因
        rec({ turnId: "n2", valueHashes: { "chain.0": "c1", "task.body": "b2" }, systemText: "chain:\n  - path: /a\n# x" }),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    await fx.sh.getJson(`./diy.sh ui tab open ${uriB}`);
    await fx.sh.getJson(`./diy.sh ui tab open ctxlab:${uriB}`);
    await fx.sh.getJson(`./diy.sh ui page navigate ctxlab:${uriB}`);
    await fold("history", true);
    const noCause = await waitUntil(a11yText, (s) => /^sys$/m.test(s), {
      label: "sys 徽章（无原因）上屏",
    });
    expect(noCause).toMatch(/^sys$/m); // 徽章文本恰好是 sys（没有尾巴编出来的原因）
    await fx.sh.run(`./diy.sh project remove ${pidB}`);
  }, 120_000);
});

describe("上下文树：归属口径标注与 URI 解析失败出口（review RV-09 / RV-13）", () => {
  it("统计块写明「归属列与折叠均按当前划分」；被打开的 uri 解析不出项目 → 明确空态（不是永久加载中）", async () => {
    // ① 正常项目：统计块应有口径标注（RV-09：与 sys 徽章的「当轮快照」口径有意不同，必须写出来；
    //    RV-17：**折叠数**同样随当前划分变，标注必须一并覆盖它，否则用户以为只有归属列受影响）
    const repo = `${fx.HOME}/ctxlab-scope`;
    mkdirSync(repo, { recursive: true });
    const p = await fx.sh.getJson(`./diy.sh project create "${repo}" --label 口径`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create 口径任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);
    clearLocal(uri); // 撞名残留会混进断言（见 clearLocal 头注）
    // 一条统计记录（有变化 → 表非空，块头 + 口径标注都渲染）
    mkdirSync(join(fx.HOME, "projects", pid), { recursive: true });
    writeFileSync(
      join(fx.HOME, "projects", pid, "context-stats.jsonl"),
      JSON.stringify({ ts: "2026-10-01T00:00:00.000Z", taskUri: uri, turnId: "s1", changed: ["chain.0"] }) + "\n",
    );

    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await fx.sh.getJson(`./diy.sh ui tab open ctxlab:${uri}`);
    await fx.sh.getJson(`./diy.sh ui page navigate ctxlab:${uri}`);
    await fold("stats", true);
    const scoped = await waitUntil(a11yText, (s) => s.includes("归属列与折叠均按当前划分"), {
      label: "归属列口径标注上屏",
    });
    expect(scoped).toContain("归属列与折叠均按当前划分");
    expect(scoped).toContain("历史轮次的原因看「变更历史（真发轮次）」的 sys 徽章，按当轮快照");

    // ② RV-13：URI 解析不出项目（非 projects/<pid>/tasks/<tid> 形状）→ 明确空态出口
    //    （原分支 `if (!pid) return null` 会永久停在「统计加载中…」）
    await fx.sh.getJson(`./diy.sh ui tab open ctxlab:not-a-task`);
    await fx.sh.getJson(`./diy.sh ui page navigate ctxlab:not-a-task`);
    await fold("stats", true);
    const bad = await waitUntil(a11yText, (s) => s.includes("无法从任务 URI 解析出项目"), {
      label: "URI 解析失败空态",
    });
    expect(bad).toContain("无法从任务 URI 解析出项目");

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 120_000);
});

describe("上下文树：变量树变更 view + 该步实际请求（真发 · 流量）", () => {
  /**
   * 这一组钉住 ##310 的两条契约：
   *   · 「变量树变更」由**被点/生效的那条记录**驱动（整棵树 + 命中节点标注），不再用"轮序"间接映射
   *     —— 那是"点击 ↔ 详情对不上"的根因（review 意见 1）；
   *   · 「该步实际请求」拿**流量日志**当地面真相（按 turnId + 记录时刻挑该步那条），
   *     有 → 列出会话消息 + 可跳流量页；没有 → 明确提示（不编）。
   *
   * 两个任务分别覆盖"有流量"与"无流量"两条路（都**不点变更历史**就能到达：
   * 未选中时展示最后一条**有变**的记录）—— 判定不依赖点击坐标，稳。
   */
  const state = {
    values: { task: { title: "一" } },
    renderers: {},
    places: [],
    placement: {},
    wireVersion: "w1",
    placementEpoch: 0,
  };
  const entry = (over: Record<string, unknown>) => ({
    seq: 0,
    type: "baseline",
    ts: "2026-10-15T00:00:00.000Z",
    model: "mimo-v2.5",
    wireVersion: "w1",
    ref: { turnId: "t-a", stepId: "t-a_s1", step: 1 },
    data: { tree: state },
    ...over,
  });
  const emptyAndWrite = async (label: string, entries: unknown[]) => {
    const repo = `${fx.HOME}/ctxlab-${label}`;
    mkdirSync(repo, { recursive: true });
    const p = await fx.sh.getJson(`./diy.sh project create "${repo}" --label ${label}`);
    const pid = String((p.data as any)?.data?.id);
    const t = await fx.sh.getJson(`./diy.sh task create ${label}任务 ${pid}`);
    const uri = String((t.data as any)?.data?.uri);
    clearLocal(uri);
    const changelogFile = homeFile(uri, "changelog");
    mkdirSync(dirname(changelogFile), { recursive: true });
    writeFileSync(
      changelogFile,
      entries.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    return { pid, uri };
  };
  // 真发流量日志（traffic.query 直接扫这个文件）：同一个 turn 两条请求（第 1 步 / 第 2 步）。
  // 两条用不同耗时区分（0.11s / 0.22s）—— 用来钉"挑中的是该步那条"，不是"随便挑了该轮第一条"。
  const rec = (ts: number, attempt: number, uri: string) => ({
    _fmt: "1.0",
    id: attempt,
    ts,
    kind: "llm",
    session: "s",
    taskUri: uri,
    turnId: "t-b",
    provider: "x",
    model: "mimo-v2.6-flash",
    baseUrl: "https://x",
    method: "POST",
    url: "https://x/v1/chat/completions",
    host: "x",
    path: "/v1/chat/completions",
    attempt,
    maxRetries: 2,
    status: 200,
    ms: attempt * 111,
    reqBytes: attempt,
    resBytes: 1,
    reqHeaders: {},
    resHeaders: {},
    resNote: null,
    traceId: `tr-${attempt}`,
    err: null,
    reqBody: {
      head: JSON.stringify({
        messages: [
          { role: "system", content: `SYS-MARK-310-${attempt}` },
          { role: "user", content: `ASK-MARK-310-${attempt}` },
        ],
      }),
      tail: "",
      headBytes: 1,
      tailBytes: 0,
      totalBytes: 1,
      truncated: false,
    },
    resBody: null,
  });

  it("整棵树标注该步变更（旧→新）；该步请求取自流量日志（挑中该步那条）+ 可跳流量页", async () => {
    const { pid, uri } = await emptyAndWrite("treediff", [
      entry({}),
      entry({
        seq: 1,
        type: "changed",
        ts: "2026-10-15T00:00:15.000Z",
        ref: { turnId: "t-b", stepId: "t-b_s2", step: 2 },
        data: { changes: [{ type: "update", path: "task.title", data: { before: "一", after: "二" } }] },
      }),
    ]);
    const netDir = join(fx.HOME, "log", "network");
    mkdirSync(netDir, { recursive: true });
    writeFileSync(
      join(netDir, "2026-10-15.jsonl"),
      [rec(Date.parse("2026-10-15T00:00:10.000Z"), 1, uri), rec(Date.parse("2026-10-15T00:00:20.000Z"), 2, uri)]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );

    await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
    await fx.sh.getJson(`./diy.sh ui tab open ctxlab:${uri}`);
    await fold("vardiff", true);
    await fold("stepsess", true);

    const s = await waitUntil(
      a11yText,
      (x) =>
        x.includes("变量树变更（整棵树 + 标注）") &&
        x.includes("该步实际请求（真发 · 流量）") &&
        x.includes("SYS-MARK-310-2"),
      { label: "变量树变更 + 该步实际请求上屏" },
    );
    // 变量树：整棵树都列出来，命中的节点标出来并带旧→新
    expect(s).toContain("第 2 步 · 1 处变更");
    // 该行：徽章 ~ / 当前值 / **旧 → 新**。✅ a11y 文本按 text node 分行，故格子里的三段各占一行
    //   （写成 `toContain("一 → 二")` 会假失败 —— 那三种东西从来不在同一个 text node 里）
    expect(rowCells(s, "task.title", "变量树变更（整棵树 + 标注）", 5).slice(-3)).toEqual(["一", "→", "二"]);
    // 该步请求取的是**第 2 步**那条（时刻判据），不是第 1 步那条
    expect(s).toContain("ASK-MARK-310-2");
    expect(s).not.toContain("ASK-MARK-310-1");
    expect(s).toContain("在流量页打开");

    // 点「在流量页打开」→ 真跳到**导航栏「流量」页**并定位到那条请求。
    // ⚠️ ##351 之后流量页走 ViewGrid（左列表 / 右详情两块 viewset），**不再是抽屉形态** ⇒
    //    旧的「← 列表」返回键已不存在；判据改成：页面出现（页头副标题只此一处）+ 详情已选中该条
    //    （`trace_id tr-2` 只在详情里出现 —— 列表不显示 traceId）。
    //    ⚠️ 耗时文本是 `{(ms/1000).toFixed(2)}s`（数字与 `s` 是两个 text node）⇒ a11y 里是 `0.22 s`（带空格）。
    const ui = await makeUiDriver(fx.electron.cdpUrl, async () => {
      const r = await fx.sh.getJson("./diy.sh ui inspect");
      return (r.data as any)?.data?.tree as A11yNode | undefined;
    });
    try {
      await ui.click("在流量页打开");
      const traffic = await waitUntil(
        a11yText,
        (x) =>
          x.includes("跨会话查看应用发出的全部 HTTP 请求 / 响应") &&
          x.includes("tr-2") &&
          x.includes("0.22 s"),
        { label: "流量页定位到该步请求" },
      );
      // `tr-2` = 详情已选中第 2 步那条（列表不显示 traceId）；耗时再钉一次"不是第 1 步那条"
      expect(traffic).toContain("tr-2");
      expect(traffic).toContain("0.22 s");
    } finally {
      ui.close();
    }
    rmSync(join(netDir, "2026-10-15.jsonl"), { force: true });
    clearLocal(uri);
    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 180_000);

  it("该步在流量日志里没有记录 → 明确提示（不编）", async () => {
    const { pid, uri } = await emptyAndWrite("treediff-miss", [
      entry({}),
      entry({
        seq: 1,
        type: "changed",
        ts: "2026-10-15T00:00:05.000Z",
        ref: { turnId: "t-nope", stepId: "t-nope_s1", step: 1 },
        data: { changes: [{ type: "update", path: "task.body", data: { before: "一", after: "二" } }] },
      }),
    ]);
    try {
      await fx.sh.getJson(`./diy.sh ui tab open ${uri}`);
      await fx.sh.getJson(`./diy.sh ui tab open ctxlab:${uri}`);
      await fold("vardiff", true);
      await fold("stepsess", true);
      const s = await waitUntil(a11yText, (x) => x.includes("未找到该步的实际请求"), {
        label: "该步无流量记录 → 提示",
      });
      // 表头步数跟着**该条记录**（不再是"轮序"）：这条是第 1 步 · 1 处变更
      expect(s).toContain("第 1 步 · 1 处变更");
      expect(s).toContain("可能的原因");
      // 变量树仍然有内容（整棵树 + 标注），不是空白页
      expect(rowCells(s, "task.body", "变量树变更（整棵树 + 标注）", 5).slice(-3)).toEqual(["一", "→", "二"]);
    } finally {
      clearLocal(uri);
      await fx.sh.run(`./diy.sh project remove ${pid}`);
    }
  }, 180_000);
});
