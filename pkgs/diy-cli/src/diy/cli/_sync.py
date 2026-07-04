import json
import os
import re
import shutil
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from rich.live import Live
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
)

from ._log import logger

log = logger.with_tag("sync")

GLOBAL_CACHE_DIR = Path.home() / ".diy"
METADATA_CACHE_PATH = GLOBAL_CACHE_DIR / "registry-cache.json"


def _require_cmd(name: str, hint: str = "") -> None:
    """检查外部命令是否存在，缺失时直接报错退出。"""
    if not shutil.which(name):
        log.error("缺少外部命令: %s", name)
        if hint:
            log.info("  %s", hint)
        sys.exit(1)


metadata_cache: dict[str, Any] = {}
metadata_lock = threading.Lock()


def clean_exec_output(output: str) -> str:
    lines = output.splitlines()
    filtered = []
    for line in lines:
        l = line.strip()
        if not l:
            continue
        if l.startswith("Agent pid"):
            continue
        if "load ~/.bashrc" in l:
            continue
        if "Output: load" in l:
            continue
        filtered.append(l)
    return "\n".join(filtered).strip()


@dataclass
class WorkspaceInfo:
    name: str
    version: str
    path: str
    relative_path: str
    dependencies: dict[str, str]
    dev_dependencies: dict[str, str]


def find_project_boundary(start: Path | None = None) -> Path:
    """定位当前所在的 diy 项目边界（作用域）。

    ════════════════════════════════════════════════════════════════════
    设计：diy.yaml 驱动的项目边界（2026-07-04）

    规则：
      1. 从 cwd 向上遍历，第一个遇到的 diy.yaml 就是边界。
      2. 如果越过 .git 根目录仍没有 diy.yaml → 不是 diy 项目，报错。
      3. 到达文件系统根仍没有 → 报错。

    diy.yaml 是唯一有效的项目边界标记。
    pyproject.toml / package.json / .git 不再作为 diy 操作的边界。
    ════════════════════════════════════════════════════════════════════
    """
    curr = (start or Path.cwd()).resolve()

    # --- 从 cwd 向上遍历 ---
    for candidate in [curr] + list(curr.parents):
        if (candidate / "diy.yaml").exists():
            return candidate
        # .git 是硬边界：遇到 .git 但没有 diy.yaml → 不是 diy 项目
        if (candidate / ".git").exists():
            break
        # 文件系统根 → 停止
        if candidate == candidate.parent:
            break

    raise FileNotFoundError(
        "未找到 diy.yaml — 当前目录不在任何 diy 项目范围内。\n"
        "提示：运行 'diy init' 在当前目录初始化，或进入已有 diy.yaml 的目录。"
    )


def find_project_root() -> Path:
    """从当前目录向上查找 diy.yaml，直到找到为止。

    规则与 find_project_boundary() 一致：
    遇到 .git 但没有 diy.yaml → 不是 diy 项目，报错。
    """
    curr = Path.cwd().resolve()
    for candidate in [curr] + list(curr.parents):
        if (candidate / "diy.yaml").exists():
            return candidate
        if (candidate / ".git").exists():
            break
        if candidate == candidate.parent:
            break
    raise FileNotFoundError(
        "未发现 diy.yaml — 当前目录不在任何 diy 项目范围内。\n"
        "提示：运行 'diy init' 在当前目录初始化，或进入已有 diy.yaml 的目录。"
    )


def _collect_sources_from_all_boundaries(root_dir: Path) -> list[str]:
    """收集项目根下所有 diy.yaml 的 sources（含根自身和子项目边界）。

    子项目可能有自己的 diy.yaml，我们需要聚合所有 sources
    让 diy ref sync 能一次性同步完所有作用域的引用。
    """
    sources: list[str] = []

    def _load_sources(path: Path):
        yml = path / "diy.yaml"
        if not yml.exists():
            return
        try:
            with open(yml, encoding="utf-8") as f:
                cfg = yaml.safe_load(f) or {}
            # 新版：ref.source；旧版兼容：顶层 sources / ref.sources
            items = cfg.get("ref", {}).get("source", []) or cfg.get("sources", []) or []
            if isinstance(items, list):
                sources.extend(items)
        except Exception:
            pass

    # 1. 根自身的 diy.yaml
    _load_sources(root_dir)

    # 2. 已知子项目边界（workspace packages）
    workspaces = get_workspace_packages(root_dir)
    seen = {root_dir}
    for wp in workspaces.values():
        p = Path(wp.path)
        if p not in seen:
            seen.add(p)
            _load_sources(p)

    # 3. 递归扫描所有子项目边界（有 package.json / pyproject.toml 的目录）
    #    检查这些边界下是否有独立的 diy.yaml
    try:
        markers = ["package.json", "pyproject.toml"]
        for marker in markers:
            for match in sorted(root_dir.rglob(marker)):
                entry = match.parent
                if entry in seen:
                    continue
                # 跳过 node_modules / .git / .venv 等
                if any(
                    p in entry.relative_to(root_dir).parts
                    for p in ("node_modules", ".git", ".venv", "__pycache__")
                ):
                    continue
                seen.add(entry)
                _load_sources(entry)
    except PermissionError:
        pass

    return sources


def get_workspace_packages(root_dir: Path) -> dict[str, WorkspaceInfo]:
    workspace_map = {}

    def parse_python_deps(path: Path) -> dict[str, str]:
        pyproject_path = path / "pyproject.toml"
        deps = {}
        if pyproject_path.exists():
            try:
                import tomllib

                with open(pyproject_path, "rb") as f:
                    pyproject = tomllib.load(f)
                for dep_str in pyproject.get("project", {}).get("dependencies", []):
                    d_parts = re.split(r"[>=<]", dep_str)
                    if d_parts:
                        d_name = d_parts[0].strip()
                        d_ver = dep_str[len(d_name) :].strip() or "*"
                        deps[d_name] = d_ver
            except Exception:
                pass
        return deps

    def get_dir_info(path: Path, rel_path: str) -> WorkspaceInfo | None:
        pkg_json_path = path / "package.json"
        pyproject_path = path / "pyproject.toml"

        name = ""
        version = "0.1.19"
        deps = {}
        dev_deps = {}

        if pkg_json_path.exists():
            try:
                with open(pkg_json_path, encoding="utf-8") as f:
                    pkg = json.load(f)
                name = pkg.get("name", "")
                version = pkg.get("version", version)
                deps.update(pkg.get("dependencies", {}))
                dev_deps.update(pkg.get("devDependencies", {}))
            except Exception:
                pass

        py_deps = parse_python_deps(path)
        if py_deps:
            deps.update(py_deps)
        # 无论有无 deps，都尝试从 pyproject.toml 读取 name/version
        if not name and pyproject_path.exists():
            try:
                import tomllib

                with open(pyproject_path, "rb") as f:
                    pyproject = tomllib.load(f)
                proj = pyproject.get("project", {})
                name = proj.get("name", "")
                version = proj.get("version", version)
            except Exception:
                pass

        if name:
            return WorkspaceInfo(
                name=name,
                version=version,
                path=str(path),
                relative_path=rel_path,
                dependencies=deps,
                dev_dependencies=dev_deps,
            )
        return None

    # 1. Check Root
    root_info = get_dir_info(root_dir, ".")
    if root_info:
        workspace_map[root_info.name] = root_info

    # 2. Check Node.js workspaces from package.json
    root_pkg_path = root_dir / "package.json"
    if root_pkg_path.exists():
        try:
            with open(root_pkg_path, encoding="utf-8") as f:
                root_pkg = json.load(f)
            workspaces = root_pkg.get("workspaces", [])
            if isinstance(workspaces, list):
                for pattern in workspaces:
                    base_dir_str = pattern.replace("/*", "")
                    full_base_dir = root_dir / base_dir_str
                    if full_base_dir.exists() and full_base_dir.is_dir():
                        for item in full_base_dir.iterdir():
                            if item.is_dir():
                                info = get_dir_info(
                                    item, str(item.relative_to(root_dir))
                                )
                                if info:
                                    workspace_map[info.name] = info
        except Exception:
            pass

    # 3. Check Python workspaces from pyproject.toml
    root_pyproject_path = root_dir / "pyproject.toml"
    if root_pyproject_path.exists():
        try:
            import tomllib

            with open(root_pyproject_path, "rb") as f:
                pyproject = tomllib.load(f)
            # uv.workspace.members 或 poetry.workspace.members
            workspace_cfg = pyproject.get("tool", {}).get("uv", {}).get(
                "workspace", {}
            ) or pyproject.get("tool", {}).get("poetry", {}).get("workspace", {})
            members = workspace_cfg.get("members", [])
            for pattern in members:
                base_dir_str = pattern.replace("/*", "")
                full_base_dir = root_dir / base_dir_str
                if full_base_dir.exists() and full_base_dir.is_dir():
                    if "/*" in pattern:
                        for item in full_base_dir.iterdir():
                            if item.is_dir():
                                info = get_dir_info(
                                    item, str(item.relative_to(root_dir))
                                )
                                if info:
                                    workspace_map[info.name] = info
                    else:
                        info = get_dir_info(
                            full_base_dir, str(full_base_dir.relative_to(root_dir))
                        )
                        if info:
                            workspace_map[info.name] = info
        except Exception:
            pass

    # 4. Check pkgs/ directory (fallback for both)
    packages_dir = root_dir / "packages"
    if packages_dir.exists():
        for item in packages_dir.iterdir():
            if item.is_dir() and item.name not in workspace_map:
                info = get_dir_info(item, str(item.relative_to(root_dir)))
                if info:
                    workspace_map[info.name] = info

    return workspace_map


metadata_cache: dict[str, Any] = {}


def load_metadata_cache():
    global metadata_cache
    if METADATA_CACHE_PATH.exists():
        try:
            with open(METADATA_CACHE_PATH, encoding="utf-8") as f:
                metadata_cache = json.load(f)
        except Exception:
            metadata_cache = {}


def save_metadata_cache():
    GLOBAL_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with open(METADATA_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(metadata_cache, f, indent=2)


@dataclass
class RepoInfo:
    host: str
    owner: str
    repo: str


def parse_repo_url(url: str) -> RepoInfo | None:
    import re

    clean_url = url.strip()
    if clean_url.startswith("git+"):
        clean_url = clean_url[4:]
    # 剥掉 GitHub/GitLab/Gitea 的 Web UI 路径（/tree/..., /-/tree/..., /src/branch/...）
    clean_url = re.sub(
        r"(/tree/[^/]+(?:/.*)?|/blob/[^/]+(?:/.*)?|/-/tree/[^/]+(?:/.*)?|/-/blob/[^/]+(?:/.*)?|/src/(?:branch|tag)/[^/]+(?:/.*)?)$",
        "",
        clean_url,
    )
    if clean_url.endswith(".git"):
        clean_url = clean_url[:-4]
    # 剥离 @version/branch/tag 后缀（npm/pip 风格的 URL 引用）
    clean_url = re.sub(r"@[^/]+$", "", clean_url)

    # git@host:owner/repo
    git_at_match = re.match(r"^git@([^:]+):([^/]+)/(.+)$", clean_url)
    if git_at_match:
        return RepoInfo(
            host=git_at_match.group(1),
            owner=git_at_match.group(2),
            repo=git_at_match.group(3),
        )

    # https?://host/owner/repo
    try:
        # Simple extraction
        if "://" in clean_url:
            parts = clean_url.split("://")[1].split("/")
        else:
            parts = clean_url.split("/")

        if len(parts) >= 3:
            host = parts[0]
            owner = parts[1]
            repo = parts[2]
            return RepoInfo(host=host, owner=owner, repo=repo)
    except Exception:
        pass
    return None


def get_best_tag(repo_url: str, version: str) -> str | None:
    try:
        clone_url = repo_url if repo_url.startswith("http") else f"https://{repo_url}"
        log.debug(f"[Git] 正在获取远端 Tag 信息: {clone_url}")
        # 静默 stderr 避免干扰进度条
        output = subprocess.check_output(
            ["git", "ls-remote", "--tags", clone_url],
            stderr=subprocess.DEVNULL,
            text=True,
        )
        tags_output = clean_exec_output(output)

        tags = []
        for line in tags_output.splitlines():
            if "refs/tags/" in line:
                tag = line.split("refs/tags/")[1].split("^{}")[0]
                tags.append(tag)

        candidates = [f"v{version}", version]
        for cand in candidates:
            if cand in tags:
                return cand
    except Exception:
        pass
    return None


@dataclass
class SyncResult:
    relative_path: str
    absolute_path: str
    ecosystem: str


npm_registry_url = "https://registry.npmjs.org"


def load_npm_config():
    global npm_registry_url
    if not shutil.which("npm"):
        log.debug("npm 未安装，使用默认 registry")
        return
    try:
        # 获取用户配置的 registry (如淘宝镜像、公司私有镜像)
        npm_registry_url = (
            subprocess.check_output(["npm", "config", "get", "registry"], text=True)
            .strip()
            .rstrip("/")
        )
    except Exception:
        pass


def _git_clone_with_progress(
    cmd: list[str],
    dest: str,
    label: str,
    status_cb,
    env=None,
) -> None:
    """执行 git clone 并实时转发 stderr 全部原始输出到 status_cb。

    Git 在 stderr 输出如：
      remote: Enumerating objects: 105, done.
      Receiving objects:  42% (1234/2938), 15.2 MiB | 1.2 MiB/s
    所有行原样转发，不筛选，让用户看到完整的下载带宽/流量信息。
    """
    import subprocess as _sp

    proc = _sp.Popen(
        cmd,
        env=env,
        stdout=_sp.DEVNULL,
        stderr=_sp.PIPE,
        text=True,
    )
    for line in proc.stderr or []:
        line = line.strip()
        if not line:
            continue
        if status_cb:
            status_cb(f"{label}: {line}")
    proc.wait()
    if proc.returncode != 0:
        raise _sp.CalledProcessError(proc.returncode, cmd)


def process_package(
    name: str,
    version: str,
    ecosystem: str,
    global_ref_base: Path,
    workspace_packages: dict[str, WorkspaceInfo],
    status_cb: Any | None = None,
) -> SyncResult | None:
    # 剥离 extras（如 PySide6-Fluent-Widgets[full] → PySide6-Fluent-Widgets）
    clean_name = name.split("[", 1)[0] if "[" in name else name

    env = os.environ.copy()
    env["GIT_LOW_SPEED_LIMIT"] = "1000"
    env["GIT_LOW_SPEED_TIME"] = "60"
    env["GIT_TERMINAL_PROMPT"] = "0"

    try:
        if version.startswith("workspace:") or name in workspace_packages:
            log.debug(f"[{ecosystem}:{name}] 跳过本地 Workspace 依赖")
            return None

        repo_url = ""
        sub_dir = ""

        cache_key = f"{ecosystem}:{clean_name}"
        with metadata_lock:
            cache_item = metadata_cache.get(cache_key)

        if cache_item and (
            cache_item.get("lastVersion") == version
            or version in str(cache_item.get("lastVersion", ""))
        ):
            repo_url = cache_item.get("repoUrl", "")
            sub_dir = cache_item.get("subDir", "")
        else:
            if ecosystem == "node":
                log.debug(f"[{name}] 正在通过 Registry API 获取元数据...")
                try:
                    import json as json_lib
                    import urllib.request

                    api_url = f"{npm_registry_url}/{clean_name.replace('/', '%2f')}"
                    with urllib.request.urlopen(api_url, timeout=10) as response:
                        data = json_lib.loads(response.read().decode())
                        repo_info = data.get("repository")
                        if not repo_info:
                            latest_ver = data.get("dist-tags", {}).get("latest")
                            if latest_ver:
                                repo_info = (
                                    data.get("versions", {})
                                    .get(latest_ver, {})
                                    .get("repository")
                                )

                        if isinstance(repo_info, dict):
                            repo_url = repo_info.get("url", "")
                            sub_dir = repo_info.get("directory", "")
                        elif isinstance(repo_info, str):
                            repo_url = repo_info
                except Exception as e:
                    log.debug(f"[{name}] API 请求失败 ({e})，回退到 npm view...")
                    try:
                        repo_url = clean_exec_output(
                            subprocess.check_output(
                                [
                                    "npm",
                                    "view",
                                    clean_name,
                                    "repository.url",
                                    "--no-workspaces",
                                ],
                                text=True,
                                timeout=30,
                                stderr=subprocess.DEVNULL,
                            )
                        )
                        try:
                            sub_dir = clean_exec_output(
                                subprocess.check_output(
                                    [
                                        "npm",
                                        "view",
                                        clean_name,
                                        "repository.directory",
                                        "--no-workspaces",
                                    ],
                                    text=True,
                                    timeout=10,
                                    stderr=subprocess.DEVNULL,
                                )
                            )
                        except Exception:
                            pass
                    except Exception:
                        pass
            elif ecosystem == "python":
                log.debug(f"[{name}] 正在请求 PyPI Registry...")
                try:
                    import json as json_lib
                    import urllib.request

                    with urllib.request.urlopen(
                        f"https://pypi.org/pypi/{clean_name}/json", timeout=10
                    ) as response:
                        data = json_lib.loads(response.read().decode())
                        info = data.get("info", {})
                        project_urls = info.get("project_urls", {}) or {}
                        repo_url = (
                            project_urls.get("Source")
                            or project_urls.get("GitHub")
                            or project_urls.get("Homepage")
                            or ""
                        )
                        if "github.com" not in repo_url:
                            for url in project_urls.values():
                                if "github.com" in str(url):
                                    repo_url = url
                                    break
                except Exception as e:
                    log.error(f"[{name}] 获取 PyPI 元数据失败: {e}")
                    return None

            if repo_url:
                with metadata_lock:
                    metadata_cache[cache_key] = {
                        "repoUrl": repo_url,
                        "subDir": sub_dir,
                        "lastVersion": version,
                    }

        if status_cb and repo_url:
            status_cb(
                f"正在同步 [bold cyan]{ecosystem}:{name}[/bold cyan] 从 [yellow]{repo_url}[/yellow]"
            )

        if not repo_url:
            log.debug(f"[{ecosystem}:{name}] 未找到源码仓库地址")
            return None

        repo_info = parse_repo_url(repo_url)
        if not repo_info:
            return None

        clone_url = f"https://{repo_info.host}/{repo_info.owner}/{repo_info.repo}"
        version_base = re.sub(
            r"^[>=<~^!]+", "", version.replace(",", " ").split()[0].strip()
        )
        if not version_base or version_base == "*":
            version_base = "main"
        possible_names = [version_base, f"v{version_base}"]

        final_global_path = None
        for p_name in possible_names:
            p = (
                global_ref_base
                / repo_info.host
                / repo_info.owner
                / repo_info.repo
                / p_name
            )
            if p.exists():
                final_global_path = p
                break

        if not final_global_path:
            log.debug(f"[{name}] 准备同步源码: {name}@{version}")
            best_tag = get_best_tag(clone_url, version_base)
            if best_tag:
                final_dir_name = best_tag
            else:
                # 无匹配 tag → clone 默认分支，取实际分支名
                final_dir_name = version_base

            final_global_path = (
                global_ref_base
                / repo_info.host
                / repo_info.owner
                / repo_info.repo
                / final_dir_name
            )

            if not final_global_path.exists():
                final_global_path.parent.mkdir(parents=True, exist_ok=True)
                cmd = ["git", "clone", "--depth", "1"]
                if best_tag:
                    cmd += ["--branch", best_tag]
                cmd += [clone_url, str(final_global_path)]
                log.debug(f"[{name}] 执行 Git Clone: {' '.join(cmd)}")
                _git_clone_with_progress(
                    cmd, str(final_global_path), name, status_cb, env=env
                )

                # 无 tag 时，目录名可能是 spec 残余 → 重命名为实际分支名
                if not best_tag:
                    try:
                        actual_branch = subprocess.check_output(
                            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                            cwd=str(final_global_path),
                            text=True,
                            stderr=subprocess.DEVNULL,
                        ).strip()
                        if (
                            actual_branch
                            and actual_branch != version_base
                            and actual_branch != "HEAD"
                        ):
                            new_path = final_global_path.parent / actual_branch
                            if not new_path.exists():
                                final_global_path.rename(new_path)
                                final_global_path = new_path
                    except Exception:
                        pass

        return SyncResult(
            relative_path=str(final_global_path.relative_to(Path.home())),
            absolute_path=str(Path(final_global_path) / sub_dir)
            if sub_dir
            else str(final_global_path),
            ecosystem=ecosystem,
        )
    except Exception as e:
        log.error(f"[{name}] 同步失败: {e}")
        return None


def _get_root_project_name(root_dir: Path) -> str:
    """读取根项目名，供替换 scope '.' 用。"""
    pyproject_path = root_dir / "pyproject.toml"
    if pyproject_path.exists():
        try:
            import tomllib

            with open(pyproject_path, "rb") as f:
                data = tomllib.load(f)
            name = data.get("project", {}).get("name", "")
            if name:
                return name
        except Exception:
            pass
    pkg_path = root_dir / "package.json"
    if pkg_path.exists():
        try:
            with open(pkg_path) as f:
                data = json.load(f)
            name = data.get("name", "")
            if name:
                return name
        except Exception:
            pass
    return "."


def write_ref_lock_file(
    root_dir: Path,
    workspace_packages: dict[str, WorkspaceInfo],
    sync_results: dict[str, SyncResult],
    sources: list[str] | None = None,
    scope_deps: dict[str, dict[str, set]] | None = None,
):
    """写入 root ref.lock.yaml（v5 — ecosystem → scope → category → pkg）

    v5 格式:
      version: 5
      generated: "..."
      refs:
        python:
          <scope-name>:            # scope/workspace package 名, "." 表示 root
            dependencies:          # [project] dependencies
              dep: ~/.diy/ref/...
            dependency-groups:     # uv [dependency-groups]
              dev:
                pkg: ~/path
            optional-dependencies: # [project.optional-dependencies]
              test:
                pkg: ~/path
        node:
          <scope-name>:
            dependencies:
              dep: ~/.diy/ref/...
            dev-dependencies:
              dep: ~/.diy/ref/...
        source:
          <scope-name>:            # scope 名（对 source 等价于相对目录）
            host/owner/repo: ~/path
    """
    ref_lock_path = root_dir / ".diy" / "ref.lock.yaml"
    ref_lock_path.parent.mkdir(parents=True, exist_ok=True)

    import datetime as _dt

    generated = _dt.datetime.now(_dt.UTC).isoformat().replace("+00:00", "Z")

    data: dict = {"version": 5, "generated": generated}
    root_project_name = _get_root_project_name(root_dir)

    if scope_deps:
        # {eco: {scope_name: {category: {name: path}}}}
        refs: dict[str, dict] = {}
        for scope_name in sorted(scope_deps.keys()):
            categories = scope_deps[scope_name]
            for cat_key, dep_keys in sorted(categories.items()):
                for key in sorted(dep_keys):
                    sr = sync_results.get(key)
                    if not sr:
                        continue
                    rel_path = f"~/{sr.relative_path}"

                    if key.startswith("source:"):
                        name = key.split(":", 1)[1]
                        refs.setdefault("source", {}).setdefault(scope_name, {})[
                            name
                        ] = rel_path
                    else:
                        eco, pkg_name = key.split(":", 1)
                        # python/node 根 scope 用项目名代替 "."
                        resolved_scope = (
                            root_project_name
                            if scope_name == "." and eco in ("python", "node")
                            else scope_name
                        )

                        # 解析 category 类型
                        if cat_key == "dependencies":
                            refs.setdefault(eco, {}).setdefault(
                                resolved_scope, {}
                            ).setdefault("dependencies", {})[pkg_name] = rel_path
                        elif cat_key == "dev-dependencies":
                            refs.setdefault(eco, {}).setdefault(
                                resolved_scope, {}
                            ).setdefault("dev-dependencies", {})[pkg_name] = rel_path
                        elif cat_key.startswith("dependency-groups:"):
                            group = cat_key.split(":", 1)[1]
                            refs.setdefault(eco, {}).setdefault(
                                resolved_scope, {}
                            ).setdefault("dependency-groups", {}).setdefault(group, {})[
                                pkg_name
                            ] = rel_path
                        elif cat_key.startswith("optional-dependencies:"):
                            group = cat_key.split(":", 1)[1]
                            refs.setdefault(eco, {}).setdefault(
                                resolved_scope, {}
                            ).setdefault("optional-dependencies", {}).setdefault(
                                group, {}
                            )[pkg_name] = rel_path
                        else:
                            # 未知 category，作为 flat 兜底
                            refs.setdefault(eco, {}).setdefault(resolved_scope, {})[
                                cat_key
                            ] = rel_path

        if refs:
            data["refs"] = refs
    else:
        # Fallback: flat refs (v3/v4 compat for callers without scope info)
        flat_refs: dict[str, dict[str, str]] = {}
        ws_names = set(workspace_packages.keys())
        for key, sr in sorted(sync_results.items()):
            rel_path = f"~/{sr.relative_path}"
            if key.startswith("source:"):
                name = key.split(":", 1)[1]
                flat_refs.setdefault("source", {})[name] = rel_path
                continue
            eco, name = key.split(":", 1)
            if name in ws_names:
                continue
            flat_refs.setdefault(eco, {})[name] = rel_path
        if flat_refs:
            data["refs"] = flat_refs

    with open(ref_lock_path, "w", encoding="utf-8") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
    log.info(f"dependency mirror index 已更新: {ref_lock_path.relative_to(root_dir)}")


def update_tsconfig(
    root_dir: Path,
    workspace_packages: dict[str, WorkspaceInfo],
    sync_results: dict[str, SyncResult],
):
    tsconfig_path = root_dir / "tsconfig.ide.json"
    if not tsconfig_path.exists():
        return

    log.info("正在更新 tsconfig.ide.json paths...")
    try:
        with open(tsconfig_path, encoding="utf-8") as f:
            content = f.read()

        def strip_comments(text):
            lines = text.splitlines()
            cleaned = [
                line if not line.strip().startswith("//") else "" for line in lines
            ]
            return "\n".join(cleaned)

        import json as json_lib

        parsed = json_lib.loads(strip_comments(content), strict=False)
        current_paths = parsed.get("compilerOptions", {}).get("paths", {})
        new_paths = {}

        # 保留现有的 workspace 路径
        for key, val in current_paths.items():
            base_name = key[:-2] if key.endswith("/*") else key
            if base_name in workspace_packages:
                new_paths[key] = val

        for key, res in sync_results.items():
            if not key.startswith("node:"):
                continue
            name = key[5:]
            abs_path = Path(res.absolute_path)
            entry = ""
            candidates = [
                "dist/index.js",
                "build/index.js",
                "dist/index.d.ts",
                "src/index.ts",
                "src/tui.ts",
                "index.ts",
            ]
            for cand in candidates:
                if (abs_path / cand).exists():
                    entry = (
                        "" if cand.endswith(".js") or cand.endswith(".d.ts") else cand
                    )
                    break
            ts_path = str(abs_path / entry) if entry else str(abs_path)
            new_paths[name] = [ts_path]
            new_paths[f"{name}/*"] = [
                f"{str(abs_path)}/{os.path.dirname(entry) + '/*' if entry else '*'}"
            ]

        parsed.setdefault("compilerOptions", {})["baseUrl"] = "."
        parsed["compilerOptions"]["paths"] = new_paths
        with open(tsconfig_path, "w", encoding="utf-8") as f:
            json_lib.dump(parsed, f, indent=2)
            f.write("\n")
        log.info("tsconfig.ide.json 更新成功！")
    except Exception as e:
        log.error(f"更新 tsconfig.ide.json 失败: {e}")


def update_python_ide_config(root_dir: Path, sync_results: dict[str, SyncResult]):
    """更新 Python IDE 配置 (extraPaths)"""
    python_paths_raw = [
        res.absolute_path
        for key, res in sync_results.items()
        if key.startswith("python:")
    ]
    if not python_paths_raw:
        return

    # 更新 pyrightconfig.json（用绝对路径，pyright CLI 不认 VS Code 变量）
    pyright_path = root_dir / "pyrightconfig.json"
    if pyright_path.exists():
        log.info("正在更新 pyrightconfig.json extraPaths...")
        try:
            with open(pyright_path, encoding="utf-8") as f:
                data = json.load(f)
            existing_paths = data.get("extraPaths", [])
            existing_paths = [p for p in existing_paths if ".diy/ref" not in p]
            data["extraPaths"] = existing_paths + python_paths_raw
            with open(pyright_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=4)
        except Exception as e:
            log.error(f"更新 pyrightconfig.json 失败: {e}")


def manage_agent_symlinks(root_dir: Path):
    agents_md = root_dir / "AGENTS.md"
    if not agents_md.exists():
        return
    agent_files = ["GEMINI.md", "QWEN.md", "CLAUDE.md"]
    for agent_file in agent_files:
        agent_path = root_dir / agent_file
        try:
            if agent_path.exists() or agent_path.is_symlink():
                if agent_path.is_symlink() and os.readlink(agent_path) == "AGENTS.md":
                    continue
                if not agent_path.is_symlink():
                    backup = agent_path.with_suffix(".md.bak")
                    if backup.exists():
                        backup.unlink()
                    agent_path.rename(backup)
                else:
                    agent_path.unlink()
            os.symlink("AGENTS.md", agent_path)
            log.info(f"强制同步软链接: {agent_file} -> AGENTS.md")
        except Exception as e:
            log.error(f"无法为 {agent_file} 处理软链接: {e}")


def load_package_lock(root_dir: Path) -> dict[str, str]:
    lock_path = root_dir / "package-lock.json"
    resolved = {}
    if lock_path.exists():
        try:
            with open(lock_path, encoding="utf-8") as f:
                lock = json.load(f)
            for path, info in lock.get("packages", {}).items():
                if path and info.get("version"):
                    resolved[path.replace("node_modules/", "")] = info["version"]
        except Exception:
            pass
    return resolved


def load_uv_lock(root_dir: Path) -> dict[str, str]:
    lock_path = root_dir / "uv.lock"
    resolved = {}
    if lock_path.exists():
        try:
            import tomllib

            with open(lock_path, "rb") as f:
                data = tomllib.load(f)
            for pkg in data.get("package", []):
                name = pkg.get("name")
                ver = pkg.get("version")
                if name and ver:
                    resolved[name] = ver
        except Exception:
            pass
    return resolved


@dataclass
class ScannedDep:
    """一个被扫描到的依赖项。"""

    eco: str
    name: str
    version: str
    source_url: str = ""
    local_path: str = ""
    status: str = "pending"
    error_msg: str = ""


def _extract_v5_pkgs(
    categories: dict, eco: str, out: dict[str, dict[str, str]]
) -> None:
    """从 v5 categories 结构中提取 {eco: {name: path}} 到 out 字典。

    categories 可能是 {dependencies: {name: path}} 或 {dependency-groups: {group: {name: path}}}。
    """
    for cat_key, cat_val in categories.items():
        if isinstance(cat_val, dict):
            first_val = next(iter(cat_val.values())) if cat_val else None
            if isinstance(first_val, dict):
                # Sub-grouped: {group: {name: path}}
                for pkgs in cat_val.values():
                    for name, path in pkgs.items():
                        out.setdefault(eco, {})[name] = path
            else:
                # Flat: {name: path}
                for name, path in cat_val.items():
                    out.setdefault(eco, {})[name] = path


def scan_project_deps(root_dir):
    """扫描项目依赖（只读，不 clone）。"""
    result = []
    ref_lock_path = root_dir / ".diy" / "ref.lock.yaml"
    synced = {}  # {eco: {name: path}}
    if ref_lock_path.exists():
        try:
            with open(ref_lock_path) as f:
                import yaml as _y

                data = _y.safe_load(f) or {}
            raw = data.get("refs", {})
            # 兼容 v2 平面格式 { "python:rich": "~/.diy/...", } → 归一为 v3 嵌套格式
            ver = data.get("version", 0)
            if raw and isinstance(next(iter(raw.values())), str):
                flat: dict[str, dict[str, str]] = {}
                for k, v in raw.items():
                    if ":" in k:
                        eco, name = k.split(":", 1)
                        flat.setdefault(eco, {})[name] = v
                    else:
                        flat.setdefault("source", {})[k] = v
                synced = flat
            elif ver >= 5 and isinstance(raw, dict):
                # v5: refs → eco → scope → category → {name: path}
                flat_v5: dict[str, dict[str, str]] = {}
                for eco, scopes in raw.items():
                    if not isinstance(scopes, dict):
                        continue
                    for scope_name, entry in scopes.items():
                        if not isinstance(entry, dict):
                            continue
                        first_val = next(iter(entry.values())) if entry else None
                        if isinstance(first_val, dict):
                            # Has categories: {dependencies: {name: path}} etc.
                            _extract_v5_pkgs(entry, eco, flat_v5)
                        else:
                            # No categories: {name: path} (e.g. source)
                            for name, path in entry.items():
                                if isinstance(path, str):
                                    flat_v5.setdefault(eco, {})[name] = path
                synced = flat_v5
            else:
                synced = raw if isinstance(raw, dict) else {}
        except Exception:
            pass
    load_metadata_cache()
    workspace_packages = get_workspace_packages(root_dir)
    workspace_names = set(workspace_packages.keys())
    pkg_path = root_dir / "package.json"
    pyproject_path = root_dir / "pyproject.toml"
    pkg_lock = load_package_lock(root_dir)
    uv_lock = load_uv_lock(root_dir)
    all_deps = {}
    if pkg_path.exists():
        try:
            with open(pkg_path) as f:
                pkg = json.load(f)
            for n, s in {
                **pkg.get("dependencies", {}),
                **pkg.get("devDependencies", {}),
            }.items():
                all_deps[("node", n)] = pkg_lock.get(n, s)
        except Exception:
            pass
    if pyproject_path.exists():
        try:
            import tomllib

            with open(pyproject_path, "rb") as f:
                pyproject = tomllib.load(f)
            for d in pyproject.get("project", {}).get("dependencies", []):
                parts = re.split(r"[>=<]", d)
                if parts:
                    name = parts[0].strip()
                    all_deps[("python", name)] = uv_lock.get(
                        name, d[len(name) :].strip() or "*"
                    )
        except Exception:
            pass
    for wp in workspace_packages.values():
        eco = "node" if (Path(wp.path) / "package.json").exists() else "python"
        for n, s in {**wp.dependencies, **wp.dev_dependencies}.items():
            if (eco, n) not in all_deps:
                all_deps[(eco, n)] = pkg_lock.get(n, uv_lock.get(n, s))
    all_deps = {k: v for k, v in all_deps.items() if k[1] not in workspace_names}
    for (eco, name), version in sorted(all_deps.items()):
        cache_key = f"{eco}:{name}"
        cached = metadata_cache.get(cache_key, {})
        repo_url = (
            cached.get("repoUrl", "") if cached.get("lastVersion") == version else ""
        )
        local_path = synced.get(eco, {}).get(name, "")
        result.append(
            ScannedDep(
                eco=eco,
                name=name,
                version=version,
                source_url=repo_url,
                local_path=local_path,
                status="synced" if local_path else "pending",
            )
        )
    # Sources from all boundaries (root + sub-project diy.yaml)
    all_sources = _collect_sources_from_all_boundaries(root_dir)
    for spec in all_sources:
        url_part = spec.split("@")[0] if "@" in spec else spec
        ver = spec.split("@")[1] if "@" in spec and spec.rfind("@") > 7 else ""
        repo_info = parse_repo_url(url_part)
        if repo_info:
            name = f"{repo_info.owner}/{repo_info.repo}"
            local_path = synced.get("source", {}).get(name, "")
            result.append(
                ScannedDep(
                    eco="source",
                    name=name,
                    version=ver or "main",
                    source_url=url_part,
                    local_path=local_path,
                    status="synced" if local_path else "pending",
                )
            )
    return result


def _apply_ref_filters(
    root_dir: Path,
    all_deps: dict[tuple[str, str], str],
    scope_deps: dict[str, dict[str, set]],
) -> None:
    """应用 diy.yaml ref.{node,python}.{include,exclude} 过滤。

    从 diy.yaml 读取 include/exclude 模式（glob 风格），
    过滤 all_deps 和 scope_deps，匹配 exclude 或不在 include 中的条目被跳过。
    """
    import fnmatch

    diy_yml = root_dir / "diy.yaml"
    if not diy_yml.exists():
        return
    try:
        with open(diy_yml, encoding="utf-8") as f:
            import yaml as _y

            cfg = _y.safe_load(f) or {}
    except Exception:
        return

    ref_cfg = cfg.get("ref", {})
    for eco in ("node", "python"):
        eco_cfg = ref_cfg.get(eco, {})
        if not eco_cfg:
            continue
        include_pats: list[str] = eco_cfg.get("include", [])
        exclude_pats: list[str] = eco_cfg.get("exclude", [])
        if not include_pats and not exclude_pats:
            continue

        removed: set[tuple[str, str]] = set()
        for (e, name), ver in list(all_deps.items()):
            if e != eco:
                continue
            # include: 如果指定了，name 必须在任一模式中
            if include_pats and not any(fnmatch.fnmatch(name, p) for p in include_pats):
                removed.add((e, name))
                continue
            # exclude: name 匹配任一模式则跳过
            if exclude_pats and any(fnmatch.fnmatch(name, p) for p in exclude_pats):
                removed.add((e, name))
                continue

        for e, name in removed:
            all_deps.pop((e, name), None)
            # 同步清理 scope_deps
            dep_key = f"{e}:{name}"
            for scope in list(scope_deps.keys()):
                for cat in list(scope_deps.get(scope, {}).keys()):
                    scope_deps[scope][cat].discard(dep_key)
                # 删空 category
                scope_deps[scope] = {k: v for k, v in scope_deps[scope].items() if v}
                if not scope_deps[scope]:
                    del scope_deps[scope]


def _scan_sub_project_deps(
    root_dir: Path,
    all_deps: dict[tuple[str, str], str],
    scope_deps: dict[str, dict[str, set]],
    pkg_lock: dict[str, str],
    uv_lock: dict[str, str],
) -> None:
    """递归扫描所有子项目边界（package.json / pyproject.toml），补充依赖。

    只处理 root_dir 之下的子项目，跳过 root_dir 自身、
    workspace 已处理的、以及 node_modules 等 vendor 目录。
    同名依赖以先到为准（root/ workspace 优先）。
    """
    import tomllib

    already_done: set[Path] = set()
    for eco, name in all_deps:
        pass  # 只为下面的跳过逻辑做准备
    try:
        for marker in ("package.json", "pyproject.toml"):
            for match in sorted(root_dir.rglob(marker)):
                d = match.parent
                if d == root_dir or d in already_done:
                    continue
                if any(
                    p in d.relative_to(root_dir).parts
                    for p in ("node_modules", ".git", ".venv", "__pycache__")
                ):
                    continue
                already_done.add(d)
                scope_name = _get_scope_name(d)
                pkg_json = d / "package.json"
                pyproject = d / "pyproject.toml"
                if pkg_json.exists():
                    try:
                        with open(pkg_json, encoding="utf-8") as f:
                            pkg = json.load(f)
                        for n, s in pkg.get("dependencies", {}).items():
                            if ("node", n) not in all_deps:
                                all_deps[("node", n)] = pkg_lock.get(n, s)
                                _add_to_scope(scope_name, "dependencies", f"node:{n}")
                        for n, s in pkg.get("devDependencies", {}).items():
                            if ("node", n) not in all_deps:
                                all_deps[("node", n)] = pkg_lock.get(n, s)
                                _add_to_scope(
                                    scope_name, "dev-dependencies", f"node:{n}"
                                )
                    except Exception:
                        pass
                if pyproject.exists():
                    try:
                        with open(pyproject, "rb") as f:
                            pyproj = tomllib.load(f)
                        proj = pyproj.get("project", {})
                        for dep_str in proj.get("dependencies", []):
                            parts = re.split(r"[>=<]", dep_str)
                            if parts:
                                n = parts[0].strip()
                                v = uv_lock.get(n, dep_str[len(n) :].strip() or "*")
                                if ("python", n) not in all_deps:
                                    all_deps[("python", n)] = v
                                    _add_to_scope(
                                        scope_name, "dependencies", f"python:{n}"
                                    )
                        for group_name, deps_list in pyproj.get(
                            "dependency-groups", {}
                        ).items():
                            for dep_str in deps_list:
                                parts = re.split(r"[>=<]", dep_str)
                                if parts:
                                    n = parts[0].strip()
                                    v = uv_lock.get(n, dep_str[len(n) :].strip() or "*")
                                    if ("python", n) not in all_deps:
                                        all_deps[("python", n)] = v
                                        _add_to_scope(
                                            scope_name,
                                            f"dependency-groups:{group_name}",
                                            f"python:{n}",
                                        )
                    except Exception:
                        pass
    except PermissionError:
        pass


def _get_scope_name(d: Path) -> str:
    """从 package.json / pyproject.toml 读取项目名，用于 scope 标识。"""
    pkg_json = d / "package.json"
    pyproject = d / "pyproject.toml"
    if pkg_json.exists():
        try:
            with open(pkg_json, encoding="utf-8") as f:
                pkg = json.load(f)
            name = pkg.get("name", "")
            if name:
                return name
        except Exception:
            pass
    if pyproject.exists():
        try:
            import tomllib

            with open(pyproject, "rb") as f:
                data = tomllib.load(f)
            name = data.get("project", {}).get("name", "")
            if name:
                return name
        except Exception:
            pass
    return d.name


def sync_dependencies():
    log.info("sync start")
    _require_cmd("git", "安装 git 后重试：brew install git")
    load_npm_config()
    root_dir = find_project_root()
    log.info(f"识别到项目根目录: {root_dir}")

    pkg_path = root_dir / "package.json"
    pyproject_path = root_dir / "pyproject.toml"

    if not pkg_path.exists() and not pyproject_path.exists():
        log.error("未找到 package.json 或 pyproject.toml")
        return

    load_metadata_cache()
    workspace_packages = get_workspace_packages(root_dir)
    pkg_lock = load_package_lock(root_dir)
    uv_lock = load_uv_lock(root_dir)

    # all_deps: {(ecosystem, name): version}
    all_deps: dict[tuple[str, str], str] = {}
    # scope_deps: {scope_name: {category: {dep_key_string}}}
    # category: "dependencies", "dev-dependencies",
    #           "dependency-groups:<name>", "optional-dependencies:<name>",
    #           "source"
    scope_deps: dict[str, dict[str, set]] = {".": {"dependencies": set()}}

    def _add_to_scope(scope: str, category: str, key: str) -> None:
        """将依赖 key 添加到 scope_deps 的指定 category."""
        if scope not in scope_deps:
            scope_deps[scope] = {}
        if category not in scope_deps[scope]:
            scope_deps[scope][category] = set()
        scope_deps[scope][category].add(key)

    if pkg_path.exists():
        try:
            with open(pkg_path, encoding="utf-8") as f:
                pkg = json.load(f)
            for n, s in pkg.get("dependencies", {}).items():
                ver = pkg_lock.get(n, s)
                all_deps[("node", n)] = ver
                _add_to_scope(".", "dependencies", f"node:{n}")
            for n, s in pkg.get("devDependencies", {}).items():
                ver = pkg_lock.get(n, s)
                all_deps[("node", n)] = ver
                _add_to_scope(".", "dev-dependencies", f"node:{n}")
        except Exception:
            pass

    if pyproject_path.exists():
        try:
            import tomllib

            with open(pyproject_path, "rb") as f:
                pyproject = tomllib.load(f)
            proj = pyproject.get("project", {})
            # [project] dependencies
            for dep_str in proj.get("dependencies", []):
                parts = re.split(r"[>=<]", dep_str)
                if parts:
                    name = parts[0].strip()
                    ver = uv_lock.get(name, dep_str[len(name) :].strip() or "*")
                    all_deps[("python", name)] = ver
                    _add_to_scope(".", "dependencies", f"python:{name}")
            # [project.optional-dependencies] 可选依赖组
            for group_name, deps_list in proj.get("optional-dependencies", {}).items():
                for dep_str in deps_list:
                    parts = re.split(r"[>=<]", dep_str)
                    if parts:
                        name = parts[0].strip()
                        ver = uv_lock.get(name, dep_str[len(name) :].strip() or "*")
                        all_deps[("python", name)] = ver
                        _add_to_scope(
                            ".", f"optional-dependencies:{group_name}", f"python:{name}"
                        )
            # [dependency-groups] (uv 特性)
            for group_name, deps_list in pyproject.get("dependency-groups", {}).items():
                for dep_str in deps_list:
                    parts = re.split(r"[>=<]", dep_str)
                    if parts:
                        name = parts[0].strip()
                        ver = uv_lock.get(name, dep_str[len(name) :].strip() or "*")
                        all_deps[("python", name)] = ver
                        _add_to_scope(
                            ".", f"dependency-groups:{group_name}", f"python:{name}"
                        )
        except Exception:
            pass

    # 合并 workspace packages 的依赖
    for wp in workspace_packages.values():
        eco = "node" if (Path(wp.path) / "package.json").exists() else "python"
        if eco == "node":
            for n, s in wp.dependencies.items():
                ver = pkg_lock.get(n, uv_lock.get(n, s))
                all_deps[(eco, n)] = ver
                _add_to_scope(wp.name, "dependencies", f"{eco}:{n}")
            for n, s in wp.dev_dependencies.items():
                ver = pkg_lock.get(n, uv_lock.get(n, s))
                all_deps[(eco, n)] = ver
                _add_to_scope(wp.name, "dev-dependencies", f"{eco}:{n}")
        else:
            for n, s in wp.dependencies.items():
                ver = pkg_lock.get(n, uv_lock.get(n, s))
                all_deps[(eco, n)] = ver
                _add_to_scope(wp.name, "dependencies", f"{eco}:{n}")

    # 4. 递归扫描所有子项目边界（有 package.json / pyproject.toml 的目录）
    #    补充 workspace 之外的独立子项目依赖
    _scan_sub_project_deps(root_dir, all_deps, scope_deps, pkg_lock, uv_lock)

    # 过滤掉 workspace 内部包 — 它们是源码，不需要 clone
    workspace_names = set(workspace_packages.keys())
    all_deps = {k: v for k, v in all_deps.items() if k[1] not in workspace_names}

    # 清理 scope_deps 中 workspace 内部包的引用
    for scope in list(scope_deps.keys()):
        for cat in list(scope_deps.get(scope, {}).keys()):
            scope_deps[scope][cat] = {
                k
                for k in scope_deps[scope][cat]
                if k.split(":", 1)[1] not in workspace_names
            }
        # 删掉全空的 scope
        scope_deps[scope] = {k: v for k, v in scope_deps[scope].items() if v}
        if not scope_deps[scope]:
            del scope_deps[scope]

    # 应用 ref.{node,python}.{include,exclude} 过滤
    _apply_ref_filters(root_dir, all_deps, scope_deps)

    items = list(all_deps.items())
    # sources = root & sub-project diy.yaml
    sources = _collect_sources_from_all_boundaries(root_dir)
    if not isinstance(sources, list):
        sources = []
    # sources 归入根 scope 的 "source" category
    for src_spec in sources:
        url_part = src_spec.split("@")[0] if "@" in src_spec else src_spec
        repo_info = parse_repo_url(url_part)
        if repo_info:
            sname = f"{repo_info.host}/{repo_info.owner}/{repo_info.repo}"
            _add_to_scope(".", "source", f"source:{sname}")
    total_items = len(items) + len(sources)

    global_ref_base = GLOBAL_CACHE_DIR / "ref"
    log.info(
        f"开始同步 {total_items} 项（{len(items)} 依赖 + {len(sources)} 自定义 source）..."
    )

    import time

    start_time = time.time()
    sync_results: dict[str, SyncResult] = {}

    # 使用 Rich Live + Progress 进行可视化
    progress = Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        TimeElapsedColumn(),
    )

    with Live(progress, transient=False) as live:
        main_task = progress.add_task("[cyan]同步进度", total=total_items)

        # ---- Phase 1: 依赖同步 ----
        def task_wrapper(ecosystem, name, version):
            progress.update(
                main_task, description=f"[cyan]正在同步 [bold]{ecosystem}:{name}[/bold]"
            )
            res = process_package(
                name,
                str(version),
                ecosystem,
                global_ref_base,
                workspace_packages,
                status_cb=lambda msg: live.console.print(f"  {msg}"),
            )
            progress.advance(main_task)
            return (f"{ecosystem}:{name}", res)

        with ThreadPoolExecutor(max_workers=8) as executor:
            future_to_pkg = [
                executor.submit(task_wrapper, eco, name, ver)
                for (eco, name), ver in items
            ]
            for future in future_to_pkg:
                key, res = future.result()
                if res:
                    sync_results[key] = res

        # ---- Phase 2: Source 同步 ----
        def source_wrapper(i, source_spec):
            if not source_spec:
                progress.advance(main_task)
                return None
            url_part, version = source_spec, ""
            # 取最后一个 @ 分割（兼容 git@host:path@ref 和 https://...@ref）
            if "@" in source_spec:
                idx = source_spec.rfind("@")
                # 只有 @ 在非起始位置（排除 email 前缀的 @）时才分割
                if idx > 7:
                    url_part, version = source_spec[:idx], source_spec[idx + 1 :]

            repo_info = parse_repo_url(url_part)
            if not repo_info:
                progress.advance(main_task)
                return None
            name = f"{repo_info.host}/{repo_info.owner}/{repo_info.repo}"
            # 从 url_part 重建干净的 clone URL（剥掉 Web UI 路径 + @ref）
            if url_part.startswith("git@"):
                clone_url = url_part.rstrip("/")
            elif url_part.startswith("http"):
                import re

                clean = re.sub(
                    r"(/tree/[^/]+(?:/.*)?|/blob/[^/]+(?:/.*)?|/-/tree/[^/]+(?:/.*)?|/-/blob/[^/]+(?:/.*)?|/src/(?:branch|tag)/[^/]+(?:/.*)?)$",
                    "",
                    url_part,
                )
                clone_url = clean.rstrip("/")
            else:
                clone_url = (
                    f"https://{repo_info.host}/{repo_info.owner}/{repo_info.repo}"
                )

            live.console.print(
                f"  正在同步 Source [bold magenta]{name}[/bold magenta] 从 [yellow]{clone_url}[/yellow]"
            )

            final_p = None
            for n in [version, f"v{version}"] if version else ["main", "master"]:
                p = (
                    global_ref_base
                    / repo_info.host
                    / repo_info.owner
                    / repo_info.repo
                    / n
                )
                if p.exists():
                    final_p = p
                    break

            if not final_p:
                best = get_best_tag(clone_url, version.lstrip("v")) if version else None
                final_dir = best or version or "main"
                final_p = (
                    global_ref_base
                    / repo_info.host
                    / repo_info.owner
                    / repo_info.repo
                    / final_dir
                )
                if not final_p.exists():
                    final_p.parent.mkdir(parents=True, exist_ok=True)
                    cmd = ["git", "clone", "--depth", "1"]
                    if best:
                        cmd += ["--branch", best]
                    elif version:
                        cmd += ["--branch", version]
                    cmd += [clone_url, str(final_p)]
                    try:
                        _git_clone_with_progress(
                            cmd,
                            str(final_p),
                            name,
                            lambda msg: live.console.print(f"  {msg}"),
                        )
                    except Exception as e:
                        log.error(f"[source:{name}] 同步失败: {e}")
                        progress.advance(main_task)
                        return None

            progress.advance(main_task)
            return (
                f"source:{name}",
                SyncResult(
                    relative_path=str(final_p.relative_to(Path.home())),
                    absolute_path=str(final_p),
                    ecosystem="source",
                ),
            )

        if sources:
            with ThreadPoolExecutor(max_workers=4) as executor:
                futures = [
                    executor.submit(source_wrapper, i, s) for i, s in enumerate(sources)
                ]
                for f in futures:
                    res = f.result()
                    if res:
                        key, val = res
                        sync_results[key] = val

    save_metadata_cache()
    write_ref_lock_file(
        root_dir, workspace_packages, sync_results, sources, scope_deps=scope_deps
    )
    update_tsconfig(root_dir, workspace_packages, sync_results)
    update_python_ide_config(root_dir, sync_results)
    manage_agent_symlinks(root_dir)
    log.success(f"同步完成！耗时: {time.time() - start_time:.2f}s")
