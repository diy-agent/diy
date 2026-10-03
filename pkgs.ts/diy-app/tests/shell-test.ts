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
import { join } from "node:path";

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
  /** 哨兵序号（每条命令一个，避免与命令输出/上一条哨兵混淆） */
  private seq = 0;
  private closed = false;
  private ready: Promise<void>;

  constructor(opts?: { cwd?: string; env?: Record<string, string> }) {
    // 自动化测试强制 DIY_ENV=test（setup.ts 已设，但外层 shell 可能导出 production 干扰）：
    // runtime.ts 据此派生副屏定位等测试专属能力，避免频繁启动遮挡主屏工作
    const merged = { ...process.env, ...opts?.env } as Record<string, string>;
    merged["DIY_ENV"] = "test";
    this.proc = spawn("bash", ["--norc", "-i"], {
      cwd: opts?.cwd,
      env: merged,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout!.on("data", (d: Buffer) => { this.outBuf += d.toString(); });
    this.proc.stderr!.on("data", (d: Buffer) => { this.errBuf += d.toString(); });

    // 设 PS1 marker（$? 捕获退出码），readonly 防覆盖
    this._write(`PS1='${markerPrefix}($?)__ '`);
    this._write("readonly PS1");
    // 吞掉 bash 启动输出 + 首次 PS1（无命令要跑，不需要 stdout 哨兵 → 传空串）
    this.ready = this._read("", 5000).then(() => {});
  }

  private _write(cmd: string): void {
    if (this.closed) return;
    try { this.proc.stdin!.write(cmd + "\n"); } catch { /* 子进程已退出 */ }
  }

  /**
   * 读输出直到**两个哨兵都到达**（stdout 的 `SENTINEL:<code>` + stderr 的 `SENTINEL_E`），
   * 或超时。resolve [是否找到, 退出码]。
   *
   * 为什么必须等哨兵（不能等 PS1 marker）：
   *   1. stdout 与 stderr 是**两条管道**，到达顺序不保证 —— 只等 stderr marker 时 stdout 可能没到齐
   *      （实测：`ui tree` 拿到上一条 `project create` 的 `{id}` → "not iterable"）。故 stdout 用哨兵。
   *   2. **PS1 marker 不能作为完成信号**（真实踩过，t223 定点复现 ShellTest 丢 ~7%）：`run()` 让 bash
   *      连续执行「命令」「printf 哨兵」两条，于是打印**两个** prompt marker。第二个 marker 常在下一条
   *      命令的缓冲区里才到达 —— 若下一条 `_read` 看到这个**陈旧 marker** 且 stdout 哨兵恰好先到（两条
   *      管道乱序），就提前 resolve，此时该条命令的 stderr（含错误信息）还没到 → 读到空 stderr。
   *      现象：错误路径断言 `expected '' to match /.../` 偶发红且 retry 无效。
   * 修法：完成信号改成**携带唯一序号的两个哨兵**（stdout 一个、stderr 一个）—— 唯一 → 不会被陈旧信号
   * 误判；stderr 哨兵与命令 stderr 同管道 → 有序，看到它即证明命令 stderr 到齐。
   */
  private _read(sentinel: string, timeoutMs: number): Promise<{ found: boolean; code: number }> {
    const start = Date.now();
    const rcRe = sentinel ? new RegExp(`${sentinel}:(\\d+)`) : null;
    const errRe = sentinel ? new RegExp(`${sentinel}E`) : null;
    return new Promise((resolve) => {
      const check = () => {
        // 空哨兵（构造器）只等 prompt；否则必须两个唯一哨兵都到
        if (rcRe === null) {
          const m = markerRe.exec(this.errBuf);
          if (m) { resolve({ found: true, code: parseInt(m[1], 10) }); return; }
        } else {
          const rc = rcRe.exec(this.outBuf);
          if (rc && errRe!.test(this.errBuf)) {
            resolve({ found: true, code: parseInt(rc[1]!, 10) });
            return;
          }
        }
        if (Date.now() - start > timeoutMs) {
          resolve({ found: false, code: -1 });
          return;
        }
        setTimeout(check, 5);
      };
      check();
    });
  }

  /** 执行一条命令，返回退出码 + stdout + stderr（持续同一 bash 进程） */
  async run(cmd: string, timeoutMs = 20000): Promise<RunResult> {
    await this.ready;
    this.outBuf = "";
    this.errBuf = "";
    // 命令 → 打 stdout 哨兵（证明前面输出到齐，且**带着原命令的退出码**）。
    //
    // 退出码为什么放在哨兵里而不是只靠 PS1 的 `$?`：PS1 是**这条 printf 之后**才打印的，
    // 那时 `$?` 已经是 printf 自己的退出码（恒 0）—— 原命令的成败会被整个抹掉
    // （实测：`--body ''` 该报错却 exit=0）。`$?` 在 printf 的参数展开时求值，正是原命令的退出码。
    const sentinel = `${markerPrefix}DONE${++this.seq}`;
    this._write(cmd);
    // 两个唯一哨兵：stdout 带原命令退出码（`$?` 在 printf 参数展开时求值 = 原命令退出码），
    // stderr 用于「命令 stderr 已到齐」的完成信号（与命令 stderr 同管道，有序）。
    this._write(`printf '\\n%s:%d\\n' '${sentinel}' $?`);
    this._write(`printf '%s\\n' '${sentinel}E' >&2`);
    const { found, code } = await this._read(sentinel, timeoutMs);
    // 实验：不等待收尾标记（模拟改造前的行为）

    // 清理 PS1 marker 与收尾哨兵，还原真实输出。
    //
    // ⚠️ 必须**按子串剥离** marker，不能「整行过滤」（真实踩过，t223 定点复现）：
    // PS1 以空格结尾（不以换行结尾），于是**命令的 stderr 会和它前面的 prompt 落在同一行**：
    //     "__ST_…__(0)__ Error: 未知模型 …"
    // 旧写法 `errLines.filter(l => !markerRe.test(l))` 会把这**含真实错误**的整行一起丢掉 →
    // stderr 变空 → 错误路径断言 `expected '' to match /…/` 偶发红（~2%）且 retry 无效。
    const errSentinelRe = new RegExp(`${sentinel}E`, "g");
    const stripMarkerRe = new RegExp(`${markerPrefix}\\(\\d+\\)__ ?`, "g");
    const cleanErr = this.errBuf
      .split("\n")
      .map((l) => l.replace(stripMarkerRe, "").replace(errSentinelRe, "").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
    const rawOut = this.outBuf;
    // 剥掉哨兵行（含退出码；它是协议开销，不是命令输出）
    const cleanOut = rawOut
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "")
      .replace(new RegExp(`${sentinel}:\\d+`, "g"), "")
      .trim();

    if (!found) {
      // 超时：挂死的前台 CLI 进程阻塞了 bash 会话，发 Ctrl+C 释放前台 + kill 旧 job
      try {
        this.proc.stdin?.write("\x03");
        await new Promise((r) => setTimeout(r, 100));
        this.proc.stdin?.write("kill %1 2>/dev/null; kill -9 %1 2>/dev/null\n");
        await new Promise((r) => setTimeout(r, 200));
      } catch { /* ignore */ }
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
  async run(cmd: string, timeoutMs?: number): Promise<RunResult> {
    return this.getSession().run(cmd, timeoutMs);
  }

  /** 便捷：直接运行本地 diy CLI（./diy.sh，靠 cwd=仓库根 定位） */
  async diy2(...args: string[]): Promise<RunResult> {
    return this.run(`./diy.sh ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`);
  }

  /** 运行命令（自动加 --json）并返回解析后的对象 */
  async getJson(cmd: string): Promise<Record<string, unknown>> {
    return (await this.runJson(cmd)).json;
  }

  /**
   * 运行 --json 命令并解析；对「exit 0 但 stdout 为空」的偶发空响应重试（最多 2 次）。
   * 原因：CLI 每命令是独立 tsx 进程，HttpClientBinding 首连 @diy/rpc 偶发空响应（预存 flake）。
   * 空 stdout 在意图 JSON 命令里永远不该发生，故重试安全，不掩盖真实错误。
   */
  private async runJson(cmd: string): Promise<{ json: Record<string, unknown> }> {
    const cmdJson = `${cmd} --json`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { code, stdout, stderr } = await this.run(cmdJson);
      if (code !== 0) throw new Error(`[json: ${cmd}] exit=${code}\nstderr: ${stderr}`);
      if (stdout.trim() !== "" || attempt === 2) {
        try {
          return { json: JSON.parse(stdout) as Record<string, unknown> };
        } catch {
          throw new Error(`[json: ${cmd}] 输出非 JSON（len=${stdout.length}）\nstdout: ${stdout.slice(0, 400)}`);
        }
      }
      // 预存 flake：CLI 独立进程冷启动首连偶发丢响应（exit 0 但空 stdout）。
      // 重试间留间隔，跨过启动竞态窗口，避免连续空落。
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`[json: ${cmd}] 多次空响应`);
  }

  /** JSON 意图断言 */
  async assertJson(cmd: string, expected: unknown): Promise<void> {
    const { json } = await this.runJson(cmd);
    matchJsonValue(expected, json, `$ ${cmd}`);
  }

  /** 转录本意图测试（持久 session，命令连续执行） */
  async assertSession(session: string): Promise<void> {
    const blocks = parseSession(session);
    for (const { cmd, stdoutExp, stderrExp, expectFail } of blocks) {
      let { code, stdout, stderr } = await this.run(cmd);
      // 预存 flake：CLI 独立进程首连偶发空响应。非 expectFail 且有 stdout 期望时重跑一次
      if (!expectFail && stdoutExp.length > 0 && code === 0 && stdout.trim() === "") {
        ({ code, stdout, stderr } = await this.run(cmd));
      }
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
