/** worktree 信息 */
export interface WorktreeInfo {
  path: string;
  shortPath: string;
  branch: string;
  branchDisplay: string;
  ahead: number;
  isPrunable: boolean;
}

/** issue 基本信息，只读 GitHub issue 自身字段，不做 project 假设 */
export interface IssueInfo {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  url: string;
  createdAt: string;
  author: string;
}

/** PR 信息 */
export interface PRInfo {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  url: string;
  mergeable: string;
  headRefName: string;
}

/** worktree 列表行（合并了 issue + PR 信息） */
export interface WorktreeRow {
  worktree: WorktreeInfo;
  issue?: IssueInfo;
  pr?: PRInfo;
}

/** 合并策略 */
export type MergeMethod = "merge" | "squash" | "rebase";
