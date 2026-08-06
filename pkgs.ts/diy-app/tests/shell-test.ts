// tests/shell-test.ts
// 🎯 ShellTest — CLI 意图测试工具（持久 bash session）
//
// 对齐 python ShellTest（pkgs/diy-test/src/diy/test/shelltest.py）：
//  - 单个持久 bash 进程（PTY/管道），命令连续执行共享上下文（环境变量 / cwd / $?）
//  - PS1 marker `__ST_xxx__($?)__` 捕获每条命令的退出码
//  - 默认 cwd = 仓库根（pkgs.ts/diy-app/tests/ → ../../..），`./diy.sh` 自然可执行，不干预命令行
//
// 用法:
//   import { ShellTest } from './shell-test'
//   const sh = new ShellTest({ cwd: repoRoot, env: { HOME, DIY_HOME } })
//   sh.assertSession(`$ ./diy.sh subject list\n...`)
//   sh.assertJson("./diy.sh task list", { ok: true, ... })
//   const uri = sh.getJson("./diy.sh task list").data...tasks[0]
//   sh.close()   // 释放 session

import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

// ═══════════════════════════════════════════════════
//  持久 bash Session（对齐 python Session）
// ═══════════════════════════════════════════════════

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const markerPrefix = `__ST_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 8)}__`;
const markerRe = new RegExp(`${markerPrefix}\\((\\d+)\\)__`);

export class Session {
  private proc: ChildProcess;
  private outBuf = "";
  private errBuf = "";
  private closed = false;
  private ready: Promise<void>;

  constructor(opts?: { cwd?: string; env?: Record<string, string> }) {
    this.proc = spawn("bash", ["--norc", "-i"], {
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env }, // 合并，保留 PATH 等
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout!.on("data", (d: Buffer) => { this.outBuf += d.toString(); });
    this.proc.stderr!.on("data", (d: Buffer) => { this.errBuf += d.toString(); });

    // 设 PS1 marker（$? 捕获退出码），readonly 防覆盖
    this._write(`PS1='${markerPrefix}($?)__ '`);
    this._write("readonly PS1");
    // 吞掉 bash 启动输出 + 首次 PS1
    this.ready = this._read(5000).then(() => {});
  }

  private _write(cmd: string): void {
    if (this.closed) return;
    try { this.proc.stdin!.write(cmd + "\n"); } catch { /* 子进程已退出 */ }
  }

  /** 读输出直到 marker 出现或超时。resolve [是否找到 marker, 退出码] */
  private _read(timeoutMs: number): Promise<{ found: boolean; code: number }> {
    const start = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        const m = markerRe.exec(this.errBuf);
        if (m) {
          resolve({ found: true, code: parseInt(m[1], 10) });
          return;
        }
        if (Date.now() - start > timeoutMs) {
          resolve({ found: false, code: -1 });
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
  }

  /** 执行一条命令，返回退出码 + stdout + stderr（持续同一 bash 进程） */
  async run(cmd: string, timeoutMs = 20000): Promise<RunResult> {
    await this.ready;
    this.outBuf = "";
    this.errBuf = "";
    this._write(cmd);
    const { found, code } = await this._read(timeoutMs);

    // 清理 marker 行，还原真实输出
    const errLines = this.errBuf.split("\n").filter(Boolean);
    const cleanErr = errLines.filter((l) => !markerRe.test(l)).join("\n").trim();
    const cleanOut = this.outBuf.replace(/\r\n/g, "\n").replace(/\r/g, "").trim();

    if (!found) {
      throw new Error(
        `[ShellTest] 未检测到命令完成 marker（超时 ${timeoutMs}ms）\n` +
        `  cmd: ${cmd}\n  stdout: ${cleanOut}\n  stderr: ${cleanErr}`,
      );
    }

    return { code, stdout: cleanOut, stderr: cleanErr };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this._write("exit"); } catch { /* ignore */ }
    try { this.proc.stdin?.end(); } catch { /* ignore */ }
    const t = setTimeout(() => { try { this.proc.kill("SIGKILL"); } catch { /* ignore */ } }, 2000);
    this.proc.once("exit", () => clearTimeout(t));
  }
}

// ═══════════════════════════════════════════════════
//  Matcher（glob / 递归 JSON）
// ═══════════════════════════════════════════════════

function lineMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  if (expected === "*") return true;
  if (expected.includes("*")) {
    const escaped = expected.split("*").map((seg) => seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
    const pat = "^(?s:" + escaped.join(".*?") + ")$";
    return new RegExp(pat).test(actual);
  }
  return false;
}

function matchJsonValue(expected: unknown, actual: unknown, label: string): void {
  if (expected === "*") return;
  if (typeof expected === "string") {
    if (typeof actual !== "string") {
      throw new Error(`[${label}] 期望字符串 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
    }
    if (!lineMatches(expected, actual)) {
      throw new Error(`[${label}] 值不匹配\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      throw new Error(`[${label}] 期望数组，实际 ${JSON.stringify(actual)}`);
    }
    if (expected.length !== actual.length) {
      throw new Error(`[${label}] 数组长度不匹配\n  期望 ${expected.length} 项: ${JSON.stringify(expected)}\n  实际 ${actual.length} 项: ${JSON.stringify(actual)}`);
    }
    for (let i = 0; i < expected.length; i++) matchJsonValue(expected[i], actual[i], `${label}[${i}]`);
    return;
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
      throw new Error(`[${label}] 期望对象，实际 ${JSON.stringify(actual)}`);
    }
    const exp = expected as Record<string, unknown>;
    const act = actual as Record<string, unknown>;
    for (const key of Object.keys(exp)) {
      if (!(key in act)) {
        throw new Error(`[${label}] 缺少字段 ${key}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
      }
      matchJsonValue(exp[key], act[key], `${label}.${key}`);
    }
    return;
  }
  if (expected !== actual) {
    throw new Error(`[${label}] 值不匹配\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
  }
}

function matchBlock(expected: string[], actual: string, label: string): void {
  const actualLines = actual ? actual.split("\n").map((l) => l.trim()).filter(Boolean) : [];
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

// ═══════════════════════════════════════════════════
//  转录本解析
// ═══════════════════════════════════════════════════

interface Block {
  cmd: string;
  stdoutExp: string[];
  stderrExp: string[];
  expectFail: boolean;
}

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
      stdoutExp = []; stderrExp = []; expectFail = true; target = stdoutExp;
      continue;
    }
    if (s.startsWith("$ ")) {
      if (cmd) blocks.push({ cmd, stdoutExp, stderrExp, expectFail });
      cmd = s.slice(2).trim();
      stdoutExp = []; stderrExp = []; expectFail = false; target = stdoutExp;
      continue;
    }
    if (s === "---") { target = stderrExp; continue; }
    if (!s || s.startsWith("#")) continue;
    target.push(s);
  }
  if (cmd) blocks.push({ cmd, stdoutExp, stderrExp, expectFail });
  return blocks;
}

// ═══════════════════════════════════════════════════
//  ShellTest — 工厂/持有 session
// ═══════════════════════════════════════════════════

export class ShellTest {
  private session: Session | null = null;
  private readonly cwd?: string;
  private readonly env?: Record<string, string>;

  constructor(opts?: { cwd?: string; env?: Record<string, string> }) {
    this.cwd = opts?.cwd ?? join(__dirname, "..", "..", ".."); // 默认仓库根
    this.env = opts?.env;
  }

  /** 默认实例（cwd=仓库根） */
  static default(): ShellTest {
    return new ShellTest();
  }

  private getSession(): Session {
    if (!this.session) this.session = new Session({ cwd: this.cwd, env: this.env });
    return this.session;
  }

  close(): void {
    this.session?.close();
    this.session = null;
  }

  /** 执行一条命令（持久 session，共享上下文；cwd 已是仓库根，./diy.sh 自然可执行） */
  async run(cmd: string): Promise<RunResult> {
    return this.getSession().run(cmd);
  }

  /** 便捷：直接运行本地 diy CLI（./diy.sh，靠 cwd=仓库根 定位） */
  async diy2(...args: string[]): Promise<RunResult> {
    return this.run(`./diy.sh ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`);
  }

  /** 运行命令（自动加 --json）并返回解析后的对象 */
  async getJson(cmd: string): Promise<Record<string, unknown>> {
    const { code, stdout, stderr } = await this.run(`${cmd} --json`);
    if (code !== 0) throw new Error(`[json: ${cmd}] exit=${code}\nstderr: ${stderr}`);
    try {
      return JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      throw new Error(`[json: ${cmd}] 输出非 JSON\nstdout: ${stdout}`);
    }
  }

  /** JSON 意图断言 */
  async assertJson(cmd: string, expected: unknown): Promise<void> {
    const { code, stdout, stderr } = await this.run(`${cmd} --json`);
    if (code !== 0) throw new Error(`[json: ${cmd}] exit=${code}\nstderr: ${stderr}`);
    let actual: unknown;
    try {
      actual = JSON.parse(stdout);
    } catch {
      throw new Error(`[json: ${cmd}] 输出非 JSON\nstdout: ${stdout}`);
    }
    matchJsonValue(expected, actual, `$ ${cmd}`);
  }

  /** 转录本意图测试（持久 session，命令连续执行） */
  async assertSession(session: string): Promise<void> {
    const blocks = parseSession(session);
    for (const { cmd, stdoutExp, stderrExp, expectFail } of blocks) {
      const { code, stdout, stderr } = await this.run(cmd);
      if (expectFail) {
        if (code === 0) {
          throw new Error(`$! ${cmd}\nexit=${code}（期望非零）\nstdout: ${stdout}\nstderr: ${stderr}`);
        }
        if (stdoutExp.length === 0 && stderrExp.length === 0) continue;
      }
      if (expectFail && stdoutExp.length > 0) {
        try { matchBlock(stdoutExp, stdout, `stdout: $ ${cmd}`); }
        catch { matchBlock(stdoutExp, stderr, `stderr: $ ${cmd}`); }
      } else {
        matchBlock(stdoutExp, stdout, `stdout: $ ${cmd}`);
      }
      if (stderrExp.length > 0) matchBlock(stderrExp, stderr, `stderr: $ ${cmd}`);
    }
  }
}
