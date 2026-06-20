import os
import json
import re
import subprocess
import shutil
import yaml
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, List, Optional, Any, Set
from dataclasses import dataclass, asdict
from rich.live import Live
from rich.console import Group
from rich.text import Text
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn, TimeElapsedColumn
from ._log import logger

log = logger.with_tag("sync")

GLOBAL_CACHE_DIR = Path.home() / ".diy"
METADATA_CACHE_PATH = GLOBAL_CACHE_DIR / "registry-cache.json"

metadata_cache: Dict[str, Any] = {}
metadata_lock = threading.Lock()

def clean_exec_output(output: str) -> str:
# ... (rest of the file)
    lines = output.splitlines()
    filtered = []
    for line in lines:
        l = line.strip()
        if not l: continue
        if l.startswith("Agent pid"): continue
        if "load ~/.bashrc" in l: continue
        if "Output: load" in l: continue
        filtered.append(l)
    return "\n".join(filtered).strip()

@dataclass
class WorkspaceInfo:
    name: str
    version: str
    path: str
    relative_path: str
    dependencies: Dict[str, str]
    dev_dependencies: Dict[str, str]

def find_project_root() -> Path:
    """从当前目录向上查找，直到找到 diy.yaml 为止。"""
    curr = Path.cwd().resolve()
    for parent in [curr] + list(curr.parents):
        if (parent / "diy.yaml").exists():
            return parent
    raise FileNotFoundError("未发现 `diy.yaml`。请确保你在一个 diy 项目目录下，或该项目已初始化。")

def get_workspace_packages(root_dir: Path) -> Dict[str, WorkspaceInfo]:
    workspace_map = {}
    
    def parse_python_deps(path: Path) -> Dict[str, str]:
        pyproject_path = path / "pyproject.toml"
        deps = {}
        if pyproject_path.exists():
            try:
                import tomllib
                with open(pyproject_path, "rb") as f:
                    pyproject = tomllib.load(f)
                for dep_str in pyproject.get("project", {}).get("dependencies", []):
                    d_parts = re.split(r'[>=<]', dep_str)
                    if d_parts:
                        d_name = d_parts[0].strip()
                        d_ver = dep_str[len(d_name):].strip() or "*"
                        deps[d_name] = d_ver
            except Exception: pass
        return deps

    def get_dir_info(path: Path, rel_path: str) -> Optional[WorkspaceInfo]:
        pkg_json_path = path / "package.json"
        pyproject_path = path / "pyproject.toml"
        
        name = ""
        version = "0.1.19"
        deps = {}
        dev_deps = {}

        if pkg_json_path.exists():
            try:
                with open(pkg_json_path, "r", encoding="utf-8") as f:
                    pkg = json.load(f)
                name = pkg.get("name", "")
                version = pkg.get("version", version)
                deps.update(pkg.get("dependencies", {}))
                dev_deps.update(pkg.get("devDependencies", {}))
            except Exception: pass
        
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
            except Exception: pass
        
        if name:
            return WorkspaceInfo(
                name=name,
                version=version,
                path=str(path),
                relative_path=rel_path,
                dependencies=deps,
                dev_dependencies=dev_deps
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
            with open(root_pkg_path, "r", encoding="utf-8") as f:
                root_pkg = json.load(f)
            workspaces = root_pkg.get("workspaces", [])
            if isinstance(workspaces, list):
                for pattern in workspaces:
                    base_dir_str = pattern.replace("/*", "")
                    full_base_dir = root_dir / base_dir_str
                    if full_base_dir.exists() and full_base_dir.is_dir():
                        for item in full_base_dir.iterdir():
                            if item.is_dir():
                                info = get_dir_info(item, str(item.relative_to(root_dir)))
                                if info: workspace_map[info.name] = info
        except Exception: pass

    # 3. Check Python workspaces from pyproject.toml
    root_pyproject_path = root_dir / "pyproject.toml"
    if root_pyproject_path.exists():
        try:
            import tomllib
            with open(root_pyproject_path, "rb") as f:
                pyproject = tomllib.load(f)
            # uv.workspace.members 或 poetry.workspace.members
            workspace_cfg = (
                pyproject.get("tool", {}).get("uv", {}).get("workspace", {})
                or pyproject.get("tool", {}).get("poetry", {}).get("workspace", {})
            )
            members = workspace_cfg.get("members", [])
            for pattern in members:
                base_dir_str = pattern.replace("/*", "")
                full_base_dir = root_dir / base_dir_str
                if full_base_dir.exists() and full_base_dir.is_dir():
                    if "/*" in pattern:
                        for item in full_base_dir.iterdir():
                            if item.is_dir():
                                info = get_dir_info(item, str(item.relative_to(root_dir)))
                                if info: workspace_map[info.name] = info
                    else:
                        info = get_dir_info(full_base_dir, str(full_base_dir.relative_to(root_dir)))
                        if info: workspace_map[info.name] = info
        except Exception: pass

    # 4. Check pkgs/ directory (fallback for both)
    packages_dir = root_dir / "packages"
    if packages_dir.exists():
        for item in packages_dir.iterdir():
            if item.is_dir() and item.name not in workspace_map:
                info = get_dir_info(item, str(item.relative_to(root_dir)))
                if info: workspace_map[info.name] = info
                    
    return workspace_map

metadata_cache: Dict[str, Any] = {}

def load_metadata_cache():
    global metadata_cache
    if METADATA_CACHE_PATH.exists():
        try:
            with open(METADATA_CACHE_PATH, "r", encoding="utf-8") as f:
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

def parse_repo_url(url: str) -> Optional[RepoInfo]:
    import re
    clean_url = url.strip()
    if clean_url.startswith("git+"): clean_url = clean_url[4:]
    # 剥掉 GitHub/GitLab/Gitea 的 Web UI 路径（/tree/..., /-/tree/..., /src/branch/...）
    clean_url = re.sub(r'(/tree/[^/]+(?:/.*)?|/blob/[^/]+(?:/.*)?|/-/tree/[^/]+(?:/.*)?|/-/blob/[^/]+(?:/.*)?|/src/(?:branch|tag)/[^/]+(?:/.*)?)$', '', clean_url)
    if clean_url.endswith(".git"): clean_url = clean_url[:-4]

    # git@host:owner/repo
    git_at_match = re.match(r"^git@([^:]+):([^/]+)/(.+)$", clean_url)
    if git_at_match:
        return RepoInfo(host=git_at_match.group(1), owner=git_at_match.group(2), repo=git_at_match.group(3))

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

def get_best_tag(repo_url: str, version: str) -> Optional[str]:
    try:
        clone_url = repo_url if repo_url.startswith("http") else f"https://{repo_url}"
        log.debug(f"[Git] 正在获取远端 Tag 信息: {clone_url}")
        # 静默 stderr 避免干扰进度条
        output = subprocess.check_output(["git", "ls-remote", "--tags", clone_url], stderr=subprocess.DEVNULL, text=True)
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
    try:
        # 获取用户配置的 registry (如淘宝镜像、公司私有镜像)
        npm_registry_url = subprocess.check_output(["npm", "config", "get", "registry"], text=True).strip().rstrip("/")
    except Exception:
        pass

def process_package(
    name: str,
    version: str,
    ecosystem: str,
    global_ref_base: Path,
    workspace_packages: Dict[str, WorkspaceInfo],
    status_cb: Optional[Any] = None
) -> Optional[SyncResult]:
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
        
        cache_key = f"{ecosystem}:{name}"
        with metadata_lock:
            cache_item = metadata_cache.get(cache_key)
        
        if cache_item and (cache_item.get("lastVersion") == version or version in str(cache_item.get("lastVersion", ""))):
            repo_url = cache_item.get("repoUrl", "")
            sub_dir = cache_item.get("subDir", "")
        else:
            if ecosystem == "node":
                log.debug(f"[{name}] 正在通过 Registry API 获取元数据...")
                try:
                    import urllib.request
                    import json as json_lib
                    api_url = f"{npm_registry_url}/{name.replace('/', '%2f')}"
                    with urllib.request.urlopen(api_url, timeout=10) as response:
                        data = json_lib.loads(response.read().decode())
                        repo_info = data.get("repository")
                        if not repo_info:
                            latest_ver = data.get("dist-tags", {}).get("latest")
                            if latest_ver:
                                repo_info = data.get("versions", {}).get(latest_ver, {}).get("repository")
                        
                        if isinstance(repo_info, dict):
                            repo_url = repo_info.get("url", "")
                            sub_dir = repo_info.get("directory", "")
                        elif isinstance(repo_info, str):
                            repo_url = repo_info
                except Exception as e:
                    log.debug(f"[{name}] API 请求失败 ({e})，回退到 npm view...")
                    try:
                        repo_url = clean_exec_output(subprocess.check_output(
                            ["npm", "view", name, "repository.url", "--no-workspaces"], 
                            text=True, timeout=30, stderr=subprocess.DEVNULL
                        ))
                        try:
                            sub_dir = clean_exec_output(subprocess.check_output(
                                ["npm", "view", name, "repository.directory", "--no-workspaces"], 
                                text=True, timeout=10, stderr=subprocess.DEVNULL
                            ))
                        except Exception: pass
                    except Exception: pass
            elif ecosystem == "python":
                log.debug(f"[{name}] 正在请求 PyPI Registry...")
                try:
                    import urllib.request
                    import json as json_lib
                    with urllib.request.urlopen(f"https://pypi.org/pypi/{name}/json", timeout=10) as response:
                        data = json_lib.loads(response.read().decode())
                        info = data.get("info", {})
                        project_urls = info.get("project_urls", {}) or {}
                        repo_url = project_urls.get("Source") or project_urls.get("GitHub") or project_urls.get("Homepage") or ""
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
                    metadata_cache[cache_key] = {"repoUrl": repo_url, "subDir": sub_dir, "lastVersion": version}
        
        if status_cb and repo_url:
            status_cb(f"正在同步 [bold cyan]{ecosystem}:{name}[/bold cyan] 从 [yellow]{repo_url}[/yellow]")

        if not repo_url:
            log.debug(f"[{ecosystem}:{name}] 未找到源码仓库地址")
            return None
            
        repo_info = parse_repo_url(repo_url)
        if not repo_info: return None
        
        clone_url = f"https://{repo_info.host}/{repo_info.owner}/{repo_info.repo}"
        version_base = re.sub(r'^[>=<~^!]+', '', version.replace(',', ' ').split()[0].strip())
        if not version_base or version_base == '*':
            version_base = 'main'
        possible_names = [version_base, f"v{version_base}"]
        
        final_global_path = None
        for p_name in possible_names:
            p = global_ref_base / repo_info.host / repo_info.owner / repo_info.repo / p_name
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
        
            final_global_path = global_ref_base / repo_info.host / repo_info.owner / repo_info.repo / final_dir_name
            
            if not final_global_path.exists():
                final_global_path.parent.mkdir(parents=True, exist_ok=True)
                cmd = ["git", "clone", "--depth", "1"] 
                if best_tag:
                    cmd += ["--branch", best_tag]
                cmd += [clone_url, str(final_global_path)]
                log.debug(f"[{name}] 执行 Git Clone: {' '.join(cmd)}")
                subprocess.check_call(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

                # 无 tag 时，目录名可能是 spec 残余 → 重命名为实际分支名
                if not best_tag:
                    try:
                        actual_branch = subprocess.check_output(
                            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                            cwd=str(final_global_path), text=True, stderr=subprocess.DEVNULL
                        ).strip()
                        if actual_branch and actual_branch != version_base and actual_branch != "HEAD":
                            new_path = final_global_path.parent / actual_branch
                            if not new_path.exists():
                                final_global_path.rename(new_path)
                                final_global_path = new_path
                    except Exception:
                        pass

        return SyncResult(
            relative_path=str(final_global_path.relative_to(Path.home())), 
            absolute_path=str(Path(final_global_path) / sub_dir) if sub_dir else str(final_global_path),
            ecosystem=ecosystem
        )
    except Exception as e:
        log.error(f"[{name}] 同步失败: {e}")
        return None

def build_ref_lock(
    workspace_packages: Dict[str, WorkspaceInfo],
    sync_results: Dict[str, SyncResult],
    sources: Optional[List[str]] = None,
) -> Dict[str, str]:
    """构建平面 ref 映射: key → mirror 路径。

    规则：
      - 只输出 sync_results 中存在的条目（已成功 clone）
      - workspace 内部包不输出
      - sources 以 "source:" 前缀输出
      - key 格式: {eco}:{name} 或 source:{owner/repo}
    """
    import datetime
    refs: Dict[str, str] = {}

    workspace_names = set(workspace_packages.keys())

    for key, sr in sorted(sync_results.items()):
        if key.startswith("source:"):
            # sources 保持 source:owner/repo 作为 key
            refs[key] = sr.relative_path
            continue

        # "python:name" or "node:name"
        eco, name = key.split(":", 1)
        if name in workspace_names:
            continue
        refs[key] = sr.relative_path

    return {
        "version": 2,
        "generated": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "refs": refs,
    }

def write_ref_lock_file(
    root_dir: Path,
    workspace_packages: Dict[str, WorkspaceInfo],
    sync_results: Dict[str, SyncResult],
    sources: Optional[List[str]] = None,
):
    ref_lock_path = root_dir / ".diy" / "ref.lock.yaml"
    ref_lock_path.parent.mkdir(parents=True, exist_ok=True)
    payload = build_ref_lock(workspace_packages, sync_results, sources)

    lines = [f"version: {payload['version']}"]
    lines.append(f'generated: "{payload["generated"]}"')
    refs = payload.get("refs", {})
    if refs:
        lines.append("")
        lines.append("refs:")
        for k, v in refs.items():
            lines.append(f"  {k}: ~/{v}")

    with open(ref_lock_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    log.info(f"dependency mirror index 已更新: {ref_lock_path.relative_to(root_dir)}")

def update_tsconfig(root_dir: Path, workspace_packages: Dict[str, WorkspaceInfo], sync_results: Dict[str, SyncResult]):
    tsconfig_path = root_dir / "tsconfig.ide.json"
    if not tsconfig_path.exists(): return
    
    log.info("正在更新 tsconfig.ide.json paths...")
    try:
        with open(tsconfig_path, "r", encoding="utf-8") as f:
            content = f.read()
        
        def strip_comments(text):
            lines = text.splitlines()
            cleaned = [line if not line.strip().startswith("//") else "" for line in lines]
            return "\n".join(cleaned)
        
        import json as json_lib
        parsed = json_lib.loads(strip_comments(content), strict=False)
        current_paths = parsed.get("compilerOptions", {}).get("paths", {})
        new_paths = {}
        
        # 保留现有的 workspace 路径
        for key, val in current_paths.items():
            base_name = key[:-2] if key.endswith("/*") else key
            if base_name in workspace_packages: new_paths[key] = val
        
        for key, res in sync_results.items():
            if not key.startswith("node:"): continue
            name = key[5:]
            abs_path = Path(res.absolute_path)
            entry = ""
            candidates = ["dist/index.js", "build/index.js", "dist/index.d.ts", "src/index.ts", "src/tui.ts", "index.ts"]
            for cand in candidates:
                if (abs_path / cand).exists():
                    entry = "" if cand.endswith(".js") or cand.endswith(".d.ts") else cand
                    break
            ts_path = str(abs_path / entry) if entry else str(abs_path)
            new_paths[name] = [ts_path]
            new_paths[f"{name}/*"] = [f"{str(abs_path)}/{os.path.dirname(entry) + '/*' if entry else '*'}"]

        parsed.setdefault("compilerOptions", {})["baseUrl"] = "."
        parsed["compilerOptions"]["paths"] = new_paths
        with open(tsconfig_path, "w", encoding="utf-8") as f:
            json_lib.dump(parsed, f, indent=2)
            f.write("\n")
        log.info("tsconfig.ide.json 更新成功！")
    except Exception as e:
        log.error(f"更新 tsconfig.ide.json 失败: {e}")

def update_python_ide_config(root_dir: Path, sync_results: Dict[str, SyncResult]):
    """更新 Python IDE 配置 (extraPaths)"""
    python_paths_raw = [res.absolute_path for key, res in sync_results.items() if key.startswith("python:")]
    if not python_paths_raw: return

    # 更新 pyrightconfig.json（用绝对路径，pyright CLI 不认 VS Code 变量）
    pyright_path = root_dir / "pyrightconfig.json"
    if pyright_path.exists():
        log.info("正在更新 pyrightconfig.json extraPaths...")
        try:
            with open(pyright_path, "r", encoding="utf-8") as f:
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
    if not agents_md.exists(): return
    agent_files = ["GEMINI.md", "QWEN.md", "CLAUDE.md"]
    for agent_file in agent_files:
        agent_path = root_dir / agent_file
        try:
            if agent_path.exists() or agent_path.is_symlink():
                if agent_path.is_symlink() and os.readlink(agent_path) == "AGENTS.md": continue
                if not agent_path.is_symlink():
                    backup = agent_path.with_suffix(".md.bak")
                    if backup.exists(): backup.unlink()
                    agent_path.rename(backup)
                else: agent_path.unlink()
            os.symlink("AGENTS.md", agent_path)
            log.info(f"强制同步软链接: {agent_file} -> AGENTS.md")
        except Exception as e: log.error(f"无法为 {agent_file} 处理软链接: {e}")

def load_package_lock(root_dir: Path) -> Dict[str, str]:
    lock_path = root_dir / "package-lock.json"
    resolved = {}
    if lock_path.exists():
        try:
            with open(lock_path, "r", encoding="utf-8") as f:
                lock = json.load(f)
            for path, info in lock.get("packages", {}).items():
                if path and info.get("version"):
                    resolved[path.replace("node_modules/", "")] = info["version"]
        except Exception: pass
    return resolved

def load_uv_lock(root_dir: Path) -> Dict[str, str]:
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
        except Exception: pass
    return resolved

def sync_dependencies():
    log.info("sync start")
    load_npm_config()
    root_dir = find_project_root()
    log.info(f"识别到项目根目录: {root_dir}")
    
    pkg_path = root_dir / "package.json"
    pyproject_path = root_dir / "pyproject.toml"
    project_config_path = root_dir / "diy.yaml"
    
    if not pkg_path.exists() and not pyproject_path.exists():
        log.error("未找到 package.json 或 pyproject.toml")
        return

    project_config = {}
    if project_config_path.exists():
        try:
            with open(project_config_path, "r", encoding="utf-8") as f:
                project_config = yaml.safe_load(f) or {}
        except Exception: pass

    load_metadata_cache()
    workspace_packages = get_workspace_packages(root_dir)
    pkg_lock = load_package_lock(root_dir)
    uv_lock = load_uv_lock(root_dir)
    
    # all_deps: {(ecosystem, name): version}
    all_deps: Dict[tuple[str, str], str] = {}
    
    if pkg_path.exists():
        try:
            with open(pkg_path, "r", encoding="utf-8") as f:
                pkg = json.load(f)
            manifest = {**(pkg.get("dependencies", {})), **(pkg.get("devDependencies", {}))}
            for n, s in manifest.items():
                all_deps[("node", n)] = pkg_lock.get(n, s)
        except Exception: pass
        
    if pyproject_path.exists():
        try:
            import tomllib
            with open(pyproject_path, "rb") as f:
                pyproject = tomllib.load(f)
            for d in pyproject.get("project", {}).get("dependencies", []):
                parts = re.split(r'[>=<]', d)
                if parts:
                    name = parts[0].strip()
                    all_deps[("python", name)] = uv_lock.get(name, d[len(name):].strip() or "*")
        except Exception: pass
    
    # 合并 workspace packages 的依赖
    for pkg in workspace_packages.values():
        ecosystem = "node" if (Path(pkg.path) / "package.json").exists() else "python"
        for n, s in {**pkg.dependencies, **pkg.dev_dependencies}.items():
            if (ecosystem, n) not in all_deps:
                all_deps[(ecosystem, n)] = pkg_lock.get(n, uv_lock.get(n, s))

    # 过滤掉 workspace 内部包 — 它们是源码，不需要 clone
    workspace_names = set(workspace_packages.keys())
    all_deps = {k: v for k, v in all_deps.items() if k[1] not in workspace_names}

    global_ref_base = GLOBAL_CACHE_DIR / "ref"
    log.info(f"开始同步 {len(all_deps)} 个活跃依赖...")
    
    import time
    start_time = time.time()
    sync_results: Dict[str, SyncResult] = {}
    
    items = list(all_deps.items())
    
    # 使用 Rich Live + Progress 进行可视化
    status_label = Text("准备中...", style="dim")
    progress = Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        TimeElapsedColumn(),
    )
    
    render_group = Group(progress, status_label)
    with Live(render_group, transient=True) as live:
        main_task = progress.add_task("[cyan]总体进度", total=len(items))
        
        def task_wrapper(ecosystem, name, version):
            res = process_package(
                name, str(version), ecosystem, global_ref_base, workspace_packages,
                status_cb=lambda msg: setattr(status_label, "plain", msg)
            )
            progress.advance(main_task)
            return (f"{ecosystem}:{name}", res)

        with ThreadPoolExecutor(max_workers=8) as executor:
            future_to_pkg = [executor.submit(task_wrapper, eco, name, ver) for (eco, name), ver in items]
            for future in future_to_pkg:
                key, res = future.result()
                if res:
                    sync_results[key] = res
            
    sources = project_config.get("sources", [])
    if isinstance(sources, list) and sources:
        log.info(f"开始同步 {len(sources)} 个自定义 Source...")
        status_label = Text("准备同步 Sources...", style="dim")
        progress = Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            TimeElapsedColumn(),
        )
        
        render_group = Group(progress, status_label)
        with Live(render_group, transient=True) as live:
            source_task = progress.add_task("[magenta]Source 进度", total=len(sources))
            
            def source_wrapper(i, source_spec):
                if not source_spec: 
                    progress.advance(source_task)
                    return None
                url_part, version = source_spec, ""
                # 取最后一个 @ 分割（兼容 git@host:path@ref 和 https://...@ref）
                if "@" in source_spec:
                    idx = source_spec.rfind("@")
                    # 只有 @ 在非起始位置（排除 email 前缀的 @）时才分割
                    if idx > 7:
                        url_part, version = source_spec[:idx], source_spec[idx+1:]
                
                repo_info = parse_repo_url(url_part)
                if not repo_info: 
                    progress.advance(source_task)
                    return None
                name = f"{repo_info.owner}/{repo_info.repo}"
                # 从 url_part 重建干净的 clone URL（剥掉 Web UI 路径 + @ref）
                if url_part.startswith("git@"):
                    clone_url = url_part.rstrip("/")
                elif url_part.startswith("http"):
                    # 剥掉 Web UI 路径后缀
                    import re
                    clean = re.sub(r'(/tree/[^/]+(?:/.*)?|/blob/[^/]+(?:/.*)?|/-/tree/[^/]+(?:/.*)?|/-/blob/[^/]+(?:/.*)?|/src/(?:branch|tag)/[^/]+(?:/.*)?)$', '', url_part)
                    clone_url = clean.rstrip("/")
                else:
                    clone_url = f"https://{repo_info.host}/{repo_info.owner}/{repo_info.repo}"
                
                status_label.plain = f"正在同步 Source [bold magenta]{name}[/bold magenta] 从 [yellow]{clone_url}[/yellow]"
                
                final_p = None
                for n in ([version, f"v{version}"] if version else ["main", "master"]):
                    p = global_ref_base / repo_info.host / repo_info.owner / repo_info.repo / n
                    if p.exists(): final_p = p; break
                
                if not final_p:
                    best = get_best_tag(clone_url, version.lstrip("v")) if version else None
                    final_dir = best or version or "main"
                    final_p = global_ref_base / repo_info.host / repo_info.owner / repo_info.repo / final_dir
                    if not final_p.exists():
                        final_p.parent.mkdir(parents=True, exist_ok=True)
                        cmd = ["git", "clone", "--depth", "1"]
                        if best: cmd += ["--branch", best]
                        elif version: cmd += ["--branch", version]
                        cmd += [clone_url, str(final_p)]
                        subprocess.check_call(cmd, stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
                
                progress.advance(source_task)
                return (f"source:{name}", SyncResult(
                    relative_path=str(final_p.relative_to(Path.home())), 
                    absolute_path=str(final_p),
                    ecosystem="source"
                ))

            with ThreadPoolExecutor(max_workers=4) as executor:
                futures = [executor.submit(source_wrapper, i, s) for i, s in enumerate(sources)]
                for f in futures:
                    res = f.result()
                    if res:
                        key, val = res
                        sync_results[key] = val

    save_metadata_cache()
    write_ref_lock_file(root_dir, workspace_packages, sync_results, sources)
    update_tsconfig(root_dir, workspace_packages, sync_results)
    update_python_ide_config(root_dir, sync_results)
    manage_agent_symlinks(root_dir)
    log.success(f"同步完成！耗时: {time.time() - start_time:.2f}s")
