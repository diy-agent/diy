// 🎯 「进程表 → 实例进程行」的**纯函数**层：分类 / 去重（解析在 os 策略，见 os/posix.ts）。
//
// 为什么必须纯：实例发现没有索引（`app.port` 是「一个数据根一份」，回答不了「本机有哪几个根」），
// 只能扫进程；而分类/去重的规则一旦埋在 RPC handler 里，就只能靠起 Electron 才能验。
// 这里零 I/O（快照由调用方给），单测直接喂行。
//
// 判据来源（本机实测，见任务 body）：
//   Electron 主进程：  <…>/Electron.app/Contents/MacOS/Electron <…>/build/<v>/main/index.mjs --remote-debugging-port=0
//   helper 进程：      <…>/Electron Helper (Renderer).app/…  --type=renderer …（**同一实例的第二/三/四个进程**）
//   crashpad：         …/Helpers/chrome_crashpad_handler --database=…（同样不属于实例本身）
//   serve（无窗口）：  node <…>/build/<v>/serve/index.mjs
//   CLI 客户端：       node <…>/build/<v>/cli/index.js agent local chat …（是**客户端**，不是实例 —— 不列）
//
// 去重 = 「只留每个实例的 Electron 主进程」：helper 靠 `--type=` 现形，且它们的入口 token
// 不是 `main/index.mjs`（实测 helper 的命令行里没有那个 token，双保险）。
//
// 路径判据**同时接受 `/` 与 `\`**：Windows 的 CommandLine 是反斜杠，不为此在调用方加平台分支。

export interface PsProcess {
  pid: number;
  ppid: number;
  /** 完整命令行（`ps -o command=` 原文） */
  command: string;
}

/** 一个 diy 实例的进程行（已去重：一个实例一条） */
export interface InstanceProcess {
  pid: number;
  ppid: number;
  command: string;
  /** 实例入口产物路径（`…/build/<variant>/main/index.mjs` 或 `…/serve/index.mjs`） */
  entry: string;
  /** 从 entry 路径推出的产物变体（prod|test|lab）；推不出为 null */
  variant: string | null;
  kind: "electron" | "serve";
}

/** `ps -Ao pid=,ppid=,command=` 的一行；表头/空行/畸形行一律跳过（不猜）。 */

/** 入口 token：`…/build/<variant>/{main,serve}/index.{mjs,js}`（绝对路径才认，防误命中参数里的字符串） */
const ENTRY_RE = /^(?:\/|.*\/)build\/([^/\s]+)\/(main|serve)\/index\.(?:mjs|js)$/;

/**
 * 从命令行里挑出实例入口。
 * 判据 = **某个 token 本身是入口产物路径**（不是「命令行里出现过这个词」）——
 * `node …/cli/index.js` 里出现的 `index.js` 不匹配（它不是 `main|serve/index.js`）。
 * token 两侧的引号（Windows CommandLine 会保留）先剥掉；分隔符统一成正斜杠。
 */
export function instanceEntryOf(command: string): { entry: string; variant: string | null; kind: "electron" | "serve" } | null {
  for (const raw of command.split(/\s+/)) {
    const tok = raw.replace(/^"+|"+$/g, "").replace(/\\/g, "/");
    if (!tok.includes("/")) continue;
    const m = ENTRY_RE.exec(tok);
    if (!m) continue;
    const kind = m[2] === "serve" ? "serve" : "electron";
    return { entry: tok, variant: m[1] ?? null, kind };
  }
  return null;
}

/** Chromium 子进程（GPU / renderer / utility / crashpad）：`--type=` 是官方判据，crashpad 单独认 */
export function isHelperCommand(command: string): boolean {
  return /\s--type=/.test(command) || command.includes("chrome_crashpad_handler");
}

/**
 * 分类一个进程。
 * `helper` 优先于 `instance`：helper 命令行里也可能出现 `--app-path=…/main`（实测 renderer 有），
 * 它是**同一个实例的另一个进程**，绝不能另起一行。
 */
export function classifyProcess(p: PsProcess): InstanceProcess | null {
  if (isHelperCommand(p.command)) return null;
  const hit = instanceEntryOf(p.command);
  if (!hit) return null;
  return { pid: p.pid, ppid: p.ppid, command: p.command, entry: hit.entry, variant: hit.variant, kind: hit.kind };
}

/** 同一实例只留一条（按 pid 唯一；pid 重复时保留首条 —— ps 不会重复，父链多次采样才会） */
export function pickInstanceProcesses(procs: PsProcess[]): InstanceProcess[] {
  const seen = new Set<number>();
  const out: InstanceProcess[] = [];
  for (const p of procs) {
    const inst = classifyProcess(p);
    if (!inst || seen.has(inst.pid)) continue;
    seen.add(inst.pid);
    out.push(inst);
  }
  return out.sort((a, b) => a.pid - b.pid);
}

/** 命令行摘要（表格用）：保留「谁 + 入口」，掐掉长参数尾巴 */
export function cmdlineSummary(command: string, maxLen = 72): string {
  const joined = command.trim();
  if (joined.length <= maxLen) return joined;
  return `${joined.slice(0, maxLen - 1)}…`;
}
