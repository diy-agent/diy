// tests/cli.intent.agent-session.test.ts
// ═══════════════════════════════════════════════════════════════
// 🎯 agent ACP session 池验证 — task 级会话隔离 + 持久化 + 恢复
//
// 走法（CLI 驱动，同 agent 探测入口）：
//   diy project create → diy task create ×2 → diy agent status <taskUri>
//   → 断言每个 task 获得独立 session（持久化进 project meta.yaml）
//
// 验证核心：task 级 session 隔离 + sessionId 持久化。
// 不做真实模型推理（避免依赖网络/慢），仅验证会话管理生命周期。
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import * as yaml from "js-yaml";
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

/** 读某 project 的 meta.yaml 里 acp_sessions 字段 */
function readSessions(pid: string): Record<string, string> {
  const metaFile = join(fx.HOME, "projects", pid, "meta.yaml");
  if (!existsSync(metaFile)) return {};
  const raw = yaml.load(readFileSync(metaFile, "utf-8")) as Record<string, unknown>;
  return (raw["acp_sessions"] ?? {}) as Record<string, string>;
}

/** 建 project + 2 tasks，返回 {pid, t1, t2} */
async function setup(): Promise<{ pid: string; t1: string; t2: string }> {
  const repo = `${fx.HOME}/agent-${Date.now()}`;
  const r = await fx.sh.getJson(`./diy.sh project create ${repo} --label 会话项目`);
  const pid = String((r.data as any)?.data?.id);
  await fx.sh.run(`./diy.sh task create 任务甲 ${pid}`);
  await fx.sh.run(`./diy.sh task create 任务乙 ${pid}`);
  return { pid, t1: `projects/${pid}/tasks/1`, t2: `projects/${pid}/tasks/2` };
}

describe("agent session — task 级 ACP 会话隔离 + 持久化", () => {
  // status 必须是纯读：曾经它内部调 ensure()，导致「查个状态」顺手建会话、起子进程、
  // 写 meta.yaml。UI 每切换一次任务就调一次，等于浏览行为篡改了数据。
  it.skip("status 只读：不创建会话、不写 meta.yaml", async () => {
    const { pid, t1 } = await setup();

    const r = await fx.sh.getJson(`./diy.sh agent status ${t1}`);
    expect((r as any).state ?? (r as any).data?.state).toBe("no_session");
    // 未建会话 → meta.yaml 里不该出现该 task 的 acp_sessions 条目
    expect(readSessions(pid)[t1]).toBeFalsy();

    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 60000);

  it.skip("两个 task 触发会话，互相隔离且持久化到 meta.yaml", async () => {
    // 依赖真实 opencode acp + 模型，默认跳过；本地验证用 --run 手动开启
    const { pid, t1, t2 } = await setup();
    const msg = '--messages [{"role":"user","content":"hi"}]';

    // 触发会话的正确方式是对话，不是查状态
    await fx.sh.run(`./diy.sh agent chat ${t1} "" ${msg}`);
    await fx.sh.run(`./diy.sh agent chat ${t2} "" ${msg}`);

    const sessions = readSessions(pid);
    expect(sessions[t1]).toBeTruthy();
    expect(sessions[t2]).toBeTruthy();
    expect(sessions[t1]).not.toBe(sessions[t2]); // 隔离

    // 对话之后 status 才报 ready
    const s1 = await fx.sh.getJson(`./diy.sh agent status ${t1}`);
    expect((s1 as any).state ?? (s1 as any).data?.state).toBe("ready");

    // 清理
    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 60000);
});
