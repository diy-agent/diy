// tests/cli.intent.project.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 project CLI 意图测试 — 自包含用例（JSON 模式）
//
// 原则：每个 it 自建自删自己的 project（唯一路径 → 自己的 id），
//   断言只看自己那一条数据，末尾 remove 清理。
//   共享的只有 Electron 基础设施，共享的数据为零 —— 单看任意一个 it 即完整可读。
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

// ── 每个用例的工具：用隔离 home 下的唯一路径，自建自删 ──

/** 建一个专属 project（隔离 home 下唯一路径），返回系统自动生成的 id */
async function createFresh(name: string): Promise<string> {
  const repo = `${fx.HOME}/it-${name}`;
  const res = await fx.sh.getJson(`./diy.sh project create ${repo} --label ${name}`);
  return String((res.data as any)?.data?.id);
}

describe("project", () => {
  it("create — 自动生成数字 id，并建 $DIY_HOME/projects/<id>/ 数据目录", async () => {
    const id = await createFresh("a");

    expect(id).toMatch(/^\d+$/);
    await fx.sh.assertSession(`
      $ test -d "$DIY_HOME/projects/${id}/tasks"
      $ test -f "$DIY_HOME/projects/${id}/meta.yaml"
    `);

    await fx.sh.run(`./diy.sh project remove ${id}`);
  });

  it("create — 在目标仓库写 diy.yaml 名片（含 project 段）", async () => {
    const repo = `${fx.HOME}/it-b`;
    await fx.sh.run(`mkdir -p ${repo}`); // 目标仓库需存在才会写名片

    const res = await fx.sh.getJson(`./diy.sh project create ${repo} --label b`);
    const id = String((res.data as any)?.data?.id);

    await fx.sh.assertSession(`
      $ test -f ${repo}/diy.yaml
      $ grep -q "project:" ${repo}/diy.yaml
    `);

    await fx.sh.run(`./diy.sh project remove ${id}`);
  });

  it("remove — 删除数据目录（连带任务）", async () => {
    const id = await createFresh("c");
    await fx.sh.assertSession(`$ test -d "$DIY_HOME/projects/${id}"`);

    await fx.sh.assertJson(`./diy.sh project remove ${id}`, {
      ok: true,
      data: { status: "ok", data: { id } },
    });
    await fx.sh.assertSession(`$ [ ! -d "$DIY_HOME/projects/${id}" ]`);
  });

  it("remove — 删除不存在的 project 幂等", async () => {
    await fx.sh.assertJson("./diy.sh project remove 99999", {
      ok: true,
      data: { status: "ok", data: { id: "99999" } },
    });
  });

  it("list — 包含刚创建的项目", async () => {
    const id = await createFresh("d");

    const list = await fx.sh.getJson("./diy.sh project list");
    const ids = (list.data as any).data.projects.map((p: any) => String(p.id));
    expect(ids).toContain(id);

    await fx.sh.run(`./diy.sh project remove ${id}`);
  });
});