"""dev work prune - 清理所有已完成合并的工作项

扫描所有 worktree，找出其分支对应 PR 已 MERGED 的项，
删除本地/远程分支和 worktree，完成清理。
"""

import re
from dataclasses import dataclass

from cyclopts import App, Parameter
from typing import Annotated

from .git_ops import (
    run,
    get_main_branch,
    get_github_repo,
    git_worktree_remove,
    git_branch_delete_force,
    git_branch_delete_remote,
)
from .gh_ops import gh_pr_list_by_branch
from .config import WORKTREE_DIR

prune_app = App(name="prune", help="清理已完成合并的 worktree 和分支")


@dataclass
class _PruneTarget:
    """待清理的工作项"""
    branch: str
    worktree_path: str
    pr_number: int
    pr_state: str


def _scan_prunable(repo: str) -> list[_PruneTarget]:
    """扫描所有 worktree，返回 PR 已 MERGED 的待清理列表"""
    main_branch = get_main_branch()
    raw = run("git worktree list")
    targets: list[_PruneTarget] = []
    cwd_root = run("pwd")

    for line in raw.split("\n"):
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 3:
            continue

        full_path = parts[0]
        bracket_match = re.search(r"\[(.+?)\]", line)
        branch = bracket_match.group(1).strip() if bracket_match else ""

        # 跳过主分支和空分支（prunable worktree）
        if not branch or branch == main_branch:
            continue

        # 查询 PR 状态（合并后的 PR 需要 --state merged）
        pr = gh_pr_list_by_branch(repo, branch, state="merged")
        if not pr:
            continue

        if pr.get("state") != "MERGED":
            continue

        # 构建 worktree 路径
        if full_path == cwd_root:
            wt_path = "."
        elif full_path.startswith(cwd_root + "/"):
            wt_path = full_path[len(cwd_root) + 1:]
        else:
            wt_path = full_path

        targets.append(_PruneTarget(
            branch=branch,
            worktree_path=wt_path,
            pr_number=pr["number"],
            pr_state=pr["state"],
        ))

    return targets


@prune_app.default
def work_prune(
    dry_run: Annotated[bool, Parameter(
        name=["--dry-run", "-n"],
        help="仅列出待清理项，不实际执行",
    )] = False,
    yes: Annotated[bool, Parameter(
        name=["--yes", "-y"],
        help="跳过确认，直接清理",
    )] = False,
):
    """清理所有 PR 已合并的工作项（删除本地/远程分支及 worktree）。

    扫描所有 worktree，找出对应 PR 状态为 MERGED 的项并统一清理。
    默认会列出待清理项并请求确认。

    示例:
      dev work prune            # 列出并确认后清理
      dev work prune -n         # 仅预览，不执行
      dev work prune -y         # 直接清理，跳过确认
    """
    repo = get_github_repo()
    targets = _scan_prunable(repo)

    if not targets:
        print("没有需要清理的工作项")
        return

    # 列出待清理项
    print("待清理的工作项 (PR 已合并):\n")
    for t in targets:
        print(f"  分支: {t.branch}")
        print(f"   PR:  #{t.pr_number} ({t.pr_state})")
        print(f"   WT:  {t.worktree_path}")
        print()

    if dry_run:
        print(f"[dry-run] 共 {len(targets)} 项，未执行清理")
        return

    # 确认
    if not yes:
        try:
            answer = input(f"确认清理以上 {len(targets)} 项? [y/N]: ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print("\n已取消")
            return
        if answer != "y":
            print("已取消")
            return

    # 执行清理
    cleaned = 0
    errors = 0
    for t in targets:
        print(f"\n清理: {t.branch} (PR #{t.pr_number})")

        # 删除远程分支
        try:
            git_branch_delete_remote(t.branch)
            print(f"  ✓ 删除远程分支 origin/{t.branch}")
        except RuntimeError as e:
            print(f"  ✗ 删除远程分支失败: {e}")
            errors += 1

        # 删除 worktree
        try:
            git_worktree_remove(t.worktree_path)
            print(f"  ✓ 删除 worktree {t.worktree_path}")
        except RuntimeError as e:
            print(f"  ✗ 删除 worktree 失败: {e}")
            errors += 1

        # 删除本地分支
        try:
            git_branch_delete_force(t.branch)
            print(f"  ✓ 删除本地分支 {t.branch}")
        except RuntimeError as e:
            print(f"  ✗ 删除本地分支失败: {e}")
            errors += 1

        cleaned += 1

    print(f"\n完成: 清理 {cleaned} 项", end="")
    if errors:
        print(f"  ({errors} 个错误)")
    else:
        print()
