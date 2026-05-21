import { getGitHubRepo } from "./helpers.js";
import { IssueFlow } from "./issue.js";
import { DevFlow } from "./dev.js";

export interface Flow {
  issue: IssueFlow;
  dev: DevFlow;
  repo: string;
}

/** 创建流程实例，自动从 git remote 获取 owner/repo */
export function createFlow(cwd?: string): Flow {
  const { owner, repo: repoName } = getGitHubRepo(cwd);
  const repo = `${owner}/${repoName}`;
  return {
    issue: new IssueFlow(repo),
    dev: new DevFlow(repo),
    repo,
  };
}

export type { WorktreeInfo, IssueInfo, PRInfo, WorktreeRow, MergeMethod } from "./types.js";
export { IssueFlow } from "./issue.js";
export { DevFlow } from "./dev.js";
