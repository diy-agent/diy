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

/** 本文件所在目录（打包后 = out/main，源码直跑 = src/main/core），git 探测的起点 */
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

/** 从 startDir 向上找含 .git 的目录。worktree 里 `.git` 是**文件**，故只判存在性、不判类型 */
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
