"""Git 操作工具函数"""

import subprocess
import re
from typing import Optional

from ._config import WORKTREE_DIR
from ._log import info, debug


def run(cmd: str, cwd: Optional[str] = None) -> str:
    """执行 shell 命令，返回 stdout。失败时抛出 RuntimeError。"""
    info(f"$ {cmd}")
    try:
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip())
        output = result.stdout.strip()
        if output:
            debug(output)
        return output
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"命令超时: {cmd}")


def get_main_branch() -> str:
    """获取主分支名（main 或 master）"""
    for branch in ("main", "master"):
        try:
            run(f"git show-ref --verify --quiet refs/heads/{branch}")
            return branch
        except RuntimeError:
            continue
    return "main"


def get_github_repo() -> str:
    """从 git remote 自动获取 owner/repo"""
    url = run("git remote get-url origin")
    m = re.search(r"github\.com[:/](.+?)/(.+?)(?:\.git)?$", url)
    if not m:
        raise RuntimeError(f"无法从 git remote 解析 GitHub 仓库: {url}")
    return f"{m.group(1)}/{m.group(2)}"


def parse_issue_number(branch: str) -> Optional[int]:
    """从分支名提取 issue 编号

    兼容格式:
      - 42-feat-name
      - issue-42
      - 42
    """
    m = re.match(r"^(\d+)-", branch)
    if m:
        return int(m.group(1))
    m = re.match(r"^issue-(\d+)$", branch)
    if m:
        return int(m.group(1))
    m = re.match(r"^(\d+)$", branch)
    if m:
        return int(m.group(1))
    return None


def git_worktree_add(branch: str, base_branch: str, cwd: Optional[str] = None) -> str:
    """创建 worktree 并切换到新分支"""
    worktree_path = f"{WORKTREE_DIR}/{branch}"
    run(f'git worktree add -b "{branch}" "{worktree_path}" "{base_branch}"', cwd)
    return worktree_path


def git_push_upstream(branch: str, cwd: Optional[str] = None) -> None:
    """推送分支并设置 upstream"""
    run(f'git push -u origin "{branch}"', cwd)


def git_push(cwd: Optional[str] = None) -> None:
    """推送当前分支"""
    run("git push", cwd)


def git_pull(cwd: Optional[str] = None) -> None:
    """拉取最新"""
    run("git pull", cwd)


def get_current_branch(cwd: Optional[str] = None) -> str:
    """获取当前分支名"""
    return run("git branch --show-current", cwd)


def get_merge_base(branch1: str, branch2: str, cwd: Optional[str] = None) -> str:
    """获取两个分支的 merge-base"""
    return run(f'git merge-base "{branch1}" "{branch2}"', cwd)


def git_worktree_remove(worktree_path: str, cwd: Optional[str] = None) -> None:
    """删除 worktree"""
    run(f'git worktree remove "{worktree_path}" --force', cwd)


def git_branch_delete_force(branch: str, cwd: Optional[str] = None) -> None:
    """强制删除本地分支"""
    run(f'git branch -D "{branch}"', cwd)


def git_branch_delete_remote(branch: str, cwd: Optional[str] = None) -> None:
    """删除远程分支"""
    run(f'git push origin --delete "{branch}"', cwd)
