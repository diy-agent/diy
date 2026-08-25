// tests/cli.intent.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 CLI 意图测试 — 契约 / 输出格式验证（JSON 模式）
//
// 规则：
//   1. CLI 通过 ./diy.sh 运行，输出 JSON（--json 模式）
//   2. 成功场景用 assertJson 断言对象结构（值支持 * glob 通配）
//   3. 失败场景用 assertSession 匹配 stderr 错误信息
//   4. 测试顺序即意图顺序 — 先建后删
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";

let sh: ShellTest;
let HOME: string;
let electron: ElectronTest;

beforeAll(async () => {
  // 启动隔离 Electron：ui.* 是 renderer 域命令，需真实 renderer 进程转发；
  // 同时所有命令走真实 main 进程，验证完整契约。
  electron = await startElectronTest();
  HOME = electron.home;
  // DIY_HOME/HOME 由 electron-test 隔离；cwd 默认仓库根（./diy.sh 靠 cwd 定位）
  sh = new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } });
});

afterAll(async () => {
  await electron?.stop();
});

// ═══════════════════════════════════════════════════════════════
// project — 先测，此时 state.yaml 尚未创建
// ═══════════════════════════════════════════════════════════════

describe("project", () => {
  it("list — 空列表", async () => {
    await sh.assertJson("./diy.sh project list", {
      ok: true,
      data: { status: "ok", data: { projects: [] } },
    });
  });

  it("create — 注册新 project", async () => {
    await sh.assertJson("./diy.sh project create work --label 工作", {
      ok: true,
      data: { status: "ok", data: { id: "work" } },
    });
  });

  it("create — 重复注册（覆盖 label）", async () => {
    await sh.assertJson("./diy.sh project create work --label 工程", {
      ok: true,
      data: { status: "ok", data: { id: "work" } },
    });
  });

  it("list — 列出已注册 project", async () => {
    await sh.assertJson("./diy.sh project list", {
      ok: true,
      data: {
        status: "ok",
        data: {
          projects: [{ id: "work", info: { label: "工程" } }],
        },
      },
    });
  });

  it("remove — 移除 project", async () => {
    await sh.assertJson("./diy.sh project remove work", {
      ok: true,
      data: { status: "ok", data: { id: "work" } },
    });
  });

  it("remove — 移除不存在的 project（幂等）", async () => {
    await sh.assertJson("./diy.sh project remove work", {
      ok: true,
      data: { status: "ok", data: { id: "work" } },
    });
  });

  it("list — 移除后为空", async () => {
    await sh.assertJson("./diy.sh project list", {
      ok: true,
      data: { status: "ok", data: { projects: [] } },
    });
  });

  it("create — 空 id 报错", async () => {
    await sh.assertSession(`
      $! ./diy.sh project create ''
      *id 不能为空*
    `);
  });
});

// ═══════════════════════════════════════════════════════════════
// task
// ═══════════════════════════════════════════════════════════════

describe("task", () => {
  beforeAll(async () => {
    await sh.diy2("project", "create", "tasks", "--label", "任务");
  });

  it("list — 空列表", async () => {
    await sh.assertJson("./diy.sh task list", {
      ok: true,
      data: { status: "ok", data: { tasks: [] } },
    });
  });

  it("create — 创建任务", async () => {
    await sh.assertJson("./diy.sh task create 研究一下 tasks", {
      ok: true,
      data: { status: "ok", data: { uri: "*" } },
    });
  });

  it("create — 创建带详情和父任务的子任务", async () => {
    const list = await sh.getJson("./diy.sh task list");
    const parentUri = (list.data as any).data.tasks[0];

    await sh.assertJson(
      "./diy.sh task create 子任务 tasks --parent ${parentUri} --detail 这是详情"
        .replace("${parentUri}", parentUri),
      {
        ok: true,
        data: { status: "ok", data: { uri: "*" } },
      },
    );
  });

  it("list — 包含两个任务", async () => {
    await sh.assertJson("./diy.sh task list", {
      ok: true,
      data: {
        status: "ok",
        data: {
          tasks: ["*", "*"],
        },
      },
    });
  });

  it("show — 查看任务详情", async () => {
    const list = await sh.getJson("./diy.sh task list");
    const uri = (list.data as any).data.tasks[0];

    await sh.assertJson("./diy.sh task show ${uri}".replace("${uri}", uri), {
      ok: true,
      data: {
        status: "ok",
        data: {
          uri,
          title: "研究一下",
          state: "pending",
          project: "tasks",
          created: "*",
          updated: "*",
          body: "",
        },
      },
    });
  });

  it("edit — 修改标题", async () => {
    const list = await sh.getJson("./diy.sh task list");
    const uri = (list.data as any).data.tasks[0];

    await sh.assertJson("./diy.sh task edit ${uri} --title 已修改".replace("${uri}", uri), {
      ok: true,
      data: { status: "ok", data: { uri } },
    });

    await sh.assertJson("./diy.sh task show ${uri}".replace("${uri}", uri), {
      ok: true,
      data: {
        status: "ok",
        data: {
          uri,
          title: "已修改",
          state: "pending",
          project: "tasks",
          created: "*",
          updated: "*",
          body: "",
        },
      },
    });
  });

  it("star — 关注任务", async () => {
    const list = await sh.getJson("./diy.sh task list");
    const uri = (list.data as any).data.tasks[0];

    await sh.assertJson("./diy.sh task star ${uri}".replace("${uri}", uri), {
      ok: true,
      data: { status: "ok", data: { uri, starred: true } },
    });
  });

  it("unstar — 取消关注", async () => {
    const list = await sh.getJson("./diy.sh task list");
    const uri = (list.data as any).data.tasks[0];

    await sh.assertJson("./diy.sh task unstar ${uri}".replace("${uri}", uri), {
      ok: true,
      data: { status: "ok", data: { uri, starred: false } },
    });
  });

  it("delete — 删除任务", async () => {
    const list = await sh.getJson("./diy.sh task list");
    const uri = (list.data as any).data.tasks[0];

    await sh.assertJson("./diy.sh task delete ${uri}".replace("${uri}", uri), {
      ok: true,
      data: { status: "ok", data: { uri } },
    });
  });

  it("delete — 删除不存在的任务（幂等）", async () => {
    await sh.assertJson("./diy.sh task delete local/nonexistent", {
      ok: true,
      data: { status: "ok", data: { uri: "local/nonexistent" } },
    });
  });

  it("create — 空标题报错", async () => {
    await sh.assertSession(`
      $! ./diy.sh task create '' tasks
      *标题不能为空*
    `);
  });

  it("show — 不存在的任务报错", async () => {
    await sh.assertJson("./diy.sh task show local/nonexistent", {
      ok: true,
      data: { status: "error", msg: "任务 local/nonexistent 不存在" },
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// ui
// ═══════════════════════════════════════════════════════════════

describe("ui", () => {
  it("status — 返回进程信息", async () => {
    await sh.assertJson("./diy.sh ui status", {
      ok: true,
      data: { status: "ok", data: { pid: "*", uptime: "*", memory: "*" } },
    });
  });

  it("tree — 返回文本树", async () => {
    await sh.assertJson("./diy.sh ui tree", {
      ok: true,
      data: { status: "ok", data: "*" },
    });
  });

  it("navigate — 切换页面（无 GUI 时导航回调不触发，仅返回状态）", async () => {
    await sh.assertJson("./diy.sh ui page navigate task", {
      ok: true,
      data: { status: "ok" },
    });
  });

  it("focus — 选中任务（无 GUI 时聚焦回调不触发，仅返回状态）", async () => {
    await sh.assertJson("./diy.sh ui page focus local/abc", {
      ok: true,
      data: { status: "ok" },
    });
  });

  it("toast — 弹通知（无 GUI 时通知回调不触发，仅返回状态）", async () => {
    await sh.assertJson("./diy.sh ui page toast 测试消息 --level info", {
      ok: true,
      data: { status: "ok" },
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// doctor — 最后测，此时 state.yaml 已存在
// ═══════════════════════════════════════════════════════════════

describe("doctor", () => {
  it("正常状态 — state.yaml 已存在", async () => {
    await sh.assertJson("./diy.sh doctor", {
      ok: true,
      data: {
        status: "ok",
        data: { pid: "*", home: HOME, state_exists: true, issues: [], healthy: true },
      },
    });
  });
});
