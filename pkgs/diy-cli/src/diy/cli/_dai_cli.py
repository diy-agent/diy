"""dai CLI — diy agent 接口

命令:
  dai task ...         任务 CRUD（star/unstar/list/show/create/edit/delete/link/unlink/sync）
  dai subject ...      subject 树管理（add/list/tree/show/remove/scan）
  dai profile ...      profile 预设管理
  dai ui ...           UI 交互（tree/status/agents/node/reload/title/notify/metrics/shutdown/chat）
  dai doctor           健康自检
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import sys
from pathlib import Path
from typing import Annotated, Any

import yaml
from cyclopts import App, Parameter

from diy.core._dai_scan import find_spaces, find_workspace_root
from diy.core._state import (
    _norm,
    _subject_is_git,
    create_task,
    delete_task,
    diy_home,
    get_task,
    is_starred,
    list_starred,
    list_tasks,
    load_state,
    save_state,
    star_task,
    unstar_task,
    update_task_field,
)

app = App(
    name="dai",
    help="diy agent 接口 — state 查询与同步",
    version_flags=[],
)


# ════════════════════════════════════════════════════════════════
# dai restart / shutdown — 生命周期类，本地执行
# ════════════════════════════════════════════════════════════════


@app.command
def restart():
    """重启管控台。"""
    _app_restart()


@app.command
def shutdown():
    """关闭管控台。"""
    _local_shutdown()


# ════════════════════════════════════════════════════════════════
# dai doctor — 健康自检（走 socket，本地仅提供 help）
# ════════════════════════════════════════════════════════════════


@app.command(name="doctor")
def doctor_cmd():
    """分层健康自检 — app 状态 / socket / state.yaml。"""
    # 实际由 main() 转发到 socket，本函数仅用于 help

    from diy.cli._forward import forward_to_app

    forward_to_app(["diy", "doctor"])


# ════════════════════════════════════════════════════════════════
# dai ui — 管控台 UI 接口（走 socket，本地仅提供 help）
# ════════════════════════════════════════════════════════════════


ui_app = App(
    name="ui",
    help="管控台 UI 接口 — 走 socket 透传到桌面 app",
)
# ⚠️ 双注册：这里注册的 UI 命令必须同步在 app/main.py GatewayCLI 注册。


@ui_app.command(name="status")
def ui_status():
    """健康检查（pid/窗口/树/定时器）。"""
    from diy.cli._forward import forward_to_app

    forward_to_app(["diy", "ui", "status"])


@ui_app.command(name="tree")
def ui_tree():
    """完整任务树。"""
    from diy.cli._forward import forward_to_app

    forward_to_app(["diy", "ui", "tree"])


@ui_app.command(name="agents")
def ui_agents():
    """agent 列表。"""
    from diy.cli._forward import forward_to_app

    forward_to_app(["diy", "ui", "agents"])


app.command(ui_app)


# ════════════════════════════════════════════════════════════════
# dai scan
# ════════════════════════════════════════════════════════════════


@app.command
def scan(
    json_output: Annotated[
        bool,
        Parameter(name=["--json"], help="JSON 格式输出"),
    ] = False,
    path: Annotated[
        str | None,
        Parameter(help="扫描起始目录（默认当前工作目录）"),
    ] = None,
):
    """扫描 workspace 与 spaces — 向上查找 diy.yaml，向下发现 .git。"""
    start = os.path.realpath(path) if path else os.path.realpath(os.getcwd())

    workspace_root = find_workspace_root(start)
    if workspace_root is None:
        print("错误: 未找到 diy.yaml（向上扫描到 $HOME 为止）", file=sys.stderr)
        sys.exit(1)

    spaces = find_spaces(workspace_root)

    result: dict = {
        "workspace": workspace_root,
        "spaces": spaces,
    }

    if json_output:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        yaml.dump(
            result,
            sys.stdout,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
            explicit_start=True,
        )


# ════════════════════════════════════════════════════════════════
# dai profile
# ════════════════════════════════════════════════════════════════

profile_app = App(
    name="profile",
    help="查询 state.yaml 中的 profile 预设",
)


@profile_app.command(name="list")
def list_profiles(
    json_output: Annotated[
        bool,
        Parameter(name=["--json"], help="JSON 格式输出"),
    ] = False,
):
    """列出所有 profile（YAML 默认，--json 切 JSON）。"""
    data = load_state()
    profiles = data.get("profiles", {})
    if json_output:
        print(json.dumps(profiles, indent=2, ensure_ascii=False))
    else:
        yaml.dump(
            profiles,
            sys.stdout,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
            explicit_start=True,
        )


@profile_app.command
def show(
    name: Annotated[str, Parameter(help="profile 名称")],
    json_output: Annotated[
        bool,
        Parameter(name=["--json"], help="JSON 格式输出"),
    ] = False,
):
    """查看单个 profile。"""
    data = load_state()
    profiles = data.get("profiles", {})
    if name not in profiles:
        print(f"错误: profile {shlex.quote(name)} 不存在", file=sys.stderr)
        sys.exit(1)
    profile_data = profiles[name]
    if json_output:
        print(json.dumps(profile_data, indent=2, ensure_ascii=False))
    else:
        yaml.dump(
            profile_data,
            sys.stdout,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
            explicit_start=True,
        )


# ════════════════════════════════════════════════════════════════
# dai subject
# ════════════════════════════════════════════════════════════════

subject_app = App(name="subject", help="Subject 树管理")

# ════════════════════════════════════════════════════════════════
# 辅助函数
# ════════════════════════════════════════════════════════════════


def _enrich(subjects: dict[str, dict]) -> dict[str, dict]:
    """给 subject 条目添加实时检测的 is_git 字段。"""
    return {p: {**entry, "is_git": _subject_is_git(p)} for p, entry in subjects.items()}


@subject_app.command(name="add")
def subject_add(
    path: Annotated[str, Parameter(help="subject 路径（如 ~/git/diy/_diy）")],
    desc: Annotated[str | None, Parameter(name="--desc", help="描述")] = None,
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
):
    """注册 subject。自动检测是否为 git 仓库。

    范例: dai subject add ~/git/diy/_diy
    注意: 路径必须是 git 仓库目录。
    """
    from diy.core.middleware import cli_call
    from diy.core.subject import add_subject

    cli_call(add_subject, path, desc=desc, json_output=json_output)


@subject_app.command(name="list")
def subject_list(
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
):
    """扁平列表（实时 is_git 检测）。

    范例: dai subject list
    """
    data = load_state()
    subjects = _enrich(data.get("subjects", {}))
    if json_output:
        print(json.dumps(subjects, indent=2, ensure_ascii=False))
    else:
        yaml.dump(
            subjects,
            sys.stdout,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )


@subject_app.command(name="tree")
def subject_tree(
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
):
    """树状展示（实时 is_git 检测）。

    范例: dai subject tree
    """
    data = load_state()
    subjects = _enrich(data.get("subjects", {}))

    tree = _build_subject_tree(subjects)
    if json_output:
        print(json.dumps(tree, indent=2, ensure_ascii=False))
    else:
        yaml.dump(
            tree,
            sys.stdout,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )


@subject_app.command(name="show")
def subject_show(
    path: Annotated[str, Parameter(help="subject 路径")],
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
):
    """查看单个 subject（含实时 is_git 检测）。"""
    from diy.core.middleware import cli_call
    from diy.core.subject import show_subject

    cli_call(show_subject, path, json_output=json_output)


@subject_app.command(name="remove")
def subject_remove(
    path: Annotated[str, Parameter(help="subject 路径")],
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
):
    """删除 subject。同时删除子 subject。"""
    from diy.core.middleware import cli_call
    from diy.core.subject import remove_subject

    cli_call(remove_subject, path, json_output=json_output)


@subject_app.command(name="scan")
def subject_scan(
    root: Annotated[str, Parameter(help="扫描根目录")],
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
):
    """扫描文件系统，发现 git 仓库作为 subject。"""
    root_path = os.path.abspath(os.path.expanduser(root))
    if not os.path.isdir(root_path):
        print(f"错误: 目录不存在 {shlex.quote(root)}", file=sys.stderr)
        sys.exit(1)

    found: dict[str, dict[str, object]] = {}
    for dirpath, dirs, _ in os.walk(root_path):
        if os.path.isdir(os.path.join(dirpath, ".git")) or os.path.isfile(
            os.path.join(dirpath, ".git")
        ):
            found[_norm(dirpath)] = {}
            dirs.clear()  # 不深入 git 仓库内部

    # 写入 state.yaml
    data = load_state()
    subjects = data.setdefault("subjects", {})
    subjects.update(found)
    save_state(data)

    result = {"status": "success", "data": {"found": len(found)}}
    if json_output:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        yaml.dump(
            result,
            sys.stdout,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )


def _build_subject_tree(subjects: dict[str, dict]) -> dict[str, object]:
    """从扁平 subject 字典构建嵌套树。"""
    sorted_paths = sorted(subjects.keys(), key=lambda p: (p.count("/"), p))
    tree: dict[str, object] = {}
    for path in sorted_paths:
        _place_in_tree(tree, path, dict(subjects[path]))
    return tree


def _place_in_tree(tree: dict[str, object], path: str, entry: dict) -> None:
    """递归在树中找 path 的父级并插入。"""
    # 找 path 的父级路径
    parent = "/".join(path.lstrip("~/").split("/")[:-1])
    if not parent:
        # 根级节点，直接挂 tree
        tree[path] = entry
        return
    parent_key = "~/" + parent

    # 在 tree 中找 parent_key（递归搜索所有层级）
    def _find(node: dict, target: str) -> dict | None:
        for k, v in node.items():
            if k == target and isinstance(v, dict):
                return v
            if isinstance(v, dict):
                children = v.get("children")
                if children:
                    result = _find(children, target)
                    if result:
                        return result
        return None

    parent_node = _find(tree, parent_key)
    if parent_node is not None:
        children = parent_node.setdefault("children", {})
        children[path] = entry
    else:
        # 父级不存在，挂在根
        tree[path] = entry


app.command(subject_app)


# ════════════════════════════════════════════════════════════════
# ═══════════════════════════════════════════════════════════════=
# dai task — 任务管理
#
# ⚠️ 双注册：这里注册的命令必须同步在 app/main.py GatewayCLI 注册。
# grep -rn '"diy task' src/ 确认两边一致。
# ════════════════════════════════════════════════════════════════

task_app = App(name="task", help="任务管理")


def _notify_app_reload() -> None:
    """通知 GUI app 刷新任务树（如果正在运行）。失败静默。"""
    import socket as _sock

    socket_path = os.path.join(
        diy_home(),
        "app.sock",
    )
    try:
        s = _sock.socket(_sock.AF_UNIX, _sock.SOCK_STREAM)
        s.settimeout(2)
        s.connect(socket_path)
        s.sendall(b"diy ui reload\n")
        s.shutdown(_sock.SHUT_WR)
        s.close()
    except OSError:
        pass


# ════════════════════════════════════════════════════════════════
# dai task star / unstar
# ════════════════════════════════════════════════════════════════


@task_app.command(name="star")
def task_star(
    uri: Annotated[str, Parameter(help="任务 URI")],
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
):
    """star 任务（创建 symlink 到 ~/.diy/star/）。"""
    task = get_task(uri)
    if task is None:
        print(f"错误: 任务 {uri} 不存在", file=sys.stderr)
        sys.exit(1)

    try:
        star_task(uri)
    except FileNotFoundError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        sys.exit(1)

    _notify_app_reload()
    result = {"status": "success", "data": {"uri": uri, "starred": True}}
    if json_output:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        yaml.dump(
            result,
            sys.stdout,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )


@task_app.command(name="unstar")
def task_unstar(
    uri: Annotated[str, Parameter(help="任务 URI")],
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
):
    """unstar 任务（删除 symlink，数据不动）。"""
    task = get_task(uri)
    if task is None:
        print(f"错误: 任务 {uri} 不存在", file=sys.stderr)
        sys.exit(1)

    unstar_task(uri)

    _notify_app_reload()
    result = {"status": "success", "data": {"uri": uri, "starred": False}}
    if json_output:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        yaml.dump(
            result,
            sys.stdout,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )


@task_app.command(name="create")
def task_create(
    title: Annotated[str, Parameter(name="--title", help="任务标题")],
    subject: Annotated[str, Parameter(name="--subject", help="subject 路径")],
    parent: Annotated[str | None, Parameter(name="--parent", help="父任务 URI")] = None,
    detail: Annotated[str | None, Parameter(name="--detail", help="任务详情")] = None,
    body_file: Annotated[
        str | None, Parameter(name="--body-file", help="markdown body 文件路径")
    ] = None,
    source_type: Annotated[
        str, Parameter(name="--source-type", help="任务来源类型")
    ] = "local",
    source_uri: Annotated[
        str | None, Parameter(name="--source-uri", help="外部任务 URI（非 local 必填）")
    ] = None,
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
):
    """创建本地任务，自动 star。

    输出格式:
      status: success
      data:
        title: 标题
        state: pending
        uri: local/task/42

    范例:
      $ dai task create --title "重构 CLI" --subject ~/git/diy/_diy
      $ dai task create --title "子任务" --subject ~/git/diy/_diy --parent local/task/1

    注意: subject 必须已通过 dai subject add 注册。
    """
    from diy.core.middleware import cli_call
    from diy.core.task import create_task

    cli_call(
        create_task,
        title,
        subject,
        parent=parent,
        detail=detail,
        body_file=body_file,
        source_type=source_type,
        source_uri=source_uri,
        json_output=json_output,
    )
    _notify_app_reload()


@task_app.command(name="link")
def task_link(
    title: Annotated[str, Parameter(name="--title", help="任务标题")],
    subject: Annotated[str, Parameter(name="--subject", help="subject 路径")],
    source_uri: Annotated[
        str,
        Parameter(
            name="--source-uri",
            help="外部任务 URI（如 github.com/owner/repo/issues/58）",
        ),
    ],
    parent: Annotated[str | None, Parameter(name="--parent", help="父任务 URI")] = None,
    detail: Annotated[str | None, Parameter(name="--detail", help="任务详情")] = None,
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
):
    """链接外部任务（GitHub issue / PR）。只建立本地引用，不修改远端。
    创建后需 dai task sync <uri> 拉取 title/body/state。

    范例:
      $ dai task link --title "bug 修复" --source-uri github.com/org/repo/issues/42 --subject ~/git/diy/_diy

    注意: 首次 link 后 body 为空，必须 sync 拉取。
    """
    if not source_uri:
        print("错误: --source-uri 必填", file=sys.stderr)
        sys.exit(1)

    # 从 source_uri 格式推测 type
    if "github.com" in source_uri:
        if "/pull/" in source_uri:  # noqa: SIM108  # 双层嵌套 if/else，三元反而不清
            source_type = "github_pr"
        else:
            source_type = "github_issue"
    else:
        source_type = "external"

    subject_n = _norm(subject)
    data = load_state()
    subjects = data.get("subjects", {})
    if subject_n not in subjects:
        print(f"错误: subject {shlex.quote(subject_n)} 未注册", file=sys.stderr)
        sys.exit(1)
    if parent is not None and get_task(parent) is None:
        print(f"错误: parent {parent} 不存在", file=sys.stderr)
        sys.exit(1)

    try:
        uri = create_task(
            title=title,
            subject=subject_n,
            parent=parent,
            detail=detail,
            source_type=source_type,
            source_uri=source_uri,
        )
    except ValueError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        sys.exit(1)

    star_task(uri)
    task = get_task(uri) or {}
    result = {"status": "success", "data": task}
    _notify_app_reload()
    if json_output:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        yaml.dump(
            result,
            sys.stdout,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )


# ════════════════════════════════════════════════════════════════
# dai task sync — 同步外部任务
# ════════════════════════════════════════════════════════════════


_GH_STATE_MAP = {
    "OPEN": "active",
    "CLOSED": "done",
    "MERGED": "done",
}


def _gh_uri_parse(source_uri: str) -> tuple[str, str, str] | None:
    """解析 GitHub URI，返回 (owner, repo, issue_number)。

    github.com/owner/repo/issues/N
    """
    m = re.match(r"github\.com/([^/]+)/([^/]+)/issues/(\d+)", source_uri)
    if not m:
        return None
    return m.group(1), m.group(2), m.group(3)


def _sync_github_issue(uri: str, task: dict[str, Any]) -> dict[str, Any] | str:
    """同步单个 GitHub issue 到本地。成功返回更新后的 task dict，失败返回错误字符串。"""
    import subprocess

    src = task.get("source", {})
    source_uri = src.get("uri", uri)
    parsed = _gh_uri_parse(source_uri)
    if not parsed:
        return f"无法解析 GitHub URI: {source_uri}"

    owner, repo, number = parsed
    repo_full = f"{owner}/{repo}"

    try:
        result = subprocess.run(
            [
                "gh",
                "issue",
                "view",
                number,
                "--repo",
                repo_full,
                "--json",
                "title,body,state,updatedAt",
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except FileNotFoundError:
        return "gh CLI 未安装，请先安装 GitHub CLI (brew install gh)"
    except subprocess.TimeoutExpired:
        return f"请求 {repo_full}#{number} 超时"

    if result.returncode != 0:
        err = result.stderr.strip()
        if "issue not found" in err.lower() or "not found" in err.lower():
            # GitHub issue 已删除 → 取消关注（数据不动）
            try:
                unstar_task(uri)
                return "GitHub issue 已不存在，已取消关注（unstar）"
            except FileNotFoundError:
                return "GitHub issue 已不存在（本地数据同步前已移除）"
        return f"gh 调用失败: {err}"

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return f"gh 返回非 JSON: {result.stdout[:200]}"

    title = data.get("title", task.get("title", ""))
    body = data.get("body", "") or ""
    gh_state = _GH_STATE_MAP.get(data.get("state", ""), "active")

    return update_task_field(
        uri,
        title=title,
        state=gh_state,
        body=body,
    )


@task_app.command(name="sync")
def task_sync(
    uri: Annotated[
        str | None,
        Parameter(help="任务 URI（如 github.com/owner/repo/issues/58），--all 时省略"),
    ] = None,
    all: Annotated[
        bool, Parameter(name=["--all", "-a"], help="同步所有外部任务")
    ] = False,
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
):
    """同步外部任务内容到本地。

    从远端拉取最新 title/state/body 并更新本地 AGENTS.md。

    范例:
      $ dai task sync github.com/org/repo/issues/42
      $ dai task sync --all

    注意: 目前只支持 GitHub issue（需 gh CLI）。parent 不覆盖。
    """
    if not uri and not all:
        print("错误: 请指定任务 URI 或使用 --all 同步全部", file=sys.stderr)
        sys.exit(1)

    if all:
        tasks = list_tasks()
        results: dict[str, str | dict[str, Any]] = {}
        total = 0
        for t_uri, t_data in sorted(tasks.items()):
            src = t_data.get("source", {})
            source_type = src.get("type", "")
            if source_type not in ("github_issue",):
                continue
            total += 1
            print(f"  ⟳ {_short_uri(t_uri)} {t_data.get('title', '')[:50]}...")
            r = _sync_github_issue(t_uri, t_data)
            if isinstance(r, str):
                print(f"    ✗ {r}")
                results[t_uri] = f"失败: {r}"
            else:
                results[t_uri] = r

        _notify_app_reload()

        ok = sum(1 for v in results.values() if isinstance(v, dict))
        fail = sum(1 for v in results.values() if isinstance(v, str))
        output = {
            "status": "success",
            "data": {
                "synced": ok,
                "failed": fail,
                "results": results,
            },
        }
        if json_output:
            print(json.dumps(output, indent=2, ensure_ascii=False))
        else:
            print(f"\n✅ 同步完成: {ok} 内容更新, {fail} 失败，共 {total} 个外部任务")
        if fail:
            sys.exit(1)
        return

    # 同步单个
    task = get_task(uri)
    if task is None:
        print(f"错误: 任务 {uri} 不存在", file=sys.stderr)
        sys.exit(1)

    src = task.get("source", {})
    source_type = src.get("type", "")

    if source_type == "github_issue":
        result = _sync_github_issue(uri, task)
    else:
        print(f"错误: {uri} 的类型 {source_type} 暂不支持同步", file=sys.stderr)
        sys.exit(1)

    if isinstance(result, str):
        print(f"错误: {result}", file=sys.stderr)
        sys.exit(1)

    _notify_app_reload()
    output = {"status": "success", "data": result}
    if json_output:
        print(json.dumps(output, indent=2, ensure_ascii=False))
    else:
        yaml.dump(
            output,
            sys.stdout,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )


@task_app.command(name="list")
def task_list(
    all: Annotated[
        bool, Parameter(name=["--all", "-a"], help="显示全部任务（含未 star 的）")
    ] = False,
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
):
    """列出任务。默认只显示 starred（焦点视图），--all 显示全部。

    范例:
      $ dai task list
      $ dai task list --all
    """
    if all:  # noqa: SIM108  # if/else 比三元表达式更清晰
        tasks = list_tasks()
    else:
        tasks = list_starred()

    tasks_out: dict[str, Any] = {}
    for k, v in tasks.items():
        task_data = dict(v)
        task_data["starred"] = is_starred(k)
        tasks_out[k] = task_data

    output = {"tasks": tasks_out}
    if json_output:
        print(json.dumps(output, indent=2, ensure_ascii=False))
    else:
        yaml.dump(
            output,
            sys.stdout,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )


@task_app.command(name="show")
def task_show(
    uri: Annotated[str, Parameter(help="任务 URI")],
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
):
    """查看单个任务详情。

    范例:
      $ dai task show local/task/1
    """
    task = get_task(uri)
    if task is None:
        print(f"错误: 任务 {uri} 不存在", file=sys.stderr)
        sys.exit(1)
    body = task.pop("body", "") if not json_output else task.get("body", "")
    if json_output:
        print(json.dumps(task, indent=2, ensure_ascii=False))
    else:
        yaml.dump(
            task,
            sys.stdout,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )
        if body:
            print()
            print(body)


@task_app.command(name="edit")
def task_edit(
    uri: Annotated[str, Parameter(help="任务 URI")],
    title: Annotated[str | None, Parameter(name="--title", help="新标题")] = None,
    state: Annotated[str | None, Parameter(name="--state", help="新状态")] = None,
    subject: Annotated[
        str | None, Parameter(name="--subject", help="新 subject")
    ] = None,
    parent: Annotated[
        str | None, Parameter(name="--parent", help="新父任务 URI")
    ] = None,
    detail: Annotated[str | None, Parameter(name="--detail", help="新详情")] = None,
    body_file: Annotated[
        str | None, Parameter(name="--body-file", help="markdown body 文件路径")
    ] = None,
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
):
    """编辑任务元数据。返回编辑后的完整字段。

    范例:
      $ dai task edit local/task/1 --title "新标题" --state active

    注意: 不传的参数保持不变。
    """
    if get_task(uri) is None:
        print(f"错误: 任务 {uri} 不存在", file=sys.stderr)
        sys.exit(1)

    fields: dict[str, Any] = {}
    if title is not None:
        fields["title"] = title
    if state is not None:
        fields["state"] = state
    if subject is not None:
        fields["subject"] = _norm(subject)
    if parent is not None:
        if get_task(parent) is None:
            print(f"错误: parent {parent} 不存在", file=sys.stderr)
            sys.exit(1)
        fields["parent"] = parent
    if detail is not None:
        fields["detail"] = detail
    if body_file is not None:
        try:
            fields["body"] = Path(body_file).read_text(encoding="utf-8")
        except OSError as exc:
            print(
                f"错误: 无法读取 body 文件 {shlex.quote(body_file)}: {exc}",
                file=sys.stderr,
            )
            sys.exit(1)

    task = update_task_field(uri, **fields)
    result = {"status": "success", "data": task}
    _notify_app_reload()
    if json_output:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        yaml.dump(
            result,
            sys.stdout,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )


@task_app.command(name="delete")
def task_delete(
    uri: Annotated[str, Parameter(help="任务 URI")],
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
):
    """删除本地任务。外部任务请用 unlink。"""
    task = get_task(uri)
    if task is None:
        print(f"错误: 任务 {uri} 不存在", file=sys.stderr)
        sys.exit(1)

    src = task.get("source", {})
    if src.get("type") != "local":
        print(
            f"错误: {uri} 是外部任务，请用 dai task unlink {uri} 解绑", file=sys.stderr
        )
        sys.exit(1)

    delete_task(uri)
    result = {"status": "success"}
    _notify_app_reload()
    if json_output:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        yaml.dump(
            result,
            sys.stdout,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )


@task_app.command(name="unlink")
def task_unlink(
    uri: Annotated[
        str, Parameter(help="外部任务 URI（如 github.com/owner/repo/issues/58）")
    ],
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
):
    """解绑外部任务引用。不删除远端 issue，仅移除本地记录。"""
    task = get_task(uri)
    if task is None:
        print(f"错误: 任务 {uri} 不存在", file=sys.stderr)
        sys.exit(1)

    src = task.get("source", {})
    if src.get("type") == "local":
        print(f"错误: {uri} 是本地任务，请用 dai task delete {uri}", file=sys.stderr)
        sys.exit(1)

    delete_task(uri)
    result = {"status": "success"}
    _notify_app_reload()
    if json_output:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        yaml.dump(
            result,
            sys.stdout,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )


app.command(task_app)
app.command(profile_app)


# ════════════════════════════════════════════════════════════════
# dai app — PySide6 管控台
# ════════════════════════════════════════════════════════════════


# ════════════════════════════════════════════════════════════════
# 辅助
# ════════════════════════════════════════════════════════════════


def _short_uri(uri: str) -> str:
    """URI 短显示：local/task/58 → local#58, github.com/.../58 → github#58"""
    if uri.startswith("local/"):
        num = uri.rstrip("/").rsplit("/", 1)[-1]
        return f"local#{num}"
    if "github.com" in uri:
        num = uri.rstrip("/").rsplit("/", 1)[-1]
        return f"github#{num}"
    return uri


# ════════════════════════════════════════════════════════════════
# 入口
# ════════════════════════════════════════════════════════════════


def dai_doctor() -> None:
    """健康自检 — 分层检查 Socket 状态、多实例、state.yaml。

    有 app 运行时走 socket 获取完整上下文（含 inode 对比），
    无 app 运行时降级为客户端探针（检测 sock 残留/缺失）。
    """
    # 优先走 socket（运行中的 app 有完整上下文）
    import socket as _sock

    from diy.app._doctor import format_report, run_check

    socket_path = str(diy_home() / "app.sock")
    try:
        s = _sock.socket(_sock.AF_UNIX, _sock.SOCK_STREAM)
        s.settimeout(3)
        s.connect(socket_path)
        s.sendall(b"diy doctor\n")
        s.shutdown(_sock.SHUT_WR)
        buf: list[bytes] = []
        while True:
            data = s.recv(4096)
            if not data:
                break
            buf.append(data)
        s.close()
        sys.stdout.write(b"".join(buf).decode("utf-8"))
        return
    except OSError:
        pass  # socket 不通 → 独立检查

    # socket 不通 → 独立检查
    issues = run_check()
    print(format_report(issues))
    if any(i.severity == "critical" for i in issues):
        sys.exit(1)


def dai_doctor_metrics() -> None:
    """查看运行中 app 的指标快照。

    需要 app 正在运行。
    """
    resp = _send_to_socket("diy ui metrics", timeout=5.0)
    if resp is None:
        print("管控台未运行，无法获取指标", file=sys.stderr)
        sys.exit(1)
    import re  # noqa: PLC0415

    clean = re.sub(r"\x1b\[\d+(;\d+)*m", "", resp).strip()
    sys.stdout.write(clean)
    if not clean.endswith("\n"):
        sys.stdout.write("\n")


# ════════════════════════════════════════════════════════════════


# ════════════════════════════════════════════════════════════════
# dai agent — ACP agent 管理（全 async）
# ════════════════════════════════════════════════════════════════


agent_app = App(
    name="agent",
    help="ACP agent 管理 — 本地运行，不走 app socket",
)


def _get_session_counts(task_uri: str) -> tuple[int, int]:
    """返回 (活跃 session 数, 总历史 session 数)。"""
    alive = 0
    total = 0
    from diy.core.agent_manager import get_manager

    if get_manager().get(task_uri):
        alive = 1
    db = Path.home() / ".hermes" / "state.db"
    if db.exists():
        try:
            import sqlite3

            conn = sqlite3.connect(str(db), timeout=1)
            sid = f"agent-{task_uri}"
            rows = conn.execute(
                "SELECT COUNT(DISTINCT session_id) FROM messages WHERE session_id=?",
                (sid,),
            ).fetchone()
            if rows and rows[0]:
                total = rows[0]
            conn.close()
        except Exception:
            pass
    return alive, total


def _output(data: Any, json_output: bool = False) -> None:
    """统一输出: YAML 默认，--json 切换 JSON。"""
    if json_output:
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        yaml.dump(
            data,
            sys.stdout,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
            explicit_start=True,
        )


@agent_app.command(name="list")
def agent_list(
    *,
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
):
    """列出存活 agent（当前进程）。"""
    from diy.core.agent_manager import get_manager

    mgr = get_manager()
    agents = mgr.list()
    data: list[dict[str, Any]] = []
    for a in agents:
        live, total = _get_session_counts(a.task_uri)
        data.append(
            {
                "task_uri": a.task_uri,
                "session": {"alive": live, "total": total},
                "messages": a.message_count,
            }
        )
    if not data:
        _output({"agents": []}, json_output)
        return
    _output({"agents": data}, json_output)


@agent_app.command(name="status")
def agent_status(
    task_uri: Annotated[str, Parameter(help="任务 URI")],
    /,
    *,
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
):
    """查看 agent 状态。"""
    from diy.core.agent_manager import get_manager

    mgr = get_manager()
    a = mgr.get(task_uri)
    if a is None:
        _output({"error": "agent 不活跃", "task_uri": task_uri}, json_output)
        return
    s = a.state_snapshot()
    live, total = _get_session_counts(task_uri)
    data: dict[str, Any] = {
        "task_uri": s.task_uri,
        "state": s.state,
        "messages": s.message_count,
        "session": {"alive": live, "total": total},
        "history": [
            {"role": m.role, "content": m.content[:120]} for m in a.history[-6:]
        ],
    }
    # ── 诊断字段 ──
    if s.provider:
        data["provider"] = s.provider
    if s.model:
        data["model"] = s.model
    if s.pid:
        data["pid"] = s.pid
    if s.state == "running":
        data["events"] = s.event_count
        data["last_event"] = s.last_event_type or "(无)"
        data["elapsed"] = f"{s.prompt_elapsed:.0f}s"
    elif s.event_count:
        data["last_prompt_events"] = s.event_count
        data["last_prompt_event"] = s.last_event_type or "(无)"
    _output(data, json_output)


@agent_app.command(name="chat")
def agent_chat(
    task_uri: Annotated[str, Parameter(help="任务 URI")],
    /,
    *,
    cwd: Annotated[str | None, Parameter(help="工作目录（默认当前目录）")] = None,
    backend: Annotated[str, Parameter(help="后端: pi / hermes")] = "hermes",
    provider: Annotated[str | None, Parameter(help="LLM provider")] = None,
    model: Annotated[str | None, Parameter(help="LLM 模型")] = None,
):
    """交互式聊天终端。"""
    _cwd = cwd or os.getcwd()
    from diy.core.backend import AgentCallbacks

    cb = AgentCallbacks(
        on_delta=lambda t: print(t, end="", flush=True),
        on_reasoning=lambda t: print(f"\n[思考] {t}"),
        on_tool_start=lambda n, i, a: print(f"\n[工具] {n}"),
        on_error=lambda e: print(f"\n[错误] {e}", file=sys.stderr),
    )
    asyncio.run(
        _async_chat(
            task_uri,
            _cwd,
            callbacks=cb,
            backend=backend,
            provider=provider,
            model=model,
        )
    )


async def _async_chat(
    task_uri: str,
    cwd: str,
    callbacks,
    *,
    backend: str = "hermes",
    provider: str | None = None,
    model: str | None = None,
) -> None:
    from diy.core.agent_manager import get_manager

    mgr = get_manager()
    agent = await mgr.get_or_create(
        task_uri,
        cwd,
        backend=backend,
        provider=provider,
        model=model,
        callbacks=callbacks,
    )
    print(f"Session: {agent.session_id}")
    print("输入消息 / Ctrl+D 退出")
    print("-" * 50)
    try:
        while True:
            line = await asyncio.to_thread(input, "\n> ")
            line = line.strip()
            if not line:
                continue
            if line in ("/quit", "/exit", "/q"):
                break
            print()
            reason = await agent.send(line)
            print(f"\n[完成: {reason}]")
    except (EOFError, KeyboardInterrupt):
        print()
    print("agent 仍在后台运行（重新输入 dai agent chat 可继续）")


@agent_app.command(name="send")
def agent_send(
    task_uri: Annotated[str, Parameter(help="任务 URI")],
    text: Annotated[str, Parameter(help="消息文本")],
    /,
    *,
    backend: Annotated[str, Parameter(help="后端: pi / hermes")] = "hermes",
    provider: Annotated[str | None, Parameter(help="LLM provider")] = None,
    model: Annotated[str | None, Parameter(help="LLM 模型")] = None,
):
    """向 agent 发送单条消息。"""
    from diy.core.backend import AgentCallbacks

    cb = AgentCallbacks(
        on_delta=lambda t: print(t, end="", flush=True),
        on_error=lambda e: print(f"\n[错误] {e}", file=sys.stderr),
    )
    asyncio.run(
        _async_send(
            task_uri,
            text,
            callbacks=cb,
            backend=backend,
            provider=provider,
            model=model,
        )
    )


async def _async_send(
    task_uri: str,
    text: str,
    callbacks,
    *,
    backend: str = "hermes",
    provider: str | None = None,
    model: str | None = None,
) -> None:
    from diy.core.agent_manager import get_manager

    mgr = get_manager()
    agent = await mgr.get_or_create(
        task_uri,
        os.getcwd(),
        backend=backend,
        provider=provider,
        model=model,
        callbacks=callbacks,
    )
    reason = await agent.send(text)
    print(f"\n--- {reason} ---")
    print(f"历史: {len(agent.history)} 条（agent 继续存活）")


@agent_app.command(name="stop")
def agent_stop(
    task_uri: Annotated[str, Parameter(help="任务 URI")],
    /,
):
    """停止 agent。"""
    asyncio.run(_async_stop(task_uri))


@agent_app.command(name="monitor")
def agent_monitor(
    task_uri: Annotated[str | None, Parameter(help="任务 URI（不填则列出所有）")] = None,
    /,
    *,
    json_output: Annotated[
        bool, Parameter(name=["--json"], help="JSON 格式输出")
    ] = False,
    watch: Annotated[
        bool, Parameter(name=["-w", "--watch"], help="实时刷新（1s 间隔）")
    ] = False,
):
    """agent 实时监控。

    范例:
      dai agent monitor              # 列出所有 agent
      dai agent monitor local/task/1 # 详细监控单个 agent
      dai agent monitor -w           # 实时刷新列表
    """
    from diy.cli._forward import forward_to_app

    args = ["diy", "agent", "monitor"]
    if task_uri:
        args.append(task_uri)
    if json_output:
        args.append("--json")

    if not watch:
        forward_to_app(args)
        return

    # watch 模式：循环调用
    import sys
    import time

    while True:
        forward_to_app(args)
        time.sleep(1)
        print("\033[2J\033[H", end="", file=sys.stderr)  # 清屏


@agent_app.command(name="stream")
def agent_stream(
    task_uri: Annotated[str | None, Parameter(help="任务 URI（不填则列出所有）")] = None,
    /,
    *,
    timeout: Annotated[int, Parameter(help="超时秒数")] = 120,
):
    """agent 事件流（流式输出）。

    范例:
      dai agent stream local/task/1
      dai agent stream local/task/1 --timeout 60
    """
    from diy.cli._forward import forward_to_app

    args = ["diy", "agent", "stream"]
    if task_uri:
        args.append(task_uri)
    args.extend(["--timeout", str(timeout)])
    forward_to_app(args)


app.command(agent_app)


async def _async_stop(task_uri: str) -> None:
    from diy.core.agent_manager import get_manager

    mgr = get_manager()
    agent = mgr.get(task_uri)
    if agent is None:
        print(f"agent {task_uri} 不活跃")
        return
    await mgr.stop(task_uri)
    print(f"agent {task_uri} 已停止")


def _send_to_socket(cmd_line: str, timeout: float = 5) -> str | None:
    """直接向 app.sock 发送一行文本，不经过 forward_to_app。

    用于 restart/shutdown 等需要控制 app 生命周期的命令。
    """
    import socket as sock

    socket_path = str(diy_home() / "app.sock")
    try:
        s = sock.socket(sock.AF_UNIX, sock.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect(socket_path)
        s.sendall((cmd_line + "\n").encode("utf-8"))
        s.shutdown(sock.SHUT_WR)
        buf = b""
        while True:
            data = s.recv(4096)
            if not data:
                break
            buf += data
        s.close()
        return buf.decode("utf-8")
    except OSError:
        return None


def _local_shutdown():
    """关闭管控台（本地执行，不自动启动 app）。

    先试 socket 优雅关闭，socket 不存在或连不上时
    用 pkill 兜底杀 diy.app.main 进程。
    """
    from diy.core._log import info

    from diy.cli._forward import _send_to_socket

    socket_path = str(diy_home() / "app.sock")
    if os.path.exists(socket_path):
        resp = _send_to_socket(socket_path, "diy ui shutdown")
        if resp is not None:
            info(resp)
            return

    # socket 不存在或不通 → 进程级兜底
    import subprocess

    kill = subprocess.run(
        ["pkill", "-f", "diy.app.main"],
        capture_output=True,
        text=True,
        timeout=5,
    )
    if kill.returncode == 0:
        # 清理残留的 QWebEngine 子进程
        subprocess.run(
            ["pkill", "-f", "QtWebEngineProcess"], capture_output=True, timeout=3
        )
        subprocess.run(
            ["pkill", "-f", "Chromium Helper"], capture_output=True, timeout=3
        )
        info("管控台已强制关闭")
    else:
        info("管控台未运行")


def _wait_lock_released(lock_path: str, timeout: float = 8.0) -> bool:
    """等待 app.lock 被释放（旧进程退出后内核自动释放 flock）。

    注意：flock 不提供事件通知机制（非 selectable），
    只能轮询。timeout 是最后兜底，不是预期耗时。
    已弃用：改用 Backoff.until()，此处保留仅作兼容。
    """

    from diy.core._backoff import Backoff

    success, _ = Backoff.until(
        lambda: _try_lock(lock_path),
        timeout=timeout,
    )
    return success


def _try_lock(lock_path: str) -> bool:
    """尝试获取文件锁，成功返回 True。"""
    import fcntl

    try:
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o644)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
        return True
    except BlockingIOError:
        return False  # 锁仍在持有，Backoff 继续重试
    except OSError:
        return True  # 文件系统问题，不阻塞


def _app_restart():
    """重启管控台：shutdown → 等锁释放 → 启动 app。

    流程:
      shutdown 旧 app（发 socket QApplication.quit()）
        → 等 5s 锁释放（旧进程退出）？
           ├─ ✅ 释放了 → 启动新 app
           └─ ❌ 没释放 → pkill -f 杀旧进程
                          → 再等 3s 锁释放？
                             ├─ ✅ 释放了 → 启动新 app
                             └─ ❌ 仍不释放 → 报错退出
    """
    import subprocess
    import time as _time

    from diy.core._log import debug, error, info, warn

    socket_path = str(diy_home() / "app.sock")
    lock_path = str(diy_home() / "app.lock")

    # 1) shutdown — 不管成功与否，只发一次
    if os.path.exists(socket_path):
        info("正在关闭管控台...")
        _send_to_socket("diy ui shutdown", timeout=1.0)

    # 2) 等旧进程完全退出（锁释放），超时则强杀
    if os.path.exists(lock_path):
        info("等待旧管控台退出...")
        if not _wait_lock_released(lock_path, timeout=5.0):
            warn("旧管控台未在 5s 内退出，尝试强杀...")
            import subprocess as _sp

            kill = _sp.run(
                ["pkill", "-f", "diy.app.main"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if kill.returncode == 0:
                _time.sleep(1.0)
                if _wait_lock_released(lock_path, timeout=3.0):
                    info("旧管控台已强制关闭")
                else:
                    error("旧管控台强杀后仍不释放锁")
                    sys.exit(1)
            else:
                error("旧管控台退出超时，且未找到可杀的进程")
                sys.exit(1)

    # 3) 清理残留 socket 文件
    #   注意：已改用 --disable-gpu，不再有 GPU 子进程的 MachPort 污染问题，
    #   无需 sleep 等待。kill QtWebEngineProcess 在旧版 --single-process
    #   时是必要的，现在保留仅作防御。
    subprocess.run(
        ["pkill", "-f", "QtWebEngineProcess"], capture_output=True, timeout=3
    )
    subprocess.run(["pkill", "-f", "Chromium Helper"], capture_output=True, timeout=3)
    try:
        os.unlink(socket_path)
    except FileNotFoundError:
        debug("socket 文件已不存在（清理阶段）")

    # 4) 启动 app — 直接用当前 Python 解释器，不依赖 sha.sh
    info("正在启动管控台...")
    subprocess.Popen(
        [sys.executable, "-m", "diy.app.main"],
        stdout=subprocess.DEVNULL,
        env={**os.environ},
    )

    # 5) 等 socket 就绪（指数退避连接，避免固定间隔轮询）
    #   直接用 connect 探测，不用 file-exists 检查（TOCTOU 风险）。
    import socket as _socket

    from diy.core._backoff import Backoff

    def _try_connect() -> bool:
        s = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
        s.settimeout(1.0)
        s.connect(socket_path)
        s.close()
        return True

    success, _ = Backoff.until(
        _try_connect,
        timeout=15,
        exceptions=(OSError, FileNotFoundError, ConnectionRefusedError),
    )
    if success:
        info("管控台已重启")
        return

    # 6) 超时
    error("管控台启动超时，请检查日志")
    sys.exit(1)


def _dai_ui() -> None:
    """启动 PySide6 管控台。"""
    import subprocess
    import sys
    from pathlib import Path

    app_main = Path(__file__).resolve().parent / "app" / "main.py"
    subprocess.run([sys.executable, str(app_main)] + sys.argv[2:])


def main():
    """CLI 路由入口。

    路由表：
      restart/shutdown → 本地 cyclopts
      agent            → 本地 AgentManager
      ui (无参数)       → 启动桌面 app
      ui <subcmd>      → socket → diy ui ...
      其他所有命令      → socket → diy ... (协议前缀 diy = v1)

    ⚠️ 加命令必须同步在 app/main.py GatewayCLI 注册。
    移动命令时搜 grep -rn '"diy <旧>"' src/ 更新所有硬编码字符串。
    """
    from diy.core._log import debug  # noqa: I001  # 函数内 import 避模块级循环导入
    from diy.cli._forward import forward_to_app

    tokens = sys.argv[1:] if len(sys.argv) > 1 else []
    if not tokens:
        try:
            app(["--help"])
        except SystemExit:
            debug("cyclopts --help 完成")
        return

    cmd = tokens[0]

    # 生命周期命令 — 本地执行，走 cyclopts（注册在 app 上，会显示在 help 中）
    if cmd in ("restart", "shutdown"):
        try:
            app(tokens)
        except SystemExit:
            debug("生命周期命令完成: %s", cmd)
        return
    if cmd == "doctor" and len(tokens) > 1 and tokens[1] == "metrics":
        dai_doctor_metrics()
        return

    # ACP agent 命令（本地运行，不依赖 app socket）
    if cmd == "agent":
        try:
            agent_app(tokens[1:])
        except SystemExit:
            debug("agent 命令完成")
        return

    # UI 子命令：dai ui 无参数 → 启动桌面 app；dai ui <subcmd> → 走 socket
    if cmd == "ui":
        if len(tokens) == 1:
            # dai ui → 启动桌面 app
            _dai_ui()
            return
        # dai ui <subcmd> ... → 转发到已有 app 的 socket
        args = ["diy"] + tokens
        forward_to_app(args)
        return

    # 所有命令走 app.sock，协议前缀 diy = v1
    args = ["diy"] + tokens
    forward_to_app(args)


if __name__ == "__main__":
    main()
