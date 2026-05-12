import { getGitHubRepo } from "./helpers.js";
import { IssueWorkflow } from "./issue.js";
import { DevWorkflow } from "./dev.js";

export interface Workflow {
  issue: IssueWorkflow;
  dev: DevWorkflow;
  repo: string;
}

/** 创建工作流实例，自动从 git remote 获取 owner/repo */
export function createWorkflow(cwd?: string): Workflow {
  const { owner, repo: repoName } = getGitHubRepo(cwd);
  const repo = `${owner}/${repoName}`;
  return {
    issue: new IssueWorkflow(repo),
    dev: new DevWorkflow(repo),
    repo,
  };
}

export type { WorktreeInfo, IssueInfo, PRInfo, WorktreeRow, MergeMethod } from "./types.js";
export { IssueWorkflow } from "./issue.js";
export { DevWorkflow } from "./dev.js";
