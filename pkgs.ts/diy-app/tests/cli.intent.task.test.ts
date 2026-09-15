// tests/cli.intent.task.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 task CLI 意图测试 — 自包含用例（JSON 模式）
//
// 原则：每个 it 自建一个专属 project（唯一路径），在其下做任务操作，
//   断言只看自己那一条数据，末尾 project remove 连同任务清理。
//   共享的只有 Electron 基础设施，共享的数据为零。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";

interface ElectronFixture {
  sh: ShellTest;
  HOME: string;
  electron: ElectronTest;
}

let fx: ElectronFixture;

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

    await fx.sh.assertJson(`./diy.sh task create 子任务 ${pid} --parent ${parent} --detail 详情`, {
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
    await fx.sh.run(`./diy.sh task drafts set ${uri} --detail D`);

    const d = await fx.sh.getJson(`./diy.sh task drafts show ${uri}`);
    const fields = (d.data as any).data.fields;
    expect(fields).toEqual({ title: "T", detail: "D" });
    await cleanupProj(pid);
  });

  it("set 空串 — 清除该字段，其余留存", async () => {
    const pid = await freshProj("d4");
    const uri = `projects/${pid}/tasks/1`;
    await fx.sh.run(`./diy.sh task create 草稿任务 ${pid}`);
    await fx.sh.run(`./diy.sh task drafts set ${uri} --title T --detail D`);
    await fx.sh.run(`./diy.sh task drafts set ${uri} --title ''`);

    const d = await fx.sh.getJson(`./diy.sh task drafts show ${uri}`);
    const fields = (d.data as any).data.fields;
    expect(fields.title).toBeUndefined();
    expect(fields.detail).toBe("D");
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