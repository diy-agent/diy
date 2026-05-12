import { run } from "./helpers.js";

/** Issue 相关 GitHub CLI 操作 */
export function ghIssueView(num: number, repo: string, fields: string): any {
  const raw = run(`gh issue view ${num} --repo ${repo} --json ${fields}`);
  return JSON.parse(raw);
}

export function ghIssueCreate(title: string, body: string, repo: string): number {
  const url = run(`gh issue create --repo ${repo} --title "${title}" --body "${body}"`).trim();
  // 提取末尾编号
  const m = url.match(/(\d+)$/);
  if (!m) throw new Error(`无法解析 issue URL: ${url}`);
  return Number(m[1]);
}

export function ghIssueList(repo: string, state: string, labels?: string): any[] {
  let cmd = `gh issue list --repo ${repo} --state ${state} --json number,title,state,url,createdAt,author --limit 100`;
  if (labels) cmd += ` --label "${labels}"`;
  const raw = run(cmd);
  return JSON.parse(raw);
}

/** PR 相关 GitHub CLI 操作 */
export function ghPrList(repo: string, head?: string, state?: string): any[] {
  let cmd = `gh pr list --repo ${repo} --json number,title,state,url,mergeable,headRefName --limit 100`;
  if (head) cmd += ` --head "${head}"`;
  if (state) cmd += ` --state ${state}`;
  const raw = run(cmd);
  return JSON.parse(raw);
}

export function ghPrCreate(
  repo: string, base: string, head: string, title: string, body: string
): number {
  const url = run(
    `gh pr create --repo ${repo} --base "${base}" --head "${head}" --title "${title}" --body "${body}"`
  ).trim();
  const m = url.match(/(\d+)$/);
  if (!m) throw new Error(`无法解析 PR URL: ${url}`);
  return Number(m[1]);
}

export function ghPrMerge(prNum: number, repo: string, method: string): string {
  return run(`gh pr merge ${prNum} --repo ${repo} --${method}`);
}

export function ghRepoMergeMethod(repo: string): string {
  try {
    const raw = run(`gh api repos/${repo} --jq .allow_merge_commit`);
    const squash = run(`gh api repos/${repo} --jq .allow_squash_merge`);
    const rebase = run(`gh api repos/${repo} --jq .allow_rebase_merge`);
    const methods: string[] = [];
    if (JSON.parse(raw)) methods.push("merge");
    if (JSON.parse(squash)) methods.push("squash");
    if (JSON.parse(rebase)) methods.push("rebase");
    return methods.join(",") || "squash";
  } catch {
    return "squash";
  }
}
