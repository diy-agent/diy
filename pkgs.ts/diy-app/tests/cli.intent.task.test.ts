// tests/cli.intent.task.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 task CLI 意图测试 — 自包含用例（JSON 模式）
//
// 原则：每个 it 自建一个专属 project（唯一路径），在其下做任务操作，
//   断言只看自己那一条数据，末尾 project remove 连同任务清理。
//   共享的只有 Electron 基础设施，共享的数据为零。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
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

  it("star/unstar — 关注然后取消", async () => {
    const pid = await freshProj("e");
    await fx.sh.run(`./diy.sh task create 关注 ${pid}`);
    const uri = `projects/${pid}/tasks/1`;

    await fx.sh.assertJson(`./diy.sh task star ${uri}`, {
      ok: true,
      data: { status: "ok", data: { uri, starred: true } },
    });
    await fx.sh.assertJson(`./diy.sh task unstar ${uri}`, {
      ok: true,
      data: { status: "ok", data: { uri, starred: false } },
    });
    await cleanupProj(pid);
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