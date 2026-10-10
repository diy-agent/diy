// src/main/core/instance-identity.ts
// 🎯 实例身份的**取值**（main 侧）：数据根展示形式 / 运行环境 / git 分支 / 端口 / PID。
// 「怎么拼成标题」是纯函数（shared/instance-title.ts，main 与 renderer 共用）；这里只管**取事实**。
//
// 两个必须由 main 承担的理由：
//   1. 缩写基准要**真实家目录**（getpwuid，不受 $HOME 改写影响），renderer 拿不到；
//      直接 use $HOME 时，测试/隔离实例的 DIY_HOME === $HOME → 标题退化成 `diy(~) [test]`。
//   2. git 分支只有 main 能查（要跑 git / 读 .git）：判断「跑的是哪个 worktree 的构建」。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { abbrevHome } from "../../shared/instance-title";

/** 本文件所在目录（打包后 = build/prod/main，源码直跑 = src/main/core），git 探测的起点 */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 真实家目录。POSIX 上走 getpwuid，**不读 $HOME** —— 后者会被测试/隔离实例改写，
 * 用作缩写基准就会把临时数据根伪装成 `~`。取不到（无 passwd 条目）才退回 $HOME。
 */
export function realHomeDir(): string {
  try {
    return userInfo().homedir || homedir();
  } catch {
    return homedir();
  }
}

/** DIY_HOME 的展示形式：相对真实家目录缩 `~`；隔离/临时数据根照实显示绝对路径 */
export function homeDisplayOf(diyHome: string): string {
  return abbrevHome(diyHome, realHomeDir());
}

/** 当前代码所在仓库的展示路径：worktree 也显示为它自己的具体目录。 */
export function repoDisplayOf(startDir: string = HERE): string {
  const root = findGitRoot(startDir);
  return root ? abbrevHome(root, realHomeDir()) : "?";
}

// ── 开发态「入口自证」的共享判据 ──────────────────────────────
// 背景（##255）：GUI / serve 的**运行时变量会继承外层 shell**（agent 会话里常带
// DIY_HOME=~/.diy、DIY_CLI=<全局 diy>、DIY_ENV=production）。开发入口若原样透传，模型就会被
// 提示去操作生产数据根 / 敲另一个 checkout 的 CLI。判据集中在这里，保证各入口一致。

/** 生产数据根（发布态固定 ~/.diy）。用**真实**家目录（不读 $HOME）—— 测试/隔离实例会改写 $HOME。 */
export function prodDataHome(): string {
  return join(realHomeDir(), ".diy");
}

/** 该路径是否指向生产数据根 */
export function isProdDataHome(home: string): boolean {
  return resolve(home) === prodDataHome();
}

/** 是否显式放行生产数据根（`DIY_ALLOW_PROD_HOME=1`，与 diy.sh 同一个开关） */
export function prodHomeAllowed(): boolean {
  return process.env["DIY_ALLOW_PROD_HOME"] === "1";
}

/**
 * 非打包运行时的 CLI 入口自证：入口须与**数据根匹配**。
 *   数据根 = 生产根          → `"diy"`（PATH 上的生产入口）
 *   数据根 = 隔离/开发/测试  → `<repo>/diy.sh`
 *
 * 只在 `DIY_CLI` **未注入**时用（`||=`）：入口脚本已注入时以其为准。
 * 曾是**无条件覆盖**（##255 R5），那会误伤生产 GUI —— `bin/diy` 注入的 `$0`（生产入口）被改成
 * `<repo>/diy.sh`（数据根 build/home），模型于是去敲一个连不上当前实例的入口。
 */
export function cliEntryForRepo(repoRoot: string, home: string): string {
  return isProdDataHome(home) ? "diy" : join(repoRoot, "diy.sh");
}

/**
 * 从 startDir 向上找含 .git 的目录（即本 checkout 的仓库根）；找不到 → null。
 * worktree 里 `.git` 是**文件**，故只判存在性、不判类型。
 *
 * 用途之一：非打包运行时**自证** CLI 入口（<repo>/diy.sh），不靠环境变量继承（见 main/index.ts）。
 */
export function findRepoRoot(startDir: string): string | null {
  return findGitRoot(startDir);
}

function findGitRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // 到文件系统根
    dir = parent;
  }
}

/** 跑一次 git 取字符串；git 不存在 / 不是仓库 / 超时 / 非零退出 → null（都当「拿不到」） */
function git(dir: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"], // stderr 丢弃：非仓库时 git 会刷屏
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * 当前运行代码所在 git 分支；detached HEAD → `<短 sha>(detached)`；拿不到 → null。
 *
 * 结果进程内缓存：标题会在端口就绪后重算，不该每次都 fork git。
 * 生产（asar 内无 .git）与 serve 部署目录同理回 null，标题里就不出现分支段。
 */
let branchCache: string | null | undefined;

export function currentGitBranch(startDir: string = HERE): string | null {
  if (branchCache === undefined) branchCache = detectBranch(startDir);
  return branchCache;
}

/** 仅供测试：清空缓存（生产不需要 —— 分支在一次进程生命周期内不变） */
export function resetGitBranchCache(): void {
  branchCache = undefined;
}

function detectBranch(startDir: string): string | null {
  const root = findGitRoot(startDir);
  if (!root) return null;
  const head = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!head) return null;
  if (head !== "HEAD") return head; // 正常分支（worktree 也是分支名）
  const sha = git(root, ["rev-parse", "--short", "HEAD"]);
  return sha ? `${sha}(detached)` : null;
}
