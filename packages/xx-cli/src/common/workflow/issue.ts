import { ghIssueCreate, ghIssueList } from "./github.js";
import { gitWorktreeAdd, gitPushUpstream } from "./git.js";
import { getMainBranch } from "./helpers.js";
import { logger } from "../logger.js";

const log = logger.withTag("issue");

export class IssueWorkflow {
  constructor(private repo: string) {}

  /** 创建新 issue */
  async new_issue(description: string): Promise<number> {
    const num = ghIssueCreate(description, description, this.repo);
    log.success(`成功: 创建 issue #${num}`);
    return num;
  }

  /** 开始开发：创建 worktree + 推送 */
  async dev(num: number, branchName?: string): Promise<void> {
    const mainBranch = getMainBranch();
    const branch = branchName ? `${num}-${branchName}` : `${num}`;

    gitWorktreeAdd(branch, mainBranch);
    gitPushUpstream(branch);

    log.success(`成功: 创建 worktree .worktree/${branch}`);
    log.success(`分支: ${branch}`);
    log.info(`cd .worktree/${branch} 开始开发`);
  }

  /** 列出当前仓库的 open issue */
  async list(labels?: string): Promise<void> {
    const issues = ghIssueList(this.repo, "open", labels);
    if (issues.length === 0) {
      log.info("没有 open issue");
      return;
    }

    // 简单表格输出（后续可用 xx-tui 美化）
    console.log("Issue    State   Created             Author       Title");
    console.log("-----    -----   -------             ------       -----");
    for (const issue of issues) {
      const num = `#${issue.number}`.padEnd(8);
      const state = (issue.state || "-").padEnd(7);
      const created = (issue.createdAt?.slice(0, 10) || "-").padEnd(18);
      const author = ((issue.author as any)?.login || "-").padEnd(12);
      console.log(`${num} ${state} ${created} ${author} ${issue.title}`);
    }
  }
}
