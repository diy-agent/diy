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
  it.skip("两个 task 触发会话，互相隔离且持久化到 meta.yaml", async () => {
    // 依赖真实 hermes acp + 模型，默认跳过；本地验证用 --run 手动开启
    const { pid, t1, t2 } = await setup();

    // 分别触发两个 task 的会话
    await fx.sh.run(`./diy.sh agent status ${t1}`);
    await fx.sh.run(`./diy.sh agent status ${t2}`);

    const sessions = readSessions(pid);
    expect(sessions[t1]).toBeTruthy();
    expect(sessions[t2]).toBeTruthy();
    expect(sessions[t1]).not.toBe(sessions[t2]); // 隔离

    // 清理
    await fx.sh.run(`./diy.sh project remove ${pid}`);
  }, 60000);
});
