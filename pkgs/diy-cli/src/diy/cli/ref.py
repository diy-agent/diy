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
from pathlib import Path
from typing import Annotated

import yaml
from cyclopts import App, Parameter

from ._log import logger
from ._sync import (
    find_project_boundary,
    find_project_root,
    get_workspace_packages,
    parse_repo_url,
    scan_project_deps,
    sync_dependencies,
)

log = logger.with_tag("ref")

_REF_HELP = """\
~/.diy/ref/ 是本地源码镜像。将外部 git 仓库 clone 到本地,
让 AI agent 可离线阅读项目依赖和外部仓库的源码。

数据流:
  diy ref sync         扫描 pyproject.toml/package.json, 查出 git 仓库并 clone
                       写入 .diy/ref.lock.yaml (v5)
  diy ref add <url>    注册外部仓库到 diy.yaml, 下次 sync 一并 clone
  diy ref list         查看 .diy/ref.lock.yaml 的镜像映射表
  diy ref list --all   显示所有 scope (不按当前目录过滤)

v5 ref.lock.yaml 层级: refs → ecosystem(python/node/source) → scope(项目名) → category → pkg

输出示例: diy ref list 显示五级层级 — version → python/diy-cli/dependencies/rich → ~/path

本地镜像目录:  ~/.diy/ref/github.com/<owner>/<repo>/<version>/
"""

ref_app = App(
    name="ref",
    help="管理 ~/.diy/ref/ 本地源码镜像",
    help_prologue=_REF_HELP,
    help_epilogue="典型: diy ref add <url> → diy ref sync → diy ref list  |  数据: ~/.diy/ref/ + .diy/ref.lock.yaml",
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


def _require_project_boundary() -> Path:
    """找当前项目边界（diy.yaml / pyproject.toml / package.json / .git），失败则报错退出。

    边界优先级：
      ① cwd 自身 → ② parent 链上第一个标记 → ③ git 根
    标记：diy.yaml / pyproject.toml / package.json
    兜底：.git
    """
    try:
        return find_project_boundary()
    except FileNotFoundError as e:
        log.error(str(e))
        sys.exit(1)


def _load_ref_lock(root_dir: Path) -> dict:
    """加载 .diy/ref.lock.yaml"""
    lock_path = root_dir / ".diy" / "ref.lock.yaml"
    if not lock_path.exists():
        return {}
    try:
        with open(lock_path, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        return data.get("refs", {})
    except Exception:
        return {}


def _migrate_diy_config(config: dict) -> dict:
    """将旧版 diy.yaml 格式迁移到新版。

    旧版（v1）：
      sources: ["https://..."]

    新版（v2）：
      ref:
        source: ["https://..."]       # 人工指定 source
        node:
          include: ["xxx-*"]
          exclude: ["xxx-*"]
        python:
          include: ["xxx-*"]
          exclude: ["xxx-*"]

    迁移规则：
      - 顶层 sources → ref.source（去重合并）
      - 旧版 ref.sources → ref.source（singular）
    """
    if not config:
        return config

    config.setdefault("ref", {})
    ref = config["ref"]

    # 迁移旧顶层 sources → ref.source
    old_top = config.pop("sources", None)
    if isinstance(old_top, list) and old_top:
        existing = ref.get("source", [])
        seen = set(existing)
        for s in old_top:
            if s not in seen:
                existing.append(s)
                seen.add(s)
        ref["source"] = existing

    # 迁移旧版 ref.sources（复数）→ ref.source（singular）
    old_ref_sources = ref.pop("sources", None)
    if isinstance(old_ref_sources, list) and old_ref_sources:
        existing = ref.get("source", [])
        seen = set(existing)
        for s in old_ref_sources:
            if s not in seen:
                existing.append(s)
                seen.add(s)
        ref["source"] = existing

    # 清理：ref 无有效内容时移除
    if not ref.get("source") and not ref.get("node") and not ref.get("python"):
        config.pop("ref", None)

    return config


def _load_diy_yaml(root_dir: Path) -> dict:
    """加载 diy.yaml，自动迁移旧版格式到新版。"""
    diy_yaml = root_dir / "diy.yaml"
    if not diy_yaml.exists():
        return {}
    try:
        with open(diy_yaml, encoding="utf-8") as f:
            config = yaml.safe_load(f) or {}
        return _migrate_diy_config(config)
    except Exception:
        return {}


def _save_diy_yaml(root_dir: Path, config: dict):
    """保存 diy.yaml（始终写入新版格式）"""
    diy_yaml = root_dir / "diy.yaml"
    try:
        with open(diy_yaml, "w", encoding="utf-8") as f:
            yaml.dump(config, f, default_flow_style=False, allow_unicode=True)
    except Exception as e:
        log.error(f"保存 diy.yaml 失败: {e}")
        raise


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
    all: Annotated[
        bool, Parameter(help="显示所有 scope 的条目", name="--all", negative="")
    ] = False,
):
    """查看 .diy/ref.lock.yaml 的镜像映射表

    从当前目录自动检测所属 scope (项目边界), 只显示该 scope 的条目。
    --all 显示文件中所有 scope。

    输出层级: ecosystem(python/node/source) → scope(项目名) → category(dependencies/…) → 包名

    示例:
      # 当前在子包 diy-cli 目录
      $ diy ref list
      python:
        diy-cli:
          dependencies:
            rich: ~/.diy/ref/github.com/Textualize/rich/v13.9.4
      Scope: diy/diy-cli (python)

      $ diy ref list --all
      python:
        diy-app:   ...
        diy-cli:   ...
      ...

      # 镜像文件: ~/.diy/ref/github.com/Textualize/rich/v13.9.4/
    """
    root_dir = _require_project_root()

    lock_path = root_dir / ".diy" / "ref.lock.yaml"
    if not lock_path.exists():
        log.info("没有 .diy/ref.lock.yaml — 先运行 'diy ref sync' 生成")
        return

    import yaml

    try:
        data = yaml.safe_load(lock_path.read_text()) or {}
    except yaml.YAMLError as e:
        log.error(f"ref.lock.yaml 解析失败: {e}")
        log.info("运行 'diy ref sync' 重新生成即可修复")
        sys.exit(1)

    ver = data.get("version", 0)
    from rich.console import Console

    console = Console()

    if ver >= 5 and "refs" in data:
        refs_data = data["refs"]
        console.print(f"version: {ver}")
        console.print(f'generated: "{data.get("generated", "?")}"')

        # 解析 root 项目名（根 scope 可能存为项目名而非 "."）
        root_project_name = _read_root_project_name(root_dir)
        root_aliases: list[str] = ["."]
        if root_project_name and root_project_name != ".":
            root_aliases.append(root_project_name)

        # 检测当前 scope
        boundary = find_project_boundary()
        current_scope = None
        if boundary:
            try:
                for name, info in get_workspace_packages(root_dir).items():
                    if Path(info.path).resolve() == boundary:
                        current_scope = name
                        break
            except Exception:
                pass
            if not current_scope and boundary == (root_dir / ".").resolve():
                current_scope = "."

        has_entries = False
        for eco in sorted(refs_data.keys()):
            scopes = refs_data[eco]
            if all:
                scope_keys = sorted(scopes.keys())
            else:
                if current_scope and current_scope in scopes:
                    scope_keys = [current_scope]
                elif current_scope and current_scope != ".":
                    # 非根边界（子项目）→ 只在该 scope 精确匹配的生态显示，不回溯到根
                    scope_keys = []
                elif eco == "source":
                    scope_keys = []
                else:
                    scope_keys = []
                    for alias in root_aliases:
                        if alias in scopes:
                            scope_keys = [alias]
                            break
                    if not scope_keys:
                        scope_keys = [next(iter(scopes))] if scopes else []
            if not scope_keys:
                continue
            has_entries = True
            console.print("")
            console.print(f"[bold]{eco}:[/bold]")
            for sk in scope_keys:
                entry = scopes[sk]
                if not entry:
                    continue
                console.print(f"  {sk}:")
                _print_refs_v5(console, entry, indent=4)

        if not has_entries:
            console.print("")
            console.print("[dim]（当前 scope 无 ref 条目）[/dim]")

        # scope 标签
        label = root_dir.name or str(root_dir)
        if all:
            label += " (all scopes)"
        elif current_scope and current_scope != ".":
            label += f"/{current_scope}"
        if (root_dir / "pyproject.toml").exists():
            label += " (python)"
        elif (root_dir / "package.json").exists():
            label += " (node)"
        console.print(f"[dim]Scope: {label}[/dim]")
    else:
        log.warning(f"不支持 ref.lock.yaml 版本: {ver}, 运行 'diy ref sync' 升级")
        console.print(lock_path.read_text().rstrip() if lock_path.exists() else "")


def _print_refs_v5(console, entry: dict, indent: int = 0) -> None:
    """递归打印 v5 refs 层级 (category/sub-group/pkg)。"""
    pad = " " * indent
    pad2 = " " * (indent + 2)
    pad3 = " " * (indent + 4)
    for k, v in sorted(entry.items()):
        if isinstance(v, dict):
            first = next(iter(v.values())) if v else None
            if isinstance(first, dict):
                console.print(f"{pad}{k}:")
                for sub_k, pkgs in sorted(v.items()):
                    console.print(f"{pad2}{sub_k}:")
                    for name, path in sorted(pkgs.items()):
                        p = f"~/{path}" if not path.startswith("~/") else path
                        console.print(f"{pad3}{name}: {p}")
            else:
                console.print(f"{pad}{k}:")
                for name, path in sorted(v.items()):
                    p = f"~/{path}" if not path.startswith("~/") else path
                    console.print(f"{pad2}{name}: {p}")
        else:
            console.print(f"{pad}{k}: {v}")


def _read_root_project_name(root_dir: Path) -> str:
    """读取根项目名 (pyproject.toml / package.json 的 name)。"""
    pyproj = root_dir / "pyproject.toml"
    if pyproj.exists():
        try:
            import tomllib

            with open(pyproj, "rb") as f:
                data = tomllib.load(f)
            name = data.get("project", {}).get("name", "")
            if name:
                return name
        except Exception:
            pass
    pkg = root_dir / "package.json"
    if pkg.exists():
        try:
            with open(pkg) as f:
                name = json.load(f).get("name", "")
            if name:
                return name
        except Exception:
            pass
    return "."


@ref_app.command(name="add")
def ref_add(
    url: Annotated[str, Parameter(help="Git 仓库 URL，如 https://github.com/org/repo")],
    version: Annotated[
        str | None, Parameter(help="分支/tag/commit，如 main、v1.0.0")
    ] = None,
    verbose: Annotated[int, Parameter(help="冗余级别: -v=INFO, -vv=DEBUG")] = 0,
):
    """注册外部仓库到 diy.yaml，供后续 diy ref sync 下载源码

    注册后运行 diy ref sync 实际 clone 到 ~/.diy/ref/。

    示例:
      # 基本注册
      diy ref add https://github.com/org/repo
      -> diy.yaml 追加 sources: ["https://github.com/org/repo"]
      -> diy ref sync -> ~/.diy/ref/github.com/org/repo/main/

      # 指定版本
      diy ref add https://github.com/org/repo@v1.0.0
      -> .diy/ref.lock.yaml -> source:. : github.com/org/repo: ~/path

      # 查看镜像列表
      diy ref list -> source 组显示条目
    """
    root_dir = _require_project_boundary()
    config = _load_diy_yaml(root_dir)

    ref = config.setdefault("ref", {})
    source_list = ref.setdefault("source", [])

    # 自动识别 URL 中的 @version（如 https://github.com/org/repo@main）
    if "@" in url and not version:
        url, version = url.rsplit("@", 1)

    spec = url
    if version:
        spec = f"{url}@{version}"

    repo_info = parse_repo_url(url)
    if not repo_info:
        log.error(f"无法解析 URL，请提供完整的 git 仓库地址: {url}")
        sys.exit(1)

    name = f"{repo_info.owner}/{repo_info.repo}"
    scope_key = f"{repo_info.host}/{name}"  # host/owner/repo 去重键

    # 验证 git 命令可用
    import shutil as _su

    if not _su.which("git"):
        log.error("缺少 git 命令")
        log.info("  安装 git 后重试：brew install git")
        sys.exit(1)

    # 验证 URL 是否可访问（是真实的 git 仓库）
    import subprocess as _sp

    verify_url = url.rstrip("/")
    try:
        result = _sp.run(
            ["git", "ls-remote", "--heads", verify_url],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except _sp.TimeoutExpired:
        log.error(f"验证超时（15 秒）: {url}")
        log.info("  git ls-remote 请求超时 — 请确认网络连接或 URL 是否正确。")
        sys.exit(1)
    else:
        if result.returncode != 0:
            log.error(f"URL 不是有效的 git 仓库: {url}")
            log.info("  git ls-remote 请求失败 — 请确认 URL 正确且仓库可公开访问。")
            sys.exit(1)

    # 同 host/owner/repo 但 URL 不同 → 替换旧条目
    replaced = False
    new_sources: list[str] = []
    for existing in source_list:
        existing_part = existing.split("@")[0] if "@" in existing else existing
        existing_info = parse_repo_url(existing_part)
        existing_key = (
            f"{existing_info.host}/{existing_info.owner}/{existing_info.repo}"
            if existing_info
            else ""
        )
        if existing_key == scope_key:
            if existing != spec:
                log.info("替换 source: %s → %s", existing, spec)
                new_sources.append(spec)
                replaced = True
                continue
            else:
                log.warning(f"Source 已存在，跳过: {name}")
                return
        new_sources.append(existing)

    if replaced:
        ref["source"] = new_sources
    else:
        ref["source"].append(spec)
    _save_diy_yaml(root_dir, config)
    log.success("已注册 source: %s", spec)
    log.info("立即同步...")
    sync_dependencies()


@ref_app.command(name="remove")
def ref_remove(
    name: Annotated[
        str,
        Parameter(
            help="要移除的 source（支持 owner/repo、完整 URL、或 diy.yaml 中的原字符串）"
        ),
    ],
    verbose: Annotated[int, Parameter(help="冗余级别: -v=INFO, -vv=DEBUG")] = 0,
):
    """从 diy.yaml 中移除已注册的 source

    只移除注册信息，已 clone 到 ~/.diy/ref/ 的源码保留不动。

    用法示例:
      diy ref remove owner/repo
      diy ref remove https://github.com/org/repo
      diy ref remove https://github.com/org/repo@main
    """
    root_dir = _require_project_boundary()
    config = _load_diy_yaml(root_dir)
    ref = config.setdefault("ref", {})
    source_list = ref.get("source", [])

    if not source_list:
        log.info("diy.yaml 中没有注册 source，无需移除")
        return

    found = False
    new_sources = []
    for s in source_list:
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
        log.info("  现有 source:")
        for s in source_list:
            log.info("    %s", s)
        sys.exit(1)

    ref["source"] = new_sources
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

    from rich import box
    from rich.console import Console
    from rich.table import Table

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
        console.print(
            f"[yellow]⚠ 有 {missing_count} 个镜像缺失，运行 'diy sync' 重新下载[/yellow]"
        )
    console.print(f"[green]{ok_count}[/green] 正常, [red]{missing_count}[/red] 缺失")


@ref_app.command(name="sync")
def ref_sync(
    verbose: Annotated[int, Parameter(help="冗余级别: -v=INFO, -vv=DEBUG")] = 0,
):
    """同步项目依赖和 sources 到 ~/.diy/ref/

    扫描 pyproject.toml 和 package.json:
      - [project] dependencies           -> python:dependencies
      - [project.optional-dependencies]  -> python:optional-dependencies:<组>
      - [dependency-groups]              -> python:dependency-groups:<组>
      - dependencies / devDependencies   -> node:dependencies / node:dev-dependencies

    也处理 diy ref add 注册的外部仓库 (diy.yaml -> sources)。

    写入 .diy/ref.lock.yaml (v5), 镜像存放 ~/.diy/ref/github.com/<owner>/<repo>/<version>/

    示例:
      diy ref sync
      -> .diy/ref.lock.yaml (version:5)
      -> ~/.diy/ref/github.com/pytest-dev/pytest/9.0.3/
      -> ~/.diy/ref/github.com/Textualize/rich/v13.9.4/
    """
    try:
        sync_dependencies()
    except FileNotFoundError as e:
        log.error(str(e))
        sys.exit(1)
    except Exception as e:
        log.error(f"同步过程中发生未知错误: {e}")
        sys.exit(1)
