import type { WorktreeInfo } from "./types.js";
import { run, getMainBranch } from "./helpers.js";

const WORKTREE_DIR = ".worktree";

/** 解析 git worktree list 输出 */
export function gitWorktreeList(cwd?: string): WorktreeInfo[] {
  const mainBranch = getMainBranch(cwd);
  const raw = run("git worktree list", cwd);
  const lines = raw.split("\n");
  const result: WorktreeInfo[] = [];

  for (const line of lines) {
    // 格式: /path/to/worktree  abc123 [branch-name]
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;

    const fullPath = parts[0];
    // branch 在 [] 中，可能跨多个空格
    const bracketMatch = line.match(/\[(.+?)\]/);
    const branch = bracketMatch ? bracketMatch[1].trim() : "";

    // 缩短路径
    const cwdRoot = cwd ?? process.cwd();
    let shortPath = fullPath;
    if (fullPath === cwdRoot) {
      shortPath = ".";
    } else if (fullPath.startsWith(cwdRoot + "/")) {
      shortPath = fullPath.slice(cwdRoot.length + 1);
    }

    // 检查 ahead/behind
    let ahead = 0;
    if (branch && branch !== mainBranch) {
      try {
        ahead = Number(
          run(`git rev-list --count "${mainBranch}..${branch}"`, cwd).trim()
        );
      } catch { /* 分支不存在 */ }
    }

    // 检查是否有未提交变更
    let hasUncommitted = false;
    try {
      const statusOut = run("git status --porcelain", fullPath);
      if (statusOut.trim()) hasUncommitted = true;
    } catch { /* 目录不存在 */ }

    const isPrunable = branch === "";

    result.push({
      path: fullPath,
      shortPath,
      branch,
      branchDisplay: branch + (hasUncommitted ? "*" : ""),
      ahead,
      isPrunable,
    });
  }

  return result;
}

/** 创建 worktree */
export function gitWorktreeAdd(branch: string, baseBranch: string, cwd?: string): string {
  const worktreePath = `${WORKTREE_DIR}/${branch}`;
  run(`git worktree add -b "${branch}" "${worktreePath}" "${baseBranch}"`, cwd);
  return worktreePath;
}

/** 删除 worktree */
export function gitWorktreeRemove(worktreePath: string, cwd?: string): void {
  run(`git worktree remove "${worktreePath}"`, cwd);
}

/** 强制删除分支 */
export function gitBranchDeleteForce(branch: string, cwd?: string): void {
  run(`git branch -D "${branch}"`, cwd);
}

/** 切换分支 */
export function gitCheckout(branch: string, cwd?: string): void {
  run(`git checkout "${branch}"`, cwd);
}

/** 拉取最新 */
export function gitPull(cwd?: string): void {
  run("git pull", cwd);
}

/** 推送并设置上游 */
export function gitPushUpstream(branch: string, cwd?: string): void {
  run(`git push -u origin "${branch}"`, cwd);
}

/** 推送当前分支 */
export function gitPush(cwd?: string): void {
  run("git push", cwd);
}
