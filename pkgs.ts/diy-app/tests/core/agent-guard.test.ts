// tests/core/agent-guard.test.ts
// 🎯 护栏意图：agent 的 bash 工具不得杀死 diy 自身进程（自杀 → 白屏 + 无 minidump）
//    纯函数判定，不依赖真实进程；同时验证 write-ahead 审计的落盘/回溯

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { killSegments, killTargetCandidates, judgeSelfKill, type SelfProcessInfo } from "../../src/main/services/agent-guard";
import { appendAudit, auditFile, crashContext, crashScene, tailAudit } from "../../src/main/services/agent-audit";
import { activeTurnList, noteRendererTouch, noteTurnEnd, noteTurnStart, resetRuntimeContext } from "../../src/main/services/runtime-context";
import { diyHome } from "../../src/main/core/state";

/** 构造"我"= pid 1000，pgid 1000，子进程 1001/1002，命令行含 Electron 特征 */
function fakeSelf(): SelfProcessInfo {
  return {
    pid: 1000,
    pgid: 1000,
    pids: new Set([1000, 1001, 1002, 999]),
    cmdlines: [
      "/x/node_modules/electron/dist/electron.app/contents/macos/electron /x/out/main/index.mjs",
      "/x/electron helper --type=gpu-process --user-data-dir=/u/.diy/electron_user_data",
      "/x/electron helper --type=renderer",
    ],
  };
}

describe("judgeSelfKill —— 必须拦住的自杀命令", () => {
  const self = fakeSelf();
  const cases: Array<[string, string]> = [
    ["显式杀自身 pid", "kill -9 1000"],
    ["杀自身子进程（GPU/renderer）", "kill -9 1001 1002 2>/dev/null; sleep 1; pgrep -fl electron"],
    ["杀同进程组", "kill -9 -1000"],
    ["pkill 匹配 electron", 'pkill -9 -f "electron"'],
    ["killall Electron", "killall -9 Electron"],
    ["历史里那条管道自杀命令", 'ps aux | grep -E "Electron" | grep -v grep | awk \'{print $2}\' | xargs kill -9'],
    ["反 grep 自身写法 [E]lectron + xargs kill", 'ps aux | grep -E "[E]lectron" | awk \'{print $2}\' | xargs kill -9 2>/dev/null'],
    ["pkill 不带目标", "pkill -9"],
    ["命令含 .diy 路径 + kill", "kill -9 $(cat /Users/ccc/.diy/app.port)"],
  ];
  for (const [name, cmd] of cases) {
    it(name, () => {
      expect(judgeSelfKill(cmd, self).blocked).toBe(true);
    });
  }
});

describe("judgeSelfKill —— 不能误伤的正常命令", () => {
  const self = fakeSelf();
  const cases: Array<[string, string]> = [
    ["只查询不杀", 'ps aux | grep -E "Electron" | grep -v grep | awk \'{print $2}\''],
    ["pgrep 查询", "pgrep -fl electron | head -10"],
    ["杀无关 pid", "kill -9 54321"],
    ["杀端口占用者（动态 pid）", "kill -9 $(lsof -ti:3000)"],
    ["杀旧 pid 后只做查询（electron 不属杀进程段）", "kill -9 54321 2>/dev/null; sleep 2; ps aux | grep electron | grep -v grep | wc -l"],
    ["普通命令", "ls -la && git status"],
    ["无关的 kill -0 探测", "kill -0 54321 && echo alive"],
  ];
  for (const [name, cmd] of cases) {
    it(name, () => {
      const v = judgeSelfKill(cmd, self);
      expect(v.blocked, v.reason).toBe(false);
    });
  }
});

describe("killSegments", () => {
  it("只取含杀进程的命令段，管道不切", () => {
    const segs = killSegments("kill -9 54321; ps aux | grep electron | wc -l");
    expect(segs).toHaveLength(1);
    expect(segs[0]).not.toContain("electron");
    expect(killSegments('ps aux | grep -E "Electron" | xargs kill -9')).toHaveLength(1);
    expect(killSegments("ls -la")).toHaveLength(0);
  });
});

describe("killTargetCandidates", () => {
  it("提取引号串与裸词，剔除 shell 噪声", () => {
    const got = killTargetCandidates('pkill -9 -f "Electron Helper" | xargs kill');
    expect(got).toContain("electron helper");
    expect(got).not.toContain("kill");
    expect(got).not.toContain("xargs");
    expect(got).not.toContain("/dev/null");
  });
});

describe("write-ahead 审计", () => {
  it("执行前落盘，崩溃后可由 crashContext 回溯最后一条命令", () => {
    const home = diyHome();
    const taskUri = "projects/9/tasks/1";
    appendAudit(home, { phase: "turn-start", taskUri, model: "mimo-v2.5", cwd: "/tmp" });
    appendAudit(home, { phase: "bash-start", taskUri, cwd: "/tmp", command: "kill -9 1001" });

    expect(existsSync(auditFile(home))).toBe(true);
    const rows = tailAudit(home, 5);
    expect(rows.some((r) => r.phase === "bash-start" && r.command === "kill -9 1001")).toBe(true);

    const ctx = crashContext(home);
    expect(ctx).toContain(taskUri);
    expect(ctx).toContain("kill -9 1001");
    // 原始文件确实是 JSONL（每行一条）
    const raw = readFileSync(auditFile(home), "utf-8").trim().split("\n");
    for (const line of raw) expect(() => JSON.parse(line)).not.toThrow();
  });

  // 回归：多任务并发时，命令必须与轮次**同任务**，不得张冠李戴
  // （真实事故 2026-09-15 06:25：报出「task=100 的轮次 + task=113 的命令」这种不存在的组合）
  it("多任务并发：命令不与轮次跨任务混搭", () => {
    const home = diyHome();
    const mine = "projects/9/tasks/100";
    const other = "projects/9/tasks/113";
    appendAudit(home, { phase: "turn-start", taskUri: mine, model: "mimo-v2.5", cwd: "/tmp" });
    appendAudit(home, { phase: "bash-start", taskUri: other, cwd: "/tmp", command: "other 的命令不该出现在这里" });
    appendAudit(home, { phase: "bash-end", taskUri: other, cwd: "/tmp", command: "other 的命令不该出现在这里" });

    const ctx = crashContext(home);
    expect(ctx).toContain(mine);
    expect(ctx).not.toContain(other); // 关键：不得借用别的任务的命令
    expect(ctx).not.toContain("other 的命令不该出现在这里");
    expect(ctx).toContain("该任务无命令记录"); // 宁可缺失，不可误导
  });
});

// ═══════════════════════════════════════
// 崩溃现场：内存权威优先
// ═══════════════════════════════════════

describe("崩溃现场 crashScene", () => {
  it("内存活跃轮次优先于审计尾部，且同时列出并发轮次", () => {
    resetRuntimeContext();
    const home = diyHome();
    const a = "projects/9/tasks/100";
    const b = "projects/9/tasks/113";
    appendAudit(home, { phase: "turn-start", taskUri: a, model: "mimo-v2.5", cwd: "/tmp" });
    noteTurnStart({ taskUri: a, model: "mimo-v2.5", cwd: "/tmp" });
    noteTurnStart({ taskUri: b, model: "mimo-v2.5", cwd: "/tmp" });
    noteRendererTouch("diy.agent.local.chat", a);

    const scene = crashScene(home);
    expect(scene).toContain("活跃轮次 2 个");
    expect(scene).toContain(a);
    expect(scene).toContain(b);
    expect(scene).toContain("diy.agent.local.chat");

    noteTurnEnd(a);
    noteTurnEnd(b);
    expect(activeTurnList()).toHaveLength(0);
    resetRuntimeContext();
  });

  it("无内存上下文时退回审计尾部（启动期/重启后回看崩溃）", () => {
    resetRuntimeContext();
    const home = diyHome();
    const uri = "projects/9/tasks/7";
    appendAudit(home, { phase: "turn-start", taskUri: uri, model: "mimo-v2.5", cwd: "/tmp" });
    appendAudit(home, { phase: "bash-start", taskUri: uri, cwd: "/tmp", command: "sleep 1" });

    const scene = crashScene(home);
    expect(scene).toContain("无内存上下文");
    expect(scene).toContain(uri);
    expect(scene).toContain("sleep 1");
  });
});
