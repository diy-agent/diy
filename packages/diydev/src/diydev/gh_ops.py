"""GitHub CLI 操作工具函数"""

import json
import re
from typing import Optional, Any

from .git_ops import run


def gh_issue_list(repo: str, state: str = "open", limit: int = 50, labels: Optional[str] = None) -> list[dict[str, Any]]:
    """列出 GitHub issues"""
    cmd = f"gh issue list --repo {repo} --state {state} --json number,title,state,url,createdAt,author --limit {limit}"
    if labels:
        cmd += f' --label "{labels}"'
    raw = run(cmd)
    return json.loads(raw)


def gh_issue_view(num: int, repo: str, fields: str = "number,title,state,url,createdAt,author") -> dict[str, Any]:
    """查看单个 issue 详情"""
    raw = run(f"gh issue view {num} --repo {repo} --json {fields}")
    return json.loads(raw)


def gh_issue_create(title: str, body: str, repo: str) -> int:
    """创建 GitHub issue，返回 issue 编号"""
    url = run(
        f'gh issue create --repo {repo} --title "{title}" --body "{body}"'
    ).strip()
    m = re.search(r"(\d+)$", url)
    if not m:
        raise RuntimeError(f"无法解析 issue URL: {url}")
    return int(m.group(1))


def gh_pr_list_by_branch(repo: str, branch: str, state: Optional[str] = None) -> Optional[dict[str, Any]]:
    """查询指定分支是否有 PR，返回第一个匹配的或 None"""
    try:
        cmd = f'gh pr list --repo {repo} --head "{branch}" --json number,title,state,url,mergeable,headRefName,isDraft --limit 1'
        if state:
            cmd += f" --state {state}"
        raw = run(cmd)
        prs = json.loads(raw)
        return prs[0] if prs else None
    except RuntimeError:
        return None


def gh_all_prs_map(repo: str) -> dict[str, dict[str, Any]]:
    """获取所有 PR 的映射（headRefName -> PR info），包括 open 和 merged。

    优先用 open 状态的结果，再用 merged 补充。
    """
    result: dict[str, dict[str, Any]] = {}
    try:
        cmd = f"gh pr list --repo {repo} --state open --json number,title,state,url,mergeable,headRefName,isDraft --limit 100"
        raw = run(cmd)
        for pr in json.loads(raw):
            result[pr["headRefName"]] = pr
    except RuntimeError:
        pass
    try:
        cmd = f"gh pr list --repo {repo} --state merged --json number,title,state,url,mergeable,headRefName,isDraft --limit 100"
        raw = run(cmd)
        for pr in json.loads(raw):
            # 不覆盖已有的 open PR 记录
            if pr["headRefName"] not in result:
                result[pr["headRefName"]] = pr
    except RuntimeError:
        pass
    return result


def gh_pr_list(repo: str, head: Optional[str] = None, state: Optional[str] = None) -> list[dict[str, Any]]:
    """列出 PR，可按分支和状态过滤"""
    cmd = f"gh pr list --repo {repo} --json number,title,state,url,mergeable,headRefName,isDraft --limit 100"
    if head:
        cmd += f' --head "{head}"'
    if state:
        cmd += f" --state {state}"
    raw = run(cmd)
    return json.loads(raw)


def gh_pr_create(repo: str, base: str, head: str, title: str, body: str) -> int:
    """创建 PR，返回 PR 编号"""
    url = run(
        f'gh pr create --repo {repo} --base "{base}" --head "{head}" --title "{title}" --body "{body}"'
    ).strip()
    m = re.search(r"(\d+)$", url)
    if not m:
        raise RuntimeError(f"无法解析 PR URL: {url}")
    return int(m.group(1))


def gh_pr_merge(pr_num: int, repo: str, method: str) -> None:
    """合并 PR"""
    run(f"gh pr merge {pr_num} --repo {repo} --{method}")


def gh_pr_ready(pr_num: int, repo: str) -> None:
    """将草稿 PR 标记为 Ready for review"""
    run(f"gh pr ready {pr_num} --repo {repo}")


def gh_issue_comment(num: int, body: str, repo: str) -> None:
    """对 issue 发表评论"""
    run(f'gh issue comment {num} --repo {repo} --body "{body}"')


def gh_issue_close(num: int, repo: str) -> None:
    """关闭 issue"""
    run(f"gh issue close {num} --repo {repo}")


def gh_repo_merge_method(repo: str) -> str:
    """获取仓库允许的合并策略，逗号分隔"""
    try:
        merge_commit = run(f"gh api repos/{repo} --jq .allow_merge_commit")
        squash = run(f"gh api repos/{repo} --jq .allow_squash_merge")
        rebase = run(f"gh api repos/{repo} --jq .allow_rebase_merge")
        methods = []
        if json.loads(merge_commit):
            methods.append("merge")
        if json.loads(squash):
            methods.append("squash")
        if json.loads(rebase):
            methods.append("rebase")
        return ",".join(methods) or "squash"
    except RuntimeError:
        return "squash"
