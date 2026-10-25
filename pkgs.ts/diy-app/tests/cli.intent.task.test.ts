// tests/cli.intent.task.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 task CLI 意图测试 — 自包含用例（JSON 模式）
//
// 原则：每个 it 自建一个专属 project（唯一路径），在其下做任务操作，
//   断言只看自己那一条数据，末尾 project remove 连同任务清理。
//   共享的只有 Electron 基础设施，共享的数据为零。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";

interface ElectronFixture {
  sh: ShellTest;
  HOME: string;
  electron: ElectronTest;
}

let fx: ElectronFixture;

/** 仓库根（diy.sh 所在）。会话 cwd 是它，但下面有用例要 cd 到别处，故留一份绝对路径。 */
const REPO_ROOT = join(__dirname, "..", "..", "..");

/** 在**指定目录**下跑 diy 子命令并取 JSON（归属用例需要把 cwd 放到别处）。
 *  不能用 `fx.sh.getJson`：它把 `--json` 拼在整行末尾，`(cd x && …)` 这种写法会变成语法错。 */
async function jsonIn(dir: string, args: string): Promise<any> {
  const r = await fx.sh.run(`cd ${dir} && ${REPO_ROOT}/diy.sh ${args} --json`);
  await fx.sh.run(`cd ${REPO_ROOT}`); // 会话 cwd 复位（上面那条会把它留在 dir）
  if (r.code !== 0) throw new Error(`[jsonIn ${dir}: ${args}] exit=${r.code}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

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

// ── 每个用例的工具：建一个专属 project，任务在其下自建自删 ──

/** 建专属 project，返回系统自动生成的 id */
async function freshProj(name: string): Promise<string> {
  const repo = `${fx.HOME}/t-${name}`;
  const res = await fx.sh.getJson(`./diy.sh project create ${repo}`);
  return String((res.data as any)?.data?.id);
}

/** 清理：删 project 连带其全部任务 */
/** 建一个**指定目录**的 project（可带 label），返回 id —— 归属用例需要知道 path。 */
async function projAt(path: string, label?: string): Promise<string> {
  const res = await fx.sh.getJson(`./diy.sh project create ${path}${label ? ` -l ${label}` : ""}`);
  return String((res.data as any)?.data?.id);
}

async function cleanupProj(id: string): Promise<void> {
  await fx.sh.run(`./diy.sh project remove ${id}`);
}

describe("task", () => {
  it("create — 建任务，uri = projects/<pid>/tasks/<tid>（项目内自增从 1 起）", async () => {
    const pid = await freshProj("a");
    const res = await fx.sh.getJson(`./diy.sh task create 研究一下 ${pid}`);
    expect(String((res.data as any)?.data?.uri)).toBe(`projects/${pid}/tasks/1`);
    await cleanupProj(pid);
  });

  it("create — 子任务挂在父任务下（同一项目内）", async () => {
    const pid = await freshProj("b");
    await fx.sh.run(`./diy.sh task create 父任务 ${pid}`);
    const parent = `projects/${pid}/tasks/1`;

    await fx.sh.assertJson(`./diy.sh task create 子任务 ${pid} --parent ${parent} --body 内容`, {
      ok: true,
      data: { status: "ok", data: { uri: `projects/${pid}/tasks/2` } },
    });
    await cleanupProj(pid);
  });

  it("show — 详情含 title/state/project（project 由 URI 路径推导）", async () => {
    const pid = await freshProj("c");
    await fx.sh.run(`./diy.sh task create 看详情 ${pid}`);
    const uri = `projects/${pid}/tasks/1`;

    await fx.sh.assertJson(`./diy.sh task show ${uri}`, {
      ok: true,
      data: {
        status: "ok",
        data: {
          uri,
          title: "看详情",
          state: "pending",
          project: pid,
          created: "*",
          updated: "*",
          body: "",
        },
      },
    });
    await cleanupProj(pid);
  });

  it("edit — 改标题后 show 反映变更", async () => {
    const pid = await freshProj("d");
    await fx.sh.run(`./diy.sh task create 原标题 ${pid}`);
    const uri = `projects/${pid}/tasks/1`;

    await fx.sh.assertJson(`./diy.sh task edit ${uri} --title 新标题`, {
      ok: true,
      data: { status: "ok", data: { uri } },
    });
    await fx.sh.assertJson(`./diy.sh task show ${uri}`, {
      ok: true,
      data: { status: "ok", data: { uri, title: "新标题", state: "pending", project: pid } },
    });
    await cleanupProj(pid);
  });

  it("move — 改变父级后树反映新层级（移动已挂在父子关系下的任务）", async () => {
    const pid = await freshProj("m1");
    await fx.sh.run(`./diy.sh task create 祖父 ${pid}`);
    const grand = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 父 ${pid} --parent ${grand}`);
    const parent = `projects/${pid}/tasks/2`;
    await fx.sh.run(`./diy.sh task create 子 ${pid} --parent ${parent}`);
    const child = `projects/${pid}/tasks/3`;

    // 把「父」从「祖父」移到「子」下 → 会形成环，move 应拒绝（CLI 抛错走 stderr）
    await fx.sh.assertSession(`
      $! ./diy.sh task move ${parent} ${child}
      *不能设置自己的子任务为父级*
    `);
    // 把「子」从「父」移到「祖父」下 → 合法，子变父的兄弟
    await fx.sh.assertJson(`./diy.sh task move ${child} ${grand}`, {
      ok: true,
      data: { status: "ok", data: { uri: child } },
    });
    // 移动后 show 反映新父级（chip 挂到祖父下）
    await fx.sh.assertJson(`./diy.sh task show ${child}`, {
      ok: true,
      data: { status: "ok", data: { uri: child, title: "子", state: "pending", project: pid, parent: grand } },
    });
    await cleanupProj(pid);
  });

  it("move — 取消父子关系（空 target）提升为顶级", async () => {
    const pid = await freshProj("m2");
    await fx.sh.run(`./diy.sh task create 根 ${pid}`);
    const root = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 子 ${pid} --parent ${root}`);
    const child = `projects/${pid}/tasks/2`;

    // 用空字符串 target 取消父子
    await fx.sh.assertJson(`./diy.sh task move ${child} ''`, {
      ok: true,
      data: { status: "ok", data: { uri: child } },
    });
    // 取消后 show 不再含 parent 字段（提升为顶级）
    await fx.sh.assertJson(`./diy.sh task show ${child}`, {
      ok: true,
      data: { status: "ok", data: { uri: child, title: "子", state: "pending", project: pid, body: "" } },
    });
    await cleanupProj(pid);
  });

  it("move — 目标不存在/跨项目/自环均拒绝", async () => {
    const pid = await freshProj("m3");
    await fx.sh.run(`./diy.sh task create 任务 ${pid}`);
    const uri = `projects/${pid}/tasks/1`;

    await fx.sh.assertSession(`
      $! ./diy.sh task move ${uri} projects/${pid}/tasks/999
      *父任务 projects/${pid}/tasks/999 不存在*
    `);
    const cpi = await freshProj("m4");
    await fx.sh.assertSession(`
      $! ./diy.sh task move ${uri} projects/${cpi}/tasks/1
      *只能在同一项目内设置父子关系*
    `);
    await fx.sh.assertSession(`
      $! ./diy.sh task move ${uri} ${uri}
      *不能设置自己的子任务为父级*
    `);
    await cleanupProj(pid);
    await cleanupProj(cpi);
  });

  it("delete — 删除任务（幂等）", async () => {
    const pid = await freshProj("f");
    await fx.sh.run(`./diy.sh task create 待删 ${pid}`);
    const uri = `projects/${pid}/tasks/1`;

    await fx.sh.assertJson(`./diy.sh task delete ${uri}`, {
      ok: true,
      data: { status: "ok", data: { uri } },
    });
    await fx.sh.assertJson(`./diy.sh task delete ${uri}`, {
      ok: true,
      data: { status: "ok", data: { uri } },
    });
    await cleanupProj(pid);
  });

  it("list --project — 只列出该项目下的任务", async () => {
    const pid = await freshProj("g");
    await fx.sh.run(`./diy.sh task create 分类 ${pid}`);

    const list = await fx.sh.getJson(`./diy.sh task list --project ${pid}`);
    expect((list.data as any).data.tasks).toEqual([`projects/${pid}/tasks/1`]);

    await fx.sh.run(`./diy.sh task create 只看 ${pid}`);
    const list2 = await fx.sh.getJson(`./diy.sh task list --project ${pid}`);
    expect((list2.data as any).data.tasks).toHaveLength(2);
    await cleanupProj(pid);
  });

  it("create — 空标题报错", async () => {
    const pid = await freshProj("h");
    await fx.sh.assertSession(`
      $! ./diy.sh task create '' ${pid}
      *标题不能为空*
    `);
    await cleanupProj(pid);
  });

  it("edit — 正文过短/空串被拒绝，且原正文不被清空（防误清空）", async () => {
    const pid = await freshProj("b1");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 有正文的任务 ${pid}`);
    await fx.sh.run(`./diy.sh task edit ${uri} --body 原始正文，长度足够通过校验`);

    // 空串：正是当初误清空整篇正文的写法，必须被拒
    await fx.sh.assertSession(`
      $! ./diy.sh task edit ${uri} --body ''
      *正文至少 10 个字符*
    `);
    // 纯空白同样被拒（按 trim 后长度判定）
    await fx.sh.assertSession(`
      $! ./diy.sh task edit ${uri} --body '          '
      *正文至少 10 个字符*
    `);

    const t = await fx.sh.getJson(`./diy.sh task show ${uri}`);
    expect((t.data as any).data.body).toContain("原始正文");
    await cleanupProj(pid);
  });

  it("edit — 正文足够长时正常写入", async () => {
    const pid = await freshProj("b2");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 占位 ${pid}`);

    await fx.sh.assertJson(`./diy.sh task edit ${uri} --body 这是足够长的正文内容`, {
      ok: true,
      data: { status: "ok", data: { uri } },
    });
    const t = await fx.sh.getJson(`./diy.sh task show ${uri}`);
    expect((t.data as any).data.body).toContain("足够长的正文内容");
    await cleanupProj(pid);
  });

  it("create — 未注册的 project 报错", async () => {
    await fx.sh.assertSession(`
      $! ./diy.sh task create 任务 99999
      *project 99999 未注册*
    `);
  });

  it("show — 不存在的任务报错", async () => {
    await fx.sh.assertJson("./diy.sh task show projects/99999/tasks/1", {
      ok: true,
      data: { status: "error", msg: "任务 projects/99999/tasks/1 不存在" },
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// drafts — 未提交草稿（半编辑数据）
//
// 契约（见 src/main/core/drafts.ts 头注释）：
//   位置 任务目录 .diy/drafts.yaml（随任务目录删除）
//   语义 set 合并、""=清除该字段、清空即删文件
//   形态 带 kind/version/task/base_updated/saved meta（丢不起的数据，不静默降级）
// ═══════════════════════════════════════════════════════════════

describe("task drafts（未提交草稿）", () => {
  it("show — 无草稿时 data 为 null（不是空对象）", async () => {
    const pid = await freshProj("d1");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 草稿任务 ${pid}`);
    await fx.sh.assertJson(`./diy.sh task drafts show ${uri}`, {
      ok: true,
      data: { status: "ok", data: null },
    });
    await cleanupProj(pid);
  });

  it("getTask — 结构化字段必须回传（详情面板的数据来源，漏字段=界面显示未设置）", async () => {
    // 这条锁的是一个真实缺陷：getTask 的载荷曾由「handler 手抄字段 + output 白名单」两处维护，
    // 漏登记的字段被 RPC schema 静默 strip → renderer 拿到 undefined → 详情面板显示"未设置"，
    // 而数据其实好好的（change_type / module / priority / persona 都漏过）。
    // 契约现在单一真源（shared/task-detail.ts），本用例守它：接口回传 == 文件里的事实。
    const pid = await freshProj("gt");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 契约任务 ${pid}`);
    // 人物引用存 **id**（名字只是标签，改名不该打断引用）：先建人物拿 id，再换绑
    const pr = await fx.sh.getJson(`./diy.sh agent persona set --name 契约人物 --model mimo-v2.6-flash`);
    const personaId = String((pr.data as any)?.id);
    await fx.sh.run(`./diy.sh task edit ${uri} --persona ${personaId}`);

    const r = await fx.sh.getJson(`./diy.sh getTask ${uri}`);
    const d = (r.data as any)?.data;
    // 契约里的每个字段都要真的回传（而不是被 RPC schema 静默 strip）
    expect(d.uri).toBe(uri);
    expect(d.title).toBe("契约任务");
    expect(d.state).toBe("pending");
    expect(d.persona).toBe(personaId); // 换绑后立即生效（下一轮用它的模型）
    expect(d.ui_drafts).toBeNull(); // 草稿字段也在契约里（无草稿 = null）
    await cleanupProj(pid);
  });

  it("getTask — 未找到时 data 为 null（renderer 的守卫靠它）", async () => {
    const r = await fx.sh.getJson(`./diy.sh getTask projects/999999/tasks/1`);
    expect((r.data as any)?.data).toBeNull();
  });

  it("set → show — 草稿写盘并可读回；task show 一并带回 ui_drafts", async () => {
    const pid = await freshProj("d2");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 草稿任务 ${pid}`);
    await fx.sh.run(`./diy.sh task drafts set ${uri} --title 半编辑标题 --agent_input 打到一半的话`);

    const d = await fx.sh.getJson(`./diy.sh task drafts show ${uri}`);
    const data = (d.data as any).data;
    expect(data.fields.title).toBe("半编辑标题");
    expect(data.fields.agent_input).toBe("打到一半的话");

    // task show 必须同契约回填（renderer 只调 getTask 拿任务）
    const t = await fx.sh.getJson(`./diy.sh task show ${uri}`);
    expect((t.data as any).data.ui_drafts.fields.agent_input).toBe("打到一半的话");
    await cleanupProj(pid);
  });

  it("set 合并语义 — 后写字段不冲掉先前字段", async () => {
    const pid = await freshProj("d3");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 草稿任务 ${pid}`);
    await fx.sh.run(`./diy.sh task drafts set ${uri} --title T`);
    await fx.sh.run(`./diy.sh task drafts set ${uri} --body B`);

    const d = await fx.sh.getJson(`./diy.sh task drafts show ${uri}`);
    const fields = (d.data as any).data.fields;
    expect(fields).toEqual({ title: "T", body: "B" });
    await cleanupProj(pid);
  });

  it("set 空串 — 清除该字段，其余留存", async () => {
    const pid = await freshProj("d4");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 草稿任务 ${pid}`);
    await fx.sh.run(`./diy.sh task drafts set ${uri} --title T --body B`);
    await fx.sh.run(`./diy.sh task drafts set ${uri} --title ''`);

    const d = await fx.sh.getJson(`./diy.sh task drafts show ${uri}`);
    const fields = (d.data as any).data.fields;
    expect(fields.title).toBeUndefined();
    expect(fields.body).toBe("B");
    await cleanupProj(pid);
  });

  it("clear — 清空后 show 回 null（文件已删，不留空壳）", async () => {
    const pid = await freshProj("d5");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 草稿任务 ${pid}`);
    await fx.sh.run(`./diy.sh task drafts set ${uri} --title T`);
    await fx.sh.run(`./diy.sh task drafts clear ${uri}`);

    await fx.sh.assertJson(`./diy.sh task drafts show ${uri}`, {
      ok: true,
      data: { status: "ok", data: null },
    });
    await cleanupProj(pid);
  });

  it("clear --fields — 只清指定字段", async () => {
    const pid = await freshProj("d6");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 草稿任务 ${pid}`);
    await fx.sh.run(`./diy.sh task drafts set ${uri} --title T --agent_input A`);
    // CLI 数组统一是 JSON 形式（parser 只对 ZodArray 做 JSON.parse）
    await fx.sh.assertJson(`./diy.sh task drafts clear ${uri} --fields '["title"]'`, {
      ok: true,
      data: { status: "ok" },
    });

    const d = await fx.sh.getJson(`./diy.sh task drafts show ${uri}`);
    const fields = (d.data as any).data.fields;
    expect(fields.title).toBeUndefined();
    expect(fields.agent_input).toBe("A");
    await cleanupProj(pid);
  });

  it("生命周期 — 删任务后草稿随之消失（草稿在任务目录 .diy/ 内）", async () => {
    const pid = await freshProj("d7");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 草稿任务 ${pid}`);
    await fx.sh.run(`./diy.sh task drafts set ${uri} --title T`);
    // 草稿确实落在任务目录内（而非别处），才能随 rmSync 一起消失
    expect(existsSync(join(fx.HOME, uri, ".diy", "drafts.yaml"))).toBe(true);

    await fx.sh.run(`./diy.sh task delete ${uri}`);
    expect(existsSync(join(fx.HOME, uri, ".diy", "drafts.yaml"))).toBe(false);
    await cleanupProj(pid);
  });

  it("草稿不影响任务树扫描（.diy/ 不被误认为任务）", async () => {
    const pid = await freshProj("d8");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 草稿任务 ${pid}`);
    await fx.sh.run(`./diy.sh task drafts set ${uri} --title T`);

    const list = await fx.sh.getJson(`./diy.sh task list -p ${pid}`);
    expect((list.data as any).data.tasks).toEqual([uri]);
    await cleanupProj(pid);
  });
});
// ═══════════════════════════════════════════════════════════════
// 正文写侧对称（##322）：整份文件剥头 / 追加原语
//
//   意图：agent 追加任务正文**不必先读文件**，把整份文件当输入也**不会写出第二个头**。
//   复现写法就是 `--body "$(cat AGENTS.md)"` —— 旧实现在正文里复制出一个 frontmatter。
// ═══════════════════════════════════════════════════════════════

describe("task 正文写侧对称（##322）", () => {
  const fpOf = (uri: string) => join(fx.HOME, uri, "AGENTS.md");
  const rawOf = (uri: string) => readFileSync(fpOf(uri), "utf-8");
  /** 正文区（头之后的部分） */
  const bodyRegion = (raw: string) => raw.slice(raw.indexOf("---", 3) + 3);
  /** `---` 独占行数：规范任务文件 = 2（双头就是 4） */
  const seps = (raw: string) => raw.split("\n").filter((l) => l.trim() === "---").length;

  it("读-写往返 byte-exact：show 的 body 写回 → 正文区逐字不变、头仍只有一个", async () => {
    const pid = await freshProj("rt");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 往返 ${pid} --body 第一段正文够长通过校验`);
    const before = bodyRegion(rawOf(uri));

    const body = ((await fx.sh.getJson(`./diy.sh task show ${uri}`)).data as any).data.body;
    expect(body).toBe("第一段正文够长通过校验");

    await fx.sh.run(`./diy.sh task edit ${uri} --body '${body}'`);

    expect(bodyRegion(rawOf(uri))).toBe(before);
    expect(seps(rawOf(uri))).toBe(2);
    await cleanupProj(pid);
  });

  it('--body "$(cat AGENTS.md)"（整份文件）不再产生双头，剥离结果如实回报', async () => {
    const pid = await freshProj("whole");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 整份 ${pid} --body 原始正文够长通过校验`);
    const before = bodyRegion(rawOf(uri));

    const r = await fx.sh.getJson(`./diy.sh task edit ${uri} --body "$(cat ${fpOf(uri)})"`);
    const d = (r.data as any).data;

    expect(d.uri).toBe(uri);
    expect(d.body_head_stripped.keys).toContain("title");
    expect(d.body_head_stripped.differs).toEqual([]); // 头来自同一份文件 → 无差异
    expect(d.body_head_stripped.head_text).toContain("title: 整份"); // 剥掉的原文也回报（丢了什么看得见）
    expect(seps(rawOf(uri))).toBe(2); // 仍只有一个头
    expect(bodyRegion(rawOf(uri))).toBe(before); // 正文没被头污染
    await cleanupProj(pid);
  });

  it("整份文件 + 空正文 → 被拒（剥离后才校验长度，不能靠头蒙混过关）", async () => {
    const pid = await freshProj("empty");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 空正文 ${pid}`);

    await fx.sh.assertSession(`
      $! ./diy.sh task edit ${uri} --body "$(cat ${fpOf(uri)})"
      *正文至少 10 个字符*
    `);
    await cleanupProj(pid);
  });

  it("--append-body <file> 追加正文（不必先读任务文件）", async () => {
    const pid = await freshProj("app");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 追加 ${pid} --body 第一段够长通过校验`);
    const chunk = join(fx.HOME, "chunk.md");
    writeFileSync(chunk, "第二段：追加进来的内容\n", "utf-8");

    const r = await fx.sh.getJson(`./diy.sh task edit ${uri} --append-body ${chunk}`);
    const d = (r.data as any).data;
    expect(d.uri).toBe(uri);
    expect(d.appended_chars).toBeGreaterThan(0);

    const t = await fx.sh.getJson(`./diy.sh task show ${uri}`);
    expect((t.data as any).data.body).toBe("第一段够长通过校验\n\n第二段：追加进来的内容");
    expect(seps(rawOf(uri))).toBe(2);
    await cleanupProj(pid);
  });

  it("--append-body - 从 stdin 追加（管道即可，不必落盘）", async () => {
    const pid = await freshProj("stdin");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 管道 ${pid} --body 原文够长通过校验`);

    await fx.sh.run(`printf '从管道追加的一段' | ./diy.sh task edit ${uri} --append-body -`);

    const t = await fx.sh.getJson(`./diy.sh task show ${uri}`);
    expect((t.data as any).data.body).toBe("原文够长通过校验\n\n从管道追加的一段");
    await cleanupProj(pid);
  });

  it("空 stdin 追加 → 报错（不静默写个空段落）", async () => {
    const pid = await freshProj("emptyadd");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 空追加 ${pid} --body 原文够长通过校验`);

    await fx.sh.assertSession(`
      $! printf '' | ./diy.sh task edit ${uri} --append-body -
      *追加内容为空*
    `);
    const t = await fx.sh.getJson(`./diy.sh task show ${uri}`);
    expect((t.data as any).data.body).toBe("原文够长通过校验");
    await cleanupProj(pid);
  });

  it("读侧显式给头：task show 带 frontmatter（含自定义键）", async () => {
    const pid = await freshProj("head");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 头 ${pid} --change_type fix --priority P1`);
    writeFileSync(
      fpOf(uri),
      rawOf(uri).replace("state: pending", "state: pending\nnote: '自定义备注'"),
      "utf-8",
    );

    const r = await fx.sh.getJson(`./diy.sh task show ${uri}`);
    const d = (r.data as any).data;
    expect(d.frontmatter.title).toBe("头");
    expect(d.frontmatter.change_type).toBe("fix");
    expect(d.frontmatter.note).toBe("自定义备注");
    await cleanupProj(pid);
  });

  // ── 追加的判据比 `--body` 更严（##322 review R1）──
  // 追加一份"带 YAML front matter 的文档"是常态；只认已知头键会把文档的 `title:` 当成任务头吞掉。

  it("--append-body <带 front matter 的文档> → 文档头原样保留（不静默吞内容）", async () => {
    const pid = await freshProj("doc");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 文档 ${pid} --body 原始正文够长通过校验`);
    const doc = join(fx.HOME, "doc.md");
    writeFileSync(doc, "---\ntitle: 练习册答案\nnote: 手写文档\n---\n\n# 正文\n\n1. 答案 A\n", "utf-8");

    const r = await fx.sh.getJson(`./diy.sh task edit ${uri} --append-body ${doc}`);
    const d = (r.data as any).data;

    expect(d.append_head_stripped).toBeUndefined(); // 没剥头
    const t = await fx.sh.getJson(`./diy.sh task show ${uri}`);
    const body = (t.data as any).data.body;
    expect(body).toContain("title: 练习册答案");
    expect(body).toContain("note: 手写文档");
    expect(body).toContain("# 正文");
    await cleanupProj(pid);
  });

  it("--append-body <整份任务文件> → 剥头取正文（追加也不会写出第二个头）", async () => {
    const pid = await freshProj("appwhole");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 追加整份 ${pid} --body 原文够长通过校验`);
    const other = `projects/${pid}/tasks/2`;
    await fx.sh.run(`./diy.sh task create 别处 ${pid} --body 别处的正文`);

    const r = await fx.sh.getJson(`./diy.sh task edit ${uri} --append-body ${fpOf(other)}`);
    const d = (r.data as any).data;

    expect(d.append_head_stripped.keys).toContain("title"); // 认出来了（有 state/created）
    expect(seps(rawOf(uri))).toBe(2);
    const t = await fx.sh.getJson(`./diy.sh task show ${uri}`);
    expect((t.data as any).data.body).toBe("原文够长通过校验\n\n别处的正文");
    await cleanupProj(pid);
  });
});

// ═══════════════════════════════════════════════════════════════
// 正文输入契约（##338）：`--body` 只收**内联正文**，传文本 / 传文件分家
//
//   现场写法就是 `diy task edit <uri> --body /tmp/x.md`（本意"传这个文件"）——
//   旧实现把路径串当正文**静默存下**，原正文丢失且无任何告警（##290 / ##294 / ##87 三例）。
//   契约：`--body` < `--body-text` < `--body-file <file|->`；整篇覆盖三选一、追加三选一。
// ═══════════════════════════════════════════════════════════════

describe("task 正文输入契约（##338）", () => {
  const bodyOf = async (uri: string): Promise<string> =>
    (((await fx.sh.getJson(`./diy.sh task show ${uri}`)).data as any).data.body as string);

  /** 一份真实存在的正文文件（写到 HOME 下，避免污染仓库） */
  const bodyFile = (name: string, text: string): string => {
    const f = join(fx.HOME, name);
    writeFileSync(f, text, "utf-8");
    return f;
  };

  it("--body <存在的文件路径> → 报错并提示 --body-file（原正文不被路径串顶掉）", async () => {
    const pid = await freshProj("g1");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 护栏 ${pid} --body 原始正文够长通过校验`);
    const f = bodyFile("g1-body.md", "文件里的新正文，长度足够\n");

    await fx.sh.assertSession(`
      $! ./diy.sh task edit ${uri} --body ${f}
      ---
      *内联正文*
      *--body-file*
    `);
    expect(await bodyOf(uri)).toBe("原始正文够长通过校验");
    await cleanupProj(pid);
  });

  it("--body <不存在的路径形态> → 同样报错（形态可疑就出声，不靠「文件在不在」）", async () => {
    const pid = await freshProj("g2");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 护栏2 ${pid} --body 原始正文够长通过校验`);

    await fx.sh.assertSession(`
      $! ./diy.sh task edit ${uri} --body ${fx.HOME}/t338-不存在.md
      ---
      *该路径不存在*
    `);
    expect(await bodyOf(uri)).toBe("原始正文够长通过校验");
    await cleanupProj(pid);
  });

  it("--body 收「含空白的单行」与「多行」照常写入（护栏只认整体是一个路径 token）", async () => {
    const pid = await freshProj("g3");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 边界 ${pid}`);

    // 路径出现在句子里（含空白）→ 是正文，不是路径
    await fx.sh.run(`./diy.sh task edit ${uri} --body '见 /tmp/t338-nope.md 一节'`);
    expect(await bodyOf(uri)).toBe("见 /tmp/t338-nope.md 一节");

    // 多行正文的第一行恰好是路径 → 整体不是单 token，放行
    await fx.sh.run(`./diy.sh task edit ${uri} --body "$(printf '/tmp/t338-nope.md\\n第二行正文')"`);
    expect(await bodyOf(uri)).toBe("/tmp/t338-nope.md\n第二行正文");
    await cleanupProj(pid);
  });

  it("--body-text <路径串> → 照写（显式文本不受护栏；正文本身就是一行路径时用它）", async () => {
    const pid = await freshProj("g4");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 显式 ${pid}`);
    const f = bodyFile("g4-body.md", "文件里的正文\n");

    await fx.sh.run(`./diy.sh task edit ${uri} --body-text ${f}`);
    expect(await bodyOf(uri)).toBe(f); // 路径串就是正文（这次是**故意**的）
    await cleanupProj(pid);
  });

  it("--body-file <file> 整篇覆盖；--body-file - 读 stdin", async () => {
    const pid = await freshProj("g5");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 文件 ${pid}`);
    const f = bodyFile("g5-body.md", "来自文件的新正文，长度足够\n");

    const r = await fx.sh.getJson(`./diy.sh task edit ${uri} --body-file ${f}`);
    expect((r.data as any).data.uri).toBe(uri);
    expect(await bodyOf(uri)).toBe("来自文件的新正文，长度足够");

    const r2 = await fx.sh.run(`printf '来自标准输入的正文内容' | ./diy.sh task edit ${uri} --body-file -`);
    expect(r2.stderr).toBe("");
    expect(r2.code).toBe(0);
    expect(await bodyOf(uri)).toBe("来自标准输入的正文内容");
    await cleanupProj(pid);
  });

  it('--body-file <整份任务文件> → 与 --body "$(cat f)" 同效：剥头取正文', async () => {
    const pid = await freshProj("g6");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 整份 ${pid} --body 原始正文够长通过校验`);
    const other = `projects/${pid}/tasks/2`;
    await fx.sh.run(`./diy.sh task create 别处 ${pid} --body 别处的正文内容够长通过校验`);

    const r = await fx.sh.getJson(`./diy.sh task edit ${uri} --body-file ${join(fx.HOME, other, "AGENTS.md")}`);
    const d = (r.data as any).data;
    expect(d.body_head_stripped.keys).toContain("title");
    expect(await bodyOf(uri)).toBe("别处的正文内容够长通过校验");
    await cleanupProj(pid);
  });

  it("三选一：整篇覆盖 / 追加 各给多个 → 报错（不猜、不按顺序取）", async () => {
    const pid = await freshProj("g7");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 冲突 ${pid} --body 原始正文够长通过校验`);
    const f = bodyFile("g7-body.md", "文件正文够长\n");

    await fx.sh.assertSession(`
      $! ./diy.sh task edit ${uri} --body '内联正文够长够长' --body-file ${f}
      ---
      *三选一*
    `);
    await fx.sh.assertSession(`
      $! ./diy.sh task edit ${uri} --append-body-text 内联追加 --append-body ${f}
      ---
      *三选一*
    `);
    expect(await bodyOf(uri)).toBe("原始正文够长通过校验");
    await cleanupProj(pid);
  });

  it("追加的对称三态：--append-body-text 内联追加、--append-body-file 同 --append-body", async () => {
    const pid = await freshProj("g8");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 追加 ${pid} --body 第一段够长通过校验`);
    const f = bodyFile("g8-chunk.md", "第三段：来自文件\n");

    await fx.sh.run(`./diy.sh task edit ${uri} --append-body-text 第二段：直接内联`);
    expect(await bodyOf(uri)).toBe("第一段够长通过校验\n\n第二段：直接内联");

    await fx.sh.run(`./diy.sh task edit ${uri} --append-body-file ${f}`);
    expect(await bodyOf(uri)).toBe("第一段够长通过校验\n\n第二段：直接内联\n\n第三段：来自文件");
    await cleanupProj(pid);
  });

  it("task edit --help 写明正文输入契约（三种入参 + 护栏）", async () => {
    const h = await fx.sh.run(`./diy.sh task edit --help`);
    expect(h.code).toBe(0);
    for (const opt of ["--body-file", "--body-text", "--append-body-file", "--append-body-text"]) {
      expect(h.stdout).toContain(opt);
    }
    expect(h.stdout).toContain("内联正文");
  });
});

// ═══════════════════════════════════════════════════════════════
// 正文护栏的同族补齐（##376）：`task create --body` / `task drafts set --body`
//
//   ##338 只把 `inlineText` 护栏挂在 `task edit --body` 上；同族两条命令（同为"收内联文本"）
//   没跟上 —— 护栏 meta 与裁决点都现成，只是没挂。破坏性低一档（新建 / 草稿可重写），
//   但"静默把路径串当正文存下"这个坑一样会踩（尤其 agent 调用侧）。
// ═══════════════════════════════════════════════════════════════

describe("task create / drafts set 正文护栏（##376）", () => {
  const bodyOf = async (uri: string): Promise<string> =>
    (((await fx.sh.getJson(`./diy.sh task show ${uri}`)).data as any).data.body as string);

  /** 草稿里的正文草稿值（无草稿 / 无该字段 → undefined） */
  const draftBody = async (uri: string): Promise<string | undefined> => {
    const r = await fx.sh.getJson(`./diy.sh task drafts show ${uri}`);
    return (r.data as any).data?.fields?.body;
  };

  /** 真实存在的正文文件（写到 HOME 下，避免污染仓库） */
  const bodyFile = (name: string, text: string): string => {
    const f = join(fx.HOME, name);
    writeFileSync(f, text, "utf-8");
    return f;
  };

  const taskUris = async (pid: string): Promise<string[]> =>
    ((await fx.sh.getJson(`./diy.sh task list --project ${pid}`)).data as any).data.tasks as string[];

  it("create --body <存在的文件路径> → 拒 + 提示 --body-file，且**任务没被建出来**", async () => {
    const pid = await freshProj("c1");
    const f = bodyFile("c1-body.md", "文件里的任务内容\n");

    await fx.sh.assertSession(`
      $! ./diy.sh task create 护栏 ${pid} --body ${f}
      ---
      *内联正文*
      *--body-file*
    `);
    // 拒在**解析期**（调用方进程 parser）→ 请求根本没发出去，不留半个空任务
    expect(await taskUris(pid)).toEqual([]);
    await cleanupProj(pid);
  });

  it("create --body <不存在的路径形态> → 同样拒（形态可疑就出声，不靠「文件在不在」）", async () => {
    const pid = await freshProj("c2");

    await fx.sh.assertSession(`
      $! ./diy.sh task create 护栏2 ${pid} --body ${fx.HOME}/c376-不存在.md
      ---
      *该路径不存在*
    `);
    expect(await taskUris(pid)).toEqual([]);
    await cleanupProj(pid);
  });

  it("create 护栏命中时 exit=2 且打印该命令 help（拒 + 说清正确写法）", async () => {
    const pid = await freshProj("c3");
    const f = bodyFile("c3-body.md", "文件内容\n");

    const r = await fx.sh.run(`./diy.sh task create 护栏3 ${pid} --body ${f}`);
    expect(r.code).toBe(2); // 用法错误（CLIG）：exit 2，不是 1
    expect(r.stderr).toContain("--body-file");
    expect(r.stderr).toContain("--body-text");
    // 只在 help 里出现的选项 ⇒ 证明确实印了 help（护栏要求：拒 + 提示 + 打印 help）
    expect(r.stderr).toContain("--persona"); // 只在 help 的 Options 里出现
    expect(r.stderr).toContain("--module");
    await cleanupProj(pid);
  });

  it("create 逃生口对称：--body 含空白/多行照收 · --body-text 收路径串 · --body-file <file|-> ", async () => {
    const pid = await freshProj("c4");

    // 路径出现在句子里（含空白）→ 是正文，不是路径
    const r1 = await fx.sh.getJson(`./diy.sh task create 边界 ${pid} --body '见 /tmp/c376-nope.md 一节'`);
    expect(await bodyOf(String((r1.data as any).data.uri))).toBe("见 /tmp/c376-nope.md 一节");

    // 多行正文的第一行恰好是路径 → 整体不是单 token，放行
    const r2 = await fx.sh.getJson(`./diy.sh task create 多行 ${pid} --body "$(printf '/tmp/c376-nope.md\\n第二行正文')"`);
    expect(await bodyOf(String((r2.data as any).data.uri))).toBe("/tmp/c376-nope.md\n第二行正文");

    // --body-text <路径串> → 照写（显式文本不受护栏；正文本身就是一行路径时用它）
    const f = bodyFile("c4-body.md", "文件内容\n");
    const r3 = await fx.sh.getJson(`./diy.sh task create 显式 ${pid} --body-text ${f}`);
    expect(await bodyOf(String((r3.data as any).data.uri))).toBe(f);

    // --body-file <file> / <-（stdin）：内容当正文
    const r4 = await fx.sh.getJson(`./diy.sh task create 文件 ${pid} --body-file ${f}`);
    expect(await bodyOf(String((r4.data as any).data.uri))).toBe("文件内容");

    const r5 = await fx.sh.run(`printf '来自标准输入的任务内容' | ./diy.sh task create 标准输入 ${pid} --body-file -`);
    expect(r5.stderr).toBe("");
    expect(r5.code).toBe(0);
    expect(await bodyOf(`projects/${pid}/tasks/5`)).toBe("来自标准输入的任务内容");
    await cleanupProj(pid);
  });

  it("create 三选一：--body 与 --body-file 同给 → 报错（不猜、不按顺序取）", async () => {
    const pid = await freshProj("c5");
    const f = bodyFile("c5-body.md", "文件内容\n");

    await fx.sh.assertSession(`
      $! ./diy.sh task create 冲突 ${pid} --body '内联正文够长够长' --body-file ${f}
      ---
      *三选一*
    `);
    expect(await taskUris(pid)).toEqual([]);
    await cleanupProj(pid);
  });

  it("drafts set --body <文件路径> → 拒，原草稿不被路径串顶掉", async () => {
    const pid = await freshProj("c6");
    await fx.sh.run(`./diy.sh task create 草稿 ${pid}`);
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task drafts set ${uri} --body 原草稿内容`);
    const f = bodyFile("c6-draft.md", "文件里的草稿内容\n");

    await fx.sh.assertSession(`
      $! ./diy.sh task drafts set ${uri} --body ${f}
      ---
      *内联正文*
      *--body-file*
    `);
    expect(await draftBody(uri)).toBe("原草稿内容");
    await cleanupProj(pid);
  });

  it("drafts set 逃生口对称：--body-file 写入 · --body-text 收路径串 · --body '' 清除", async () => {
    const pid = await freshProj("c7");
    await fx.sh.run(`./diy.sh task create 草稿 ${pid}`);
    const uri = `projects/${pid}/tasks/1`;
    const f = bodyFile("c7-draft.md", "来自文件的草稿");

    await fx.sh.run(`./diy.sh task drafts set ${uri} --body-file ${f}`);
    expect(await draftBody(uri)).toBe("来自文件的草稿");

    await fx.sh.run(`./diy.sh task drafts set ${uri} --body-text ${f}`);
    expect(await draftBody(uri)).toBe(f); // 路径串这次是**故意**当正文

    await fx.sh.run(`./diy.sh task drafts set ${uri} --body ''`);
    expect(await draftBody(uri)).toBeUndefined(); // 空串=清除（护栏不拦空值）
    await cleanupProj(pid);
  });

  it("drafts set 三选一：--body-text 与 --body-file 同给 → 报错", async () => {
    const pid = await freshProj("c8");
    await fx.sh.run(`./diy.sh task create 草稿 ${pid}`);
    const uri = `projects/${pid}/tasks/1`;
    const f = bodyFile("c8-draft.md", "文件内容\n");

    await fx.sh.assertSession(`
      $! ./diy.sh task drafts set ${uri} --body-text 内联草稿 --body-file ${f}
      ---
      *三选一*
    `);
    expect(await draftBody(uri)).toBeUndefined();
    await cleanupProj(pid);
  });

  it("两条命令的 --help 写明正文输入契约（三种入参 + 护栏口径）", async () => {
    for (const cmd of ["task create", "task drafts set"]) {
      const h = await fx.sh.run(`./diy.sh ${cmd} --help`);
      expect(h.code).toBe(0);
      expect(h.stdout).toContain("--body-file");
      expect(h.stdout).toContain("--body-text");
      expect(h.stdout).toContain("内联正文");
    }
    // create 的 desc 还得说清"不剥头"（与 edit 的差别，免得调用方以为能传整份任务文件）
    const hc = await fx.sh.run(`./diy.sh task create --help`);
    expect(hc.stdout).toContain("剥头");
  });

  // ── 归属（##430）：创建得让人看得见"落到哪个仓"，选错要拦 ──

  it("create — 回显归属（uri + project + label + path）", async () => {
    const path = `${fx.HOME}/t-echo`;
    const pid = await projAt(path, "回声仓");

    const d = ((await fx.sh.getJson(`./diy.sh task create 回显归属 ${pid}`)).data as any).data;
    expect(d.uri).toBe(`projects/${pid}/tasks/1`);
    expect(d.project).toBe(pid);
    expect(d.label).toBe("回声仓");
    // path 存盘时已归一（home 内 → ~/…），只断言指得到那个目录
    expect(String(d.path)).toContain("t-echo");
    await cleanupProj(pid);
  });

  it("create — cwd 属于 project A 却给 project B ⇒ 拒绝（不静默落到错项目）", async () => {
    const aPath = `${fx.HOME}/t-own-a`;
    const bPath = `${fx.HOME}/t-own-b`;
    const a = await projAt(aPath);
    const b = await projAt(bPath);
    await fx.sh.run(`mkdir -p ${aPath}/sub`);

    // 在 A 的子目录（worktree 同理）里给 B 建任务 → 拦，并列出候选
    await fx.sh.assertSession(`
      $! (cd ${aPath}/sub && ${REPO_ROOT}/diy.sh task create 落错仓 ${b})
      *拒绝创建*
      *${a}*
    `);
    // 不静默创建：两边都没有任务
    expect(((await fx.sh.getJson(`./diy.sh task list -p ${b}`)).data as any).data.tasks).toEqual([]);
    expect(((await fx.sh.getJson(`./diy.sh task list -p ${a}`)).data as any).data.tasks).toEqual([]);

    // 同一个 cwd 给对的 project → 照常创建（不误拦）
    const ok = (await jsonIn(`${aPath}/sub`, `task create 落对仓 ${a}`)).data.data;
    expect(ok.uri).toBe(`projects/${a}/tasks/1`);
    await cleanupProj(a);
    await cleanupProj(b);
  });

  it("create — --force 才允许在别的项目下建任务（逃生口）", async () => {
    const aPath = `${fx.HOME}/t-force-a`;
    const bPath = `${fx.HOME}/t-force-b`;
    const a = await projAt(aPath);
    const b = await projAt(bPath);
    await fx.sh.run(`mkdir -p ${aPath}/sub`);

    const d = (await jsonIn(`${aPath}/sub`, `task create 强行越仓 ${b} --force`)).data.data;
    expect(d.uri).toBe(`projects/${b}/tasks/1`);
    await cleanupProj(a);
    await cleanupProj(b);
  });

  it("list — 多项目同号可分辨：data.projects 给出 id → label/path", async () => {
    const aPath = `${fx.HOME}/t-list-a`;
    const bPath = `${fx.HOME}/t-list-b`;
    const a = await projAt(aPath, "列表A");
    const b = await projAt(bPath, "列表B");
    await fx.sh.run(`./diy.sh task create 甲任务 ${a}`);
    await fx.sh.run(`./diy.sh task create 乙任务 ${b}`);

    const d = ((await fx.sh.getJson(`./diy.sh task list`)).data as any).data;
    // tasks 形状不变（uri 字符串数组）—— 老调用方不受影响
    expect(d.tasks).toContain(`projects/${a}/tasks/1`);
    expect(d.tasks).toContain(`projects/${b}/tasks/1`);
    // 归属表让同号任务分得清
    const byId = new Map((d.projects as any[]).map((p: any) => [p.id, p]));
    expect((byId.get(a) as any).label).toBe("列表A");
    expect(String((byId.get(b) as any).path)).toContain("t-list-b");
    await cleanupProj(a);
    await cleanupProj(b);
  });
});
