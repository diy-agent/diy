"""dev work merge-pr - 合并当前分支的 PR，支持交互式选择合并策略"""

from cyclopts import App, Parameter
from typing import Annotated, Optional

from ._log import VerboseFlag, set_verbosity
from ._git_ops import get_main_branch, get_current_branch, get_github_repo
from ._gh_ops import (
    gh_pr_list,
    gh_pr_merge,
    gh_pr_ready,
    gh_repo_merge_method,
)

merge_pr_app = App(name="merge-pr", help="合并当前分支的 PR")


# 合并策略的 ASCII 示意图
MERGE_METHOD_DIAGRAM: dict[str, str] = {
    "merge": (
        "Merge（合并提交）\n"
        "\n"
        "  PR 合并前:\n"
        "    main:  A---B---C\n"
        "             \\\n"
        "    分支:     D---E---F\n"
        "\n"
        "  PR 合并后:\n"
        "    main:  A---B---C-------M\n"
        "             \\             /\n"
        "    分支:     D---E---F---\n"
        "\n"
        "  保留完整分支历史，M 是新的 merge commit\n"
        "  原始命令: git checkout main && git merge 分支"
    ),
    "squash": (
        "Squash（压缩合并）\n"
        "\n"
        "  PR 合并前:\n"
        "    main:  A---B---C\n"
        "             \\\n"
        "    分支:     D---E---F\n"
        "\n"
        "  PR 合并后:\n"
        "    main:  A---B---C---S       ← S 是新 commit\n"
        "    分支:     D---E---F        ← 这 3 个仍在分支上\n"
        "\n"
        "  历史简洁，但丢失 commit 身份 → 会导致后续 PR 冲突\n"
        "  原始命令: git checkout main && git merge --squash 分支 && git commit"
    ),
    "rebase": (
        "Rebase（变基合并）\n"
        "\n"
        "  PR 合并前:\n"
        "    main:  A---B---C\n"
        "             \\\n"
        "    分支:     D---E---F\n"
        "\n"
        "  PR 合并后:\n"
        "    main:  A---B---C---D'--E'--F'   ← 线性历史\n"
        "    分支:     D---E---F             ← 旧 commit 需手动同步\n"
        "\n"
        "  线性干净，commit 独立保留 → 推荐，不会导致后续冲突\n"
        "  原始命令: git checkout 分支 && git rebase main && git checkout main && git merge 分支"
    ),
}


@merge_pr_app.default
def work_merge_pr(
    verbose: VerboseFlag = 0,
    method: Annotated[
        Optional[str],
        Parameter(
            name=["--method", "-m"],
            help="合并策略: merge | squash | rebase（未指定则交互选择）",
        ),
    ] = None,
    ready: Annotated[
        bool,
        Parameter(
            name=["--ready", "-r"],
            help="草稿 PR 自动转换为 Ready for review 后再合并",
        ),
    ] = False,
):
    """合并当前分支的 Pull Request。

    如果未通过 --method 指定合并策略，将显示交互式选择器。
    草稿 PR 无法合并，可通过 --ready 自动转换状态后再合并。
    """
    set_verbosity(verbose)
    branch = get_current_branch()
    main_branch = get_main_branch()
    repo = get_github_repo()

    if branch == main_branch:
        print("错误: 请在 worktree 分支执行，不能在主分支")
        return

    prs = gh_pr_list(repo, head=branch, state="open")
    if not prs:
        print(f'错误: 分支 "{branch}" 没有 open PR')
        return

    pr = prs[0]
    pr_num = pr["number"]

    # 预检冲突
    if pr.get("mergeable") == "CONFLICTING":
        print(f"错误: PR #{pr_num} 与 {main_branch} 有冲突，请先解决冲突")
        print(f"\n  页面操作: {pr['url']}")
        print("\n  手工命令:")
        print("    git fetch origin")
        print(f"    git rebase origin/{main_branch}")
        print("    # 解决冲突后:")
        print("    git add .")
        print("    git rebase --continue")
        print("    git push --force-with-lease")
        print("\n  解决后重新执行: dev work merge-pr")
        return

    # 预检草稿状态
    if pr.get("isDraft"):
        if ready:
            # --ready 指定时直接转换
            print(f"PR #{pr_num} 为草稿状态，正在转换为 Ready for review...")
            gh_pr_ready(pr_num, repo)
            print("已转换为 Ready for review\n")
        else:
            # 未指定时交互式选择
            print(f"PR #{pr_num} 为草稿状态，无法直接合并\n")
            print("选择操作:")
            print("  [1] 转换为 Ready for review 后继续合并")
            print("  [q] 取消")
            print()
            try:
                choice = input("请输入编号 [取消: q]: ").strip().lower()
                if choice != "1":
                    print("已取消合并")
                    return
            except (ValueError, EOFError):
                print("已取消合并")
                return

            print("\n正在转换为 Ready for review...")
            gh_pr_ready(pr_num, repo)
            print("已转换为 Ready for review\n")

    # 确定合并策略
    if method:
        if method not in ("merge", "squash", "rebase"):
            print(f"错误: 不支持的合并策略 '{method}'，可选: merge, squash, rebase")
            return
    else:
        available = gh_repo_merge_method(repo)
        methods = available.split(",")
        if len(methods) == 1:
            method = methods[0]
        else:
            # 交互式选择
            print(f"PR #{pr_num}: {pr.get('title', '-')}")
            print("\n选择合并策略:\n")
            for i, m in enumerate(methods):
                print(f"  [{i + 1}] {m}")
            print()
            # 打印当前 PR 信息
            print(f"  可合并: {pr.get('mergeable', 'UNKNOWN')}")
            print()

            try:
                choice = input(
                    "请输入编号 (1-" + str(len(methods)) + ") [取消: q]: "
                ).strip()
                if choice.lower() == "q":
                    print("已取消合并")
                    return
                idx = int(choice) - 1
                if idx < 0 or idx >= len(methods):
                    print("错误: 无效选择")
                    return
                method = methods[idx]
            except (ValueError, EOFError):
                print("错误: 无效输入")
                return

            # 显示示意图
            print()
            diagram = MERGE_METHOD_DIAGRAM.get(method, "")
            print(diagram)
            print()
            confirm = input("确认执行? [Y/n]: ").strip().lower()
            if confirm and confirm != "y":
                print("已取消合并")
                return

    # 执行合并
    gh_pr_merge(pr_num, repo, method)
    print(f"成功: PR #{pr_num} 已合并 ({method})")
