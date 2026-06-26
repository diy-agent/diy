"""diy ref — 本地源码镜像管理

用途：将外部仓库源码克隆到本地 ~/.diy/ref/，供 AI agent 直接阅读。

两种来源：
  1. 自动扫描：diy sync 读取 pyproject.toml / package.json 的依赖，
     从 PyPI/npm registry 查出 git 仓库地址并 clone。
  2. 手动添加：diy ref add 将非依赖的外部仓库注册到 diy.yaml，
     后续 diy sync 也会 clone 它们。

Agent 通过 diy ref list 查到路径，再用 read_file 读源码。
"""

import sys
import yaml
from pathlib import Path
from typing import Annotated, Optional
from cyclopts import App, Parameter

from ._log import logger
from ._sync import (
    find_project_root,
    parse_repo_url,
    scan_project_deps,
    sync_dependencies,
)

log = logger.with_tag("ref")

_REF_HELP = """
~/.diy/ref/ 是项目依赖和外部仓库的本地源码镜像目录。

目的：让 AI agent 可以直接阅读项目使用的第三方依赖源码，
无需网络请求，且版本与 lock 文件中锁定的一致。

两种来源：
  1. 自动扫描 — diy ref sync 读取 pyproject.toml / package.json
     的依赖，从 PyPI / npm 查出 git 仓库并 clone。
  2. 手动添加 — diy ref add 将不在依赖中的外部仓库注册到
     diy.yaml，sync 时一并 clone。

数据流：
  diy.yaml 声明 → diy ref sync 下载 → .diy/ref.lock.yaml 记录路径
  → diy ref list 查看状态 → agent 用 read_file 读取源码"""

ref_app = App(
    name="ref",
    help="管理 ~/.diy/ref/ 本地源码镜像",
    help_prologue=_REF_HELP,
    help_epilogue="典型流程: diy ref add <url> → diy ref sync → diy ref list → agent 读源码",
)


def _require_project_root() -> Path:
    """找项目根目录（含 diy.yaml），失败则报错退出。"""
    try:
        return find_project_root()
    except FileNotFoundError:
        log.error("未找到 diy.yaml — 当前目录不是 diy 项目？")
        log.info("  项目根目录需包含 diy.yaml 文件。")
        log.info("  创建空文件 touch diy.yaml 即可初始化。")
        sys.exit(1)


def _load_ref_lock(root_dir: Path) -> dict:
    """加载 .diy/ref.lock.yaml"""
    lock_path = root_dir / ".diy" / "ref.lock.yaml"
    if not lock_path.exists():
        return {}
    try:
        with open(lock_path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        return data.get("refs", {})
    except Exception:
        return {}


def _load_diy_yaml(root_dir: Path) -> dict:
    """加载 diy.yaml"""
    diy_yaml = root_dir / "diy.yaml"
    if not diy_yaml.exists():
        return {}
    try:
        with open(diy_yaml, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except Exception:
        return {}


def _save_diy_yaml(root_dir: Path, config: dict):
    """保存 diy.yaml"""
    diy_yaml = root_dir / "diy.yaml"
    try:
        with open(diy_yaml, "w", encoding="utf-8") as f:
            yaml.dump(config, f, default_flow_style=False, allow_unicode=True)
    except Exception as e:
        log.error(f"保存 diy.yaml 失败: {e}")
        raise


def _status_icon(status: str) -> str:
    return {"synced": "✓", "pending": "○", "error": "✗"}.get(status, "?")


@ref_app.command(name="list")
def ref_list(
    verbose: Annotated[int, Parameter(help="冗余级别: -v=INFO, -vv=DEBUG")] = 0,
):
    """列出项目检测到的所有依赖及源码镜像状态

即使未运行 diy sync，也会扫描 pyproject.toml / package.json
并展示检测到的包和待下载状态。

✓ = 已同步到本地  ○ = 未同步（待 sync）  ✗ = 出错

路径格式: ~/.diy/ref/{host}/{owner}/{repo}/{tag}
"""
    root_dir = _require_project_root()
    deps = scan_project_deps(root_dir)

    if not deps:
        log.info("项目未检测到外部依赖（或所有包都已过滤为 workspace 内部包）")
        log.info("运行 'diy ref add <git-url>' 添加外部仓库")
        return

    from rich.console import Console
    from rich.table import Table
    from rich import box

    console = Console()

    # 分依赖和 sources 两组显示
    dep_items = [d for d in deps if d.eco != "source"]
    source_items = [d for d in deps if d.eco == "source"]

    synced_count = sum(1 for d in deps if d.status == "synced")
    pending_count = sum(1 for d in deps if d.status == "pending")

    if dep_items:
        table = Table(
            title="Dependencies（依赖 — 来自 pyproject.toml / package.json）",
            box=box.SIMPLE,
        )
        table.add_column("", justify="center", width=2)  # 状态图标
        table.add_column("类型", style="magenta", width=8)
        table.add_column("包名", style="cyan")
        table.add_column("版本", style="yellow", width=20)
        table.add_column("Git 仓库", style="dim", width=60)

        for d in dep_items:
            icon = _status_icon(d.status)
            color = "green" if d.status == "synced" else "dim"
            url = d.source_url or "[dim]（待 registry 查询）[/dim]"
            table.add_row(f"[{color}]{icon}[/{color}]", d.eco, d.name, d.version, url)

        console.print(table)
        console.print()

    if source_items:
        table = Table(
            title="Sources（外部仓库 — 来自 diy ref add）",
            box=box.SIMPLE,
        )
        table.add_column("", justify="center", width=2)
        table.add_column("名称", style="cyan")
        table.add_column("版本", style="yellow", width=20)
        table.add_column("URL / 路径", style="dim", width=60)

        for d in source_items:
            icon = _status_icon(d.status)
            color = "green" if d.status == "synced" else "dim"
            loc = d.local_path if d.local_path else d.source_url
            table.add_row(f"[{color}]{icon}[/{color}]", d.name, d.version, loc)

        console.print(table)
        console.print()

    # 汇总
    parts = []
    if synced_count:
        parts.append(f"[green]{synced_count} 已同步[/green]")
    if pending_count:
        parts.append(f"[yellow]{pending_count} 待同步[/yellow]")
    if parts:
        console.print("  ".join(parts))

    if pending_count > 0:
        console.print()
        console.print("[yellow]运行 'diy sync' 下载待同步的源码[/yellow]")


@ref_app.command(name="add")
def ref_add(
    url: Annotated[str, Parameter(help="Git 仓库 URL，如 https://github.com/org/repo")],
    version: Annotated[Optional[str], Parameter(help="分支/tag/commit，如 main、v1.0.0")] = None,
    verbose: Annotated[int, Parameter(help="冗余级别: -v=INFO, -vv=DEBUG")] = 0,
):
    """注册外部仓库到 diy.yaml，供后续 diy sync 下载源码

适用场景：外部仓库不在 pyproject.toml / package.json 的依赖中，
但 agent 仍然需要阅读其源码（如研究、调试用）。

添加后需运行 diy sync 实际 clone 代码到本地。

用法示例:
  diy ref add https://github.com/org/repo
  diy ref add https://github.com/org/repo@main
  diy ref add git@github.com:org/repo@v1.0.0
"""
    root_dir = _require_project_root()
    config = _load_diy_yaml(root_dir)

    if "sources" not in config:
        config["sources"] = []

    spec = url
    if version:
        spec = f"{url}@{version}"

    repo_info = parse_repo_url(url)
    if not repo_info:
        log.error(f"无法解析 URL，请提供完整的 git 仓库地址: {url}")
        sys.exit(1)

    name = f"{repo_info.owner}/{repo_info.repo}"

    for existing in config["sources"]:
        existing_part = existing.split("@")[0] if "@" in existing else existing
        existing_info = parse_repo_url(existing_part)
        if existing_info and f"{existing_info.owner}/{existing_info.repo}" == name:
            log.warning(f"Source 已存在，跳过: {name}")
            log.info("  如需变更版本，先 'diy ref remove %s' 再重新添加", name)
            return

    config["sources"].append(spec)
    _save_diy_yaml(root_dir, config)
    log.success("已注册 source: %s", spec)
    log.info("")
    log.info("下一步: 运行 'diy sync' 下载源码到 ~/.diy/ref/")


@ref_app.command(name="remove")
def ref_remove(
    name: Annotated[str, Parameter(
        help="要移除的 source（支持 owner/repo、完整 URL、或 diy.yaml 中的原字符串）"
    )],
    verbose: Annotated[int, Parameter(help="冗余级别: -v=INFO, -vv=DEBUG")] = 0,
):
    """从 diy.yaml 中移除已注册的 source

只移除注册信息，已 clone 到 ~/.diy/ref/ 的源码保留不动。

用法示例:
  diy ref remove owner/repo
  diy ref remove https://github.com/org/repo
  diy ref remove https://github.com/org/repo@main
"""
    root_dir = _require_project_root()
    config = _load_diy_yaml(root_dir)
    sources = config.get("sources", [])

    if not sources:
        log.info("diy.yaml 中没有注册 sources，无需移除")
        return

    found = False
    new_sources = []
    for s in sources:
        url_part = s.split("@")[0] if "@" in s else s
        repo_info = parse_repo_url(url_part)
        if repo_info:
            current_name = f"{repo_info.owner}/{repo_info.repo}"
            if current_name == name or url_part == name or s == name:
                found = True
                log.info("移除: %s", s)
                continue
        new_sources.append(s)

    if not found:
        log.error("未找到匹配的 source: %s", name)
        log.info("  现有 sources:")
        for s in sources:
            log.info("    %s", s)
        sys.exit(1)

    config["sources"] = new_sources
    _save_diy_yaml(root_dir, config)
    log.success("已移除 source: %s", name)
    log.info("  本地缓存 ~/.diy/ref/ 中的代码不受影响")


@ref_app.command(name="status")
def ref_status(
    verbose: Annotated[int, Parameter(help="冗余级别: -v=INFO, -vv=DEBUG")] = 0,
):
    """检查 ~/.diy/ref/ 下已同步的源码目录是否存在

✓ 正常 = 路径存在可读, ✗ 缺失 = 需重新 diy sync
Agent 读 ref 源码前可用此命令确认路径有效。
"""
    root_dir = _require_project_root()
    deps = scan_project_deps(root_dir)
    synced = [d for d in deps if d.status == "synced"]

    if not synced:
        log.info("没有已同步到本地的源码镜像")
        log.info("运行 'diy sync' 下载")
        return

    from rich.console import Console
    from rich.table import Table
    from rich import box

    console = Console()
    table = Table(title="Ref 状态 — 本地路径检查", box=box.SIMPLE)
    table.add_column("", justify="center", width=2)
    table.add_column("Key", style="cyan")
    table.add_column("本地路径", style="green")
    table.add_column("状态", justify="center")

    home = Path.home()
    ok_count = 0
    missing_count = 0

    for d in synced:
        path_str = d.local_path
        if path_str.startswith("~/"):
            abs_path = home / path_str[2:]
        else:
            abs_path = Path(path_str)

        exists = abs_path.exists()
        icon = "✓" if exists else "✗"
        color = "green" if exists else "red"
        status_text = "[green]✓ 存在[/green]" if exists else "[red]✗ 缺失[/red]"

        key = f"{d.eco}:{d.name}" if d.eco != "source" else f"source:{d.name}"
        table.add_row(f"[{color}]{icon}[/{color}]", key, path_str, status_text)

        if exists:
            ok_count += 1
        else:
            missing_count += 1

    console.print(table)
    console.print()

    if missing_count > 0:
        console.print(f"[yellow]⚠ 有 {missing_count} 个镜像缺失，运行 'diy sync' 重新下载[/yellow]")
    console.print(f"[green]{ok_count}[/green] 正常, [red]{missing_count}[/red] 缺失")


@ref_app.command(name="sync")
def ref_sync(
    verbose: Annotated[int, Parameter(help="冗余级别: -v=INFO, -vv=DEBUG")] = 0,
):
    """同步项目依赖源码到 ~/.diy/ref/

自动扫描 pyproject.toml / package.json 的 workspace 和 dependencies，
从 PyPI / npm registry 查出对应 git 仓库，clone 到本地 ~/.diy/ref/，
生成 .diy/ref.lock.yaml 映射表供 agent 读取源码。

也处理 diy ref add 注册的外部仓库（sources）。
"""
    try:
        sync_dependencies()
    except FileNotFoundError as e:
        log.error(str(e))
        sys.exit(1)
    except Exception as e:
        log.error(f"同步过程中发生未知错误: {e}")
        sys.exit(1)
