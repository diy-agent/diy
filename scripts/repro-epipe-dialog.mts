/**
 * scripts/repro-epipe-dialog.mts — A/B 复现「stderr EPIPE → Electron 模态异常框 → 主进程冻死」
 *
 * 依据（Electron 框架内置，见 browser_init）：
 *   process.on("uncaughtException", e => {
 *     process.listenerCount("uncaughtException") > 1 || dialog.showErrorBox(
 *       "A JavaScript error occurred in the main process",
 *       "Uncaught Exception:\n" + e.stack)            ← 你截图的文本正是这个拼装
 *   })
 * showErrorBox 是同步模态 → 主进程事件循环停摆 → RPC / CDP / HTTP 全部无响应，
 * 但进程不退出，所以不生成 .ips、log show 也查不到。
 *
 * 场景 A（无防护）→ 预期：弹框 + 探针与心跳双双停摆
 * 场景 B（GUARD=1）→ 预期：无弹框 + 探针心跳照常 + 异常落文件
 *
 * 跑法：npx tsx scripts/repro-epipe-dialog.mts
 * ⚠️ 场景 A 会在屏幕上真弹一个模态框；脚本会在采样结束后强杀该进程。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const victim = join(scriptDir, "_repro-victim.mjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 单次 HTTP 探针：200ms 内无响应即视为主进程未响应 */
function ping(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/ping", timeout: 200 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function beatCount(file: string): number {
  try {
    return readFileSync(file, "utf-8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

interface RunResult {
  label: string;
  guard: boolean;
  mode: "epipe" | "throw";
  pingBefore: number;
  pingAfter: number;
  samples: number;
  beatsBefore: number;
  beatsAfter: number;
  alive: boolean;
  guardLog: string;
}

async function run(
  label: string,
  port: number,
  opts: { guard: boolean; mode: "epipe" | "throw" },
): Promise<RunResult> {
  const guard = opts.guard;
  const logFile = join(scriptDir, `.repro-guard-${guard ? "on" : "off"}.log`);
  const hbFile = join(scriptDir, `.repro-hb-${guard ? "on" : "off"}.txt`);
  rmSync(logFile, { force: true });
  rmSync(hbFile, { force: true });

  console.log(`\n${"═".repeat(66)}\n${label}\n${"═".repeat(66)}`);

  const child = spawn(String(electronPath), [victim], {
    env: {
      ...process.env,
      PROBE_PORT: String(port),
      HB: hbFile,
      GUARD: guard ? "1" : "0",
      LOG: logFile,
      // throw 模式不需要制造 EPIPE，关掉 stderr 心跳写以免干扰归因
      STDERR_WRITE: opts.mode === "epipe" ? "1" : "0",
      THROW: opts.mode === "throw" ? "1" : "0",
    },
    // stderr 接成管道，稍后关掉读端 —— 复刻后台任务退出、读者消失的真实条件
    stdio: ["ignore", "ignore", "pipe"],
  });
  const pid = child.pid ?? -1;
  console.log(`  pid=${pid}`);

  for (let i = 0; i < 80; i++) {
    if (await ping(port)) break;
    await sleep(250);
  }

  // 基线：1s
  let pingBefore = 0;
  for (let i = 0; i < 5; i++) {
    if (await ping(port)) pingBefore++;
    await sleep(200);
  }
  const beatsBefore = beatCount(hbFile);
  console.log(`  基线        探针 ${pingBefore}/5 心跳 ${beatsBefore} 行`);

  if (opts.mode === "epipe") {
    console.log("  ▶ 关闭 stderr 管道读端 → 等待 EPIPE 后果");
    child.stderr?.destroy();
  } else {
    console.log("  ▶ 2.5s 后主动 throw 一个普通未捕获异常（不依赖 EPIPE）");
  }

  let pingAfter = 0;
  let samples = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    samples++;
    if (await ping(port)) pingAfter++;
    await sleep(300);
  }
  const beatsAfter = beatCount(hbFile) - beatsBefore;
  const alive = child.exitCode === null && child.signalCode === null;

  console.log(`  触发后(12s) 探针 ${pingAfter}/${samples} 心跳增量 ${beatsAfter} 行（满值约 120）`);
  console.log(`  进程存活: ${alive ? "yes —— 所以不生成 .ips 崩溃报告" : `no (exit=${child.exitCode})`}`);
  if (!guard && alive && pingAfter === 0) {
    console.log("  ★ 事件循环被同步模态框阻塞中 → 屏幕上的 \"Uncaught Exception:\" 就是这个");
  }

  const guardLog = existsSync(logFile) ? readFileSync(logFile, "utf-8").trim() : "";
  if (guardLog) {
    const lines = guardLog.split("\n");
    console.log(`  防护捕获到 ${lines.length} 条异常，首条:`);
    console.log(`    ${lines[0]}`);
  }

  if (alive) child.kill("SIGKILL");
  await sleep(600);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");

  return { label, guard, mode: opts.mode, pingBefore, pingAfter, samples, beatsBefore, beatsAfter, alive, guardLog };
}

(async () => {
  console.log("\n═══ 复现矩阵：未捕获异常 → Electron 同步模态框 → 事件循环冻结 ═══");
  console.log("触发源 × 是否有防护，共 4 个场景。探针/心跳停摆 = 主进程被弹框阻塞。\n");

  const A = await run("A ── EPIPE 触发，无防护（复刻事故现场）", 51911, { guard: false, mode: "epipe" });
  const B = await run("B ── EPIPE 触发，有防护", 51912, { guard: true, mode: "epipe" });
  const C = await run("C ── 普通 throw 触发，无防护（证明与 EPIPE 无关）", 51913, { guard: false, mode: "throw" });
  const D = await run("D ── 普通 throw 触发，有防护（证明自注册即抑制弹框）", 51914, { guard: true, mode: "throw" });

  const all = [A, B, C, D];
  const healthy = (r: RunResult) => r.pingAfter / r.samples > 0.9;
  const frozen = (r: RunResult) => r.pingAfter / r.samples < 0.5 && r.alive;
  const name = (r: RunResult, i: number) => `${"ABCD"[i]}`;

  console.log(`\n${"═".repeat(74)}\n对比\n${"═".repeat(74)}`);
  console.log(`  ${"".padEnd(22)}${"触发源".padEnd(10)}${"探针".padEnd(12)}${"心跳".padEnd(8)}${"事件循环".padEnd(12)}弹框`);
  all.forEach((r, i) => {
    console.log(
      `  ${name(r, i).padEnd(22)}${(r.mode ?? "").padEnd(10)}${`${r.pingAfter}/${r.samples}`.padEnd(12)}${String(r.beatsAfter).padEnd(8)}${(frozen(r) ? "冻结" : "存活").padEnd(12)}${frozen(r) ? "有（同步阻塞）" : "无 ✓"}`,
    );
  });

  console.log("\n分层验证：");
  console.log(`  第①层 stream error 监听 → 吸收 EPIPE：B 探针 ${B.pingAfter}/${B.samples}，且未产生 uncaughtException 记录（日志${B.guardLog ? "有" : "空"}）`);
  console.log(`  第②层 自注册 uncaughtException → 满足 Electron 的 listenerCount>1 守卫：`);
  console.log(`     C 无防护 → 事件循环${frozen(C) ? "冻结（弹框）" : "存活"}；D 有防护 → ${healthy(D) ? "存活" : "冻结"}，异常落盘 ${D.guardLog ? "✓" : "✗"}`);
  if (D.guardLog) console.log(`     D 捕获内容: ${D.guardLog.split("\n")[0]}`);

  const pass = frozen(A) && healthy(B) && frozen(C) && healthy(D);
  console.log(`\n判定：${pass ? "✔ 事故完整复现，且两层防护各自被单独证明有效" : "✘ 未达预期，继续排查"}`);
  console.log("\n结论：弹框不是「代码里缺 try/catch」，而是 Electron 内置 uncaughtException 处理器");
  console.log("对**任何**未捕获异常都调用同步的 dialog.showErrorBox；它自带 listenerCount>1 守卫，");
  console.log("故 app 侧自注册处理器即可消除弹框，再把异常写进 log/main.log 留痕。\n");

  for (const f of [".repro-guard-on.log", ".repro-guard-off.log", ".repro-hb-on.txt", ".repro-hb-off.txt"]) {
    rmSync(join(scriptDir, f), { force: true });
  }
})();
