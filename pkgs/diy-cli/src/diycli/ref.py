"""diy ref — 本地源码镜像管理"""

import sys
import yaml
from pathlib import Path
from typing import Annotated, Optional
from cyclopts import App, Parameter

from ._log import logger
from ._sync import (
    find_project_root,
    build_ref_lock,
    write_ref_lock_file,
    SyncResult,
    GLOBAL_CACHE_DIR,
)

log = logger.with_tag("ref")

ref_app = App(
    name="ref",
    help="管理本地源码镜像 (ref: ~/.diy/ref/ + .diy/ref.lock.yaml)\n\n"
    "ref 系统: diy.yaml 声明外部仓库, diy sync clone 源码到 ~/.diy/ref/,"
    " 生成 .diy/ref.lock.yaml 映射表 (key → 本地路径)。"
    " Agent 用 diy ref list 查路径, read_file 读源码。"
    " 子命令: add list remove status。",
)


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


def _parse_ref_key(key: str) -> tuple[str, str]:
    """解析 ref key 为 (type, name)"""
    if ":" in key:
        parts = key.split(":", 1)
        return parts[0], parts[1]
    return "unknown", key


@ref_app.command(name="list")
def ref_list(
    verbose: Annotated[int, Parameter(help="冗余级别: -v=INFO, -vv=DEBUG")] = 0,
):
    """列出已同步的所有 ref, 输出 key → 路径映射表
diy.yaml sources → source:owner/repo 键
pyproject.toml 依赖 → python:name 键
package.json 依赖 → node:name 键
路径格式: ~/.diy/ref/{host}/{owner}/{repo}/{tag}
Agent 查源码: diy ref list → 取 path → read_file(path)"""
    root_dir = find_project_root()
    refs = _load_ref_lock(root_dir)
    config = _load_diy_yaml(root_dir)
    sources = config.get("sources", [])

    if not refs:
        log.info("暂无已同步的 ref")
        return

    # 分类
    dep_refs = {}
    source_refs = {}
    for key, path in refs.items():
        ref_type, name = _parse_ref_key(key)
        if ref_type == "source":
            source_refs[name] = path
        else:
            dep_refs[key] = path

    # 输出
    from rich.console import Console
    from rich.table import Table
    from rich import box

    console = Console()

    if source_refs:
        table = Table(title="Sources (参考仓库)", box=box.SIMPLE)
        table.add_column("名称", style="cyan")
        table.add_column("路径", style="green")
        table.add_column("配置", style="dim")

        # 匹配 diy.yaml sources
        source_map = {}
        for s in sources:
            if "@" in s:
                idx = s.rfind("@")
                if idx > 7:
                    url, ver = s[:idx], s[idx+1:]
                else:
                    url, ver = s, ""
            else:
                url, ver = s, ""
            # 提取 owner/repo
            from ._sync import parse_repo_url
            repo_info = parse_repo_url(url)
            if repo_info:
                name = f"{repo_info.owner}/{repo_info.repo}"
                source_map[name] = s

        for name, path in sorted(source_refs.items()):
            config_str = source_map.get(name, "")
            table.add_row(name, path, config_str)

        console.print(table)
        console.print()

    if dep_refs:
        table = Table(title="Dependencies (依赖源码)", box=box.SIMPLE)
        table.add_column("类型", style="magenta")
        table.add_column("名称", style="cyan")
        table.add_column("路径", style="green")

        for key, path in sorted(dep_refs.items()):
            ref_type, name = _parse_ref_key(key)
            table.add_row(ref_type, name, path)

        console.print(table)

    console.print(f"\n总计: {len(source_refs)} sources, {len(dep_refs)} deps")


@ref_app.command(name="add")
def ref_add(
    url: Annotated[str, Parameter(help="Git 仓库 URL")],
    version: Annotated[Optional[str], Parameter(help="分支/tag/commit, 如 main、v1.0.0")] = None,
    verbose: Annotated[int, Parameter(help="冗余级别: -v=INFO, -vv=DEBUG")] = 0,
):
    """添加外部仓库到 diy.yaml, 后续 diy sync 会 clone 源码
diy ref add https://github.com/org/repo
diy ref add https://github.com/org/repo@main
diy ref add git@github.com:org/repo@v1.0.0"""
    root_dir = find_project_root()
    config = _load_diy_yaml(root_dir)

    # 确保 sources 列表存在
    if "sources" not in config:
        config["sources"] = []

    # 构建 source spec
    spec = url
    if version:
        spec = f"{url}@{version}"

    # 检查是否已存在
    from ._sync import parse_repo_url
    repo_info = parse_repo_url(url)
    if not repo_info:
        log.error(f"无法解析 URL: {url}")
        sys.exit(1)

    name = f"{repo_info.owner}/{repo_info.repo}"
    for existing in config["sources"]:
        existing_info = parse_repo_url(existing.split("@")[0] if "@" in existing else existing)
        if existing_info and f"{existing_info.owner}/{existing_info.repo}" == name:
            log.warning(f"Source 已存在: {name}，跳过")
            return

    # 添加到 diy.yaml
    config["sources"].append(spec)
    _save_diy_yaml(root_dir, config)
    log.success(f"已添加 source: {spec}")


@ref_app.command(name="remove")
def ref_remove(
    name: Annotated[str, Parameter(help="owner/repo | URL | diy.yaml 原串")],
    verbose: Annotated[int, Parameter(help="冗余级别: -v=INFO, -vv=DEBUG")] = 0,
):
    """从 diy.yaml 移除 source (已 clone 的代码保留在 ~/.diy/ref/)
diy ref remove github/org
diy ref remove https://github.com/org/repo"""
    root_dir = find_project_root()
    config = _load_diy_yaml(root_dir)
    sources = config.get("sources", [])

    if not sources:
        log.warning("diy.yaml 中没有 sources")
        return

    from ._sync import parse_repo_url

    # 查找匹配的 source
    found = False
    new_sources = []
    for s in sources:
        url_part = s.split("@")[0] if "@" in s else s
        repo_info = parse_repo_url(url_part)
        if repo_info:
            current_name = f"{repo_info.owner}/{repo_info.repo}"
            if current_name == name or url_part == name or s == name:
                found = True
                log.info(f"移除: {s}")
                continue
        new_sources.append(s)

    if not found:
        log.error(f"未找到匹配的 source: {name}")
        sys.exit(1)

    config["sources"] = new_sources
    _save_diy_yaml(root_dir, config)
    log.success(f"已移除 source: {name}")




@ref_app.command(name="status")
def ref_status(
    verbose: Annotated[int, Parameter(help="冗余级别: -v=INFO, -vv=DEBUG")] = 0,
):
    """检查 .diy/ref.lock.yaml 各路径是否存在
✓ 正常 = 路径存在可读, ✗ 缺失 = 需重新 diy sync
Agent 读 ref 源码前先 status 确认路径有效
diy ref status"""
    root_dir = find_project_root()
    refs = _load_ref_lock(root_dir)
    config = _load_diy_yaml(root_dir)
    sources = config.get("sources", [])

    if not refs:
        log.info("暂无已同步的 ref")
        return

    from rich.console import Console
    from rich.table import Table
    from rich import box

    console = Console()
    table = Table(title="Ref 状态", box=box.SIMPLE)
    table.add_column("Key", style="cyan")
    table.add_column("路径", style="green")
    table.add_column("状态", justify="center")

    home = Path.home()
    ok_count = 0
    missing_count = 0

    for key, path in sorted(refs.items()):
        # 展开 ~
        if path.startswith("~/"):
            abs_path = home / path[2:]
        else:
            abs_path = Path(path)

        if abs_path.exists():
            table.add_row(key, path, "[green]✓[/green]")
            ok_count += 1
        else:
            table.add_row(key, path, "[red]✗ 缺失[/red]")
            missing_count += 1

    console.print(table)
    console.print(f"\n状态: [green]{ok_count} 正常[/green], [red]{missing_count} 缺失[/red]")
