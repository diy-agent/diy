// tests/shell-test.ts
// 🎯 ShellTest — CLI 意图测试工具（TypeScript 移植版）
//
// 用法:
//   import { ShellTest } from './shell-test'
//
//   // 一次性的转录本测试
//   ShellTest.default().assertSession(`
//     $ diy2 subject list
//     status: ok
//     data:
//       subjects: []
//     $! diy2 task create '' ~/x
//     *参数错误*
//   `)
//
//   // 自定义 AppConfig
//   const cfg = AppConfig.createTemp('my-test')
//   ShellTest.withHome(cfg.diyHome).assertSession(...)

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

// ── Types ──

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Block {
  cmd: string;
  stdoutExp: string[];
  stderrExp: string[];
  expectFail: boolean;
}

// ── Helpers ──

function ensureHome(home: string): void {
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
}

// ── Matcher ──

function lineMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  if (expected === "*") return true;

  // glob 式匹配（* 通配符）
  if (expected.includes("*")) {
    const escaped = expected.split("*").map((seg) => seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
    const pat = "^(?s:" + escaped.join(".*?") + ")$";
    return new RegExp(pat).test(actual);
  }

  return false;
}

function matchBlock(expected: string[], actual: string, label: string): void {
  const actualLines = actual
    ? actual
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    : [];
  const cleanExp = expected.filter((l) => l.trim());

  for (const exp of cleanExp) {
    if (exp === "*") continue;
    const found = actualLines.some((act) => lineMatches(exp, act));
    if (!found) {
      throw new Error(
        `[${label}] 未找到匹配行\n` +
          `  期望: ${JSON.stringify(exp)}\n` +
          `  实际:\n${actualLines.map((l) => "    " + l).join("\n")}`,
      );
    }
  }
}

// ── 转录本解析 ──

function parseSession(session: string): Block[] {
  const blocks: Block[] = [];
  const lines = session.split("\n");

  let cmd = "";
  let stdoutExp: string[] = [];
  let stderrExp: string[] = [];
  let expectFail = false;
  let target = stdoutExp;

  for (const line of lines) {
    const s = line.trim();

    if (s.startsWith("$! ")) {
      if (cmd) blocks.push({ cmd, stdoutExp, stderrExp, expectFail });
      cmd = s.slice(3).trim();
      stdoutExp = [];
      stderrExp = [];
      expectFail = true;
      target = stdoutExp;
      continue;
    }

    if (s.startsWith("$ ")) {
      if (cmd) blocks.push({ cmd, stdoutExp, stderrExp, expectFail });
      cmd = s.slice(2).trim();
      stdoutExp = [];
      stderrExp = [];
      expectFail = false;
      target = stdoutExp;
      continue;
    }

    if (s === "---") {
      target = stderrExp;
      continue;
    }

    if (!s || s.startsWith("#")) continue;
    target.push(s);
  }

  if (cmd) blocks.push({ cmd, stdoutExp, stderrExp, expectFail });
  return blocks;
}

// ── ShellTest ──

export class ShellTest {
  private readonly diyHome: string;
  private readonly cwd?: string;
  private readonly env?: Record<string, string>;

  constructor(opts?: { diyHome?: string; cwd?: string; env?: Record<string, string> }) {
    this.diyHome = opts?.diyHome ?? join(homedir(), ".diy");
    this.cwd = opts?.cwd;
    this.env = opts?.env;
  }

  /** 默认实例（基于 $DIY_HOME 或 ~/.diy） */
  static default(): ShellTest {
    return new ShellTest();
  }

  /** 指定 diyHome（配合 AppConfig.createTemp 使用） */
  static withHome(home: string): ShellTest {
    return new ShellTest({ diyHome: home });
  }

  /** 执行一条命令（通过 bash -c） */
  run(cmd: string): RunResult {
    ensureHome(this.diyHome);

    const result: SpawnSyncReturns<string> = spawnSync("bash", ["-c", cmd], {
      cwd: this.cwd,
      env: { ...process.env, DIY_HOME: this.diyHome, ...this.env },
      encoding: "utf-8",
      timeout: 30_000,
    });

    return {
      code: result.status ?? -1,
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim(),
    };
  }

  /** 便捷：直接运行 diy2 命令 */
  diy2(...args: string[]): RunResult {
    // 从 PATH 找 diy2
    const diy2Path = process.env["DIY2_PATH"] || "diy2";
    return this.run(`${diy2Path} ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`);
  }

  /** 转录本意图测试 */
  assertSession(session: string): void {
    const blocks = parseSession(session);

    for (const { cmd, stdoutExp, stderrExp, expectFail } of blocks) {
      const { code, stdout, stderr } = this.run(cmd);

      if (expectFail) {
        if (code === 0) {
          throw new Error(
            `$! ${cmd}\nexit=${code}（期望非零）\nstdout: ${stdout}\nstderr: ${stderr.toString()}`,
          );
        }
        if (stdoutExp.length === 0 && stderrExp.length === 0) continue;
      }

      // $! 命令的输出可能在 stderr，先试 stdout 再试 stderr
      if (expectFail && stdoutExp.length > 0) {
        try {
          matchBlock(stdoutExp, stdout, `stdout: $ ${cmd}`);
        } catch {
          matchBlock(stdoutExp, stderr, `stderr: $ ${cmd}`);
        }
      } else {
        matchBlock(stdoutExp, stdout, `stdout: $ ${cmd}`);
      }
      if (stderrExp.length > 0) {
        matchBlock(stderrExp, stderr.toString(), `stderr: $ ${cmd}`);
      }
    }
  }
}
