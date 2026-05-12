import { execSync } from "node:child_process";
import { logger } from "../logger.js";

const log = logger.withTag("workflow");

/** 执行 shell 命令，打印命令和输出，遇错抛异常 */
export function run(cmd: string, cwd?: string): string {
  log.debug("▶", cmd);
  try {
    const result = execSync(cmd, {
      encoding: "utf-8",
      cwd,
      stdio: ["inherit", "pipe", "pipe"],
      timeout: 30_000,
    });
    const stdout = result.trimEnd();
    if (stdout) log.debug("◀", stdout.slice(0, 200));
    return stdout;
  } catch (err: any) {
    const stderr = err.stderr?.trimEnd() || "";
    log.error("✕", cmd);
    if (stderr) log.error(stderr.slice(0, 500));
    throw new Error(`命令执行失败: ${cmd}\n${stderr}`);
  }
}

/** 从 git remote 自动获取 owner/repo */
export function getGitHubRepo(cwd?: string): { owner: string; repo: string } {
  const url = run("git remote get-url origin", cwd);
  // 支持 https://github.com/owner/repo.git 和 git@github.com:owner/repo.git
  const m = url.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
  if (!m) {
    throw new Error(`无法从 git remote 解析 GitHub 仓库: ${url}`);
  }
  return { owner: m[1], repo: m[2] };
}

/** 获取主分支名（main 或 master） */
export function getMainBranch(cwd?: string): string {
  try {
    run("git show-ref --verify --quiet refs/heads/main", cwd);
    return "main";
  } catch {
    try {
      run("git show-ref --verify --quiet refs/heads/master", cwd);
      return "master";
    } catch {
      return "main";
    }
  }
}

/** 从分支名提取 issue 编号（兼容 42-feat-name / issue-42 / 42） */
export function parseIssueNumber(branch: string): number | undefined {
  let m: RegExpMatchArray | null;
  m = branch.match(/^(\d+)-/);
  if (m) return Number(m[1]);
  m = branch.match(/^issue-(\d+)$/);
  if (m) return Number(m[1]);
  m = branch.match(/^(\d+)$/);
  if (m) return Number(m[1]);
  return undefined;
}

/** 获取当前分支名 */
export function getCurrentBranch(cwd?: string): string {
  return run("git branch --show-current", cwd).trim();
}

/** 获取两个分支的 merge-base */
export function getMergeBase(branch1: string, branch2: string, cwd?: string): string {
  return run(`git merge-base "${branch1}" "${branch2}"`, cwd).trim();
}
