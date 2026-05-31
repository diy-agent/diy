import os
import json
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
                with open(pyproject_path, "r", encoding="utf-8") as f:
                    content = f.read()
                import re
                deps_match = re.search(r'dependencies\s*=\s*\[(.*?)\]', content, re.DOTALL)
                if deps_match:
                    dep_list = deps_match.group(1)
                    for dep_str in re.findall(r'"([^"]+)"', dep_list):
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
        version = "0.1.18"
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
            if not name:
                try:
                    with open(pyproject_path, "r", encoding="utf-8") as f:
                        content = f.read()
                    import re
                    name_match = re.search(r'name\s*=\s*"([^"]+)"', content)
                    if name_match: name = name_match.group(1)
                    version_match = re.search(r'version\s*=\s*"([^"]+)"', content)
                    if version_match: version = version_match.group(1)
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
            with open(root_pyproject_path, "r", encoding="utf-8") as f:
                content = f.read()
            import re
            # Extract tool.uv.workspace.members or tool.poetry.workspace.members
            workspace_match = re.search(r'\[tool\.(?:uv|poetry)\.workspace\][\s\S]*?members\s*=\s*\[(.*?)\]', content)
            if workspace_match:
                for pattern in re.findall(r'"([^"]+)"', workspace_match.group(1)):
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

    # 4. Check packages/ directory (fallback for both)
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
        version_base = version.lstrip("^~")
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
            final_dir_name = best_tag or version_base
            final_global_path = global_ref_base / repo_info.host / repo_info.owner / repo_info.repo / final_dir_name
            
            if not final_global_path.exists():
                final_global_path.parent.mkdir(parents=True, exist_ok=True)
                # 并发环境下必须静默，否则会破坏 Rich 进度条
                cmd = ["git", "clone", "--depth", "1"] 
                if best_tag: cmd += ["--branch", best_tag]
                cmd += [clone_url, str(final_global_path)]
                log.debug(f"[{name}] 执行 Git Clone: {' '.join(cmd)}")
                subprocess.check_call(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        return SyncResult(
            relative_path=str(final_global_path.relative_to(Path.home())), 
            absolute_path=str(Path(final_global_path) / sub_dir) if sub_dir else str(final_global_path),
            ecosystem=ecosystem
        )
    except Exception as e:
        log.error(f"[{name}] 同步失败: {e}")
        return None

def build_ref_lock(workspace_packages: Dict[str, WorkspaceInfo], sync_results: Dict[str, SyncResult]) -> Dict[str, Any]:
    import datetime
    
    def build_deps(deps: Dict[str, str], scope: str, ecosystem: str) -> List[Dict[str, Any]]:
        result = []
        for name, spec in sorted(deps.items()):
            res = sync_results.get(f"{ecosystem}:{name}")
            mirror_path = res.relative_path if res else None
            resolved_version = Path(mirror_path).name if mirror_path else None
            dep = {"name": name, "spec": spec, "scope": scope}
            if resolved_version: dep["resolvedVersion"] = resolved_version
            if mirror_path: dep["mirrorPath"] = mirror_path
            if any(spec.startswith(p) for p in ["git+", "http://", "https://", "git@", "file:", "workspace:"]):
                dep["origin"] = spec
            result.append(dep)
        return result

    workspaces = []
    for pkg in sorted(workspace_packages.values(), key=lambda x: (x.relative_path != ".", x.name)):
        manifest = "package.json" if pkg.relative_path == "." else f"{pkg.relative_path}/package.json"
        ecosystem = "node"
        if not (Path(pkg.path) / manifest).exists() and (Path(pkg.path) / "pyproject.toml").exists():
            manifest = "pyproject.toml" if pkg.relative_path == "." else f"{pkg.relative_path}/pyproject.toml"
            ecosystem = "python"

        deps = build_deps(pkg.dependencies, "runtime", ecosystem) + build_deps(pkg.dev_dependencies, "dev", ecosystem)
        deps.sort(key=lambda x: (x["name"], x["scope"]))
        
        workspaces.append({
            "id": f"{ecosystem}:{pkg.relative_path}",
            "name": pkg.name,
            "version": pkg.version,
            "ecosystem": ecosystem,
            "path": pkg.relative_path,
            "manifest": manifest,
            "dependencies": deps
        })
    
    return {
        "version": 1,
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "mirrorRoot": "~",
        "workspaces": workspaces
    }

def write_ref_lock_file(root_dir: Path, workspace_packages: Dict[str, WorkspaceInfo], sync_results: Dict[str, SyncResult]):
    ref_lock_path = root_dir / ".diy" / "ref.lock.json"
    ref_lock_path.parent.mkdir(parents=True, exist_ok=True)
    payload = build_ref_lock(workspace_packages, sync_results)
    with open(ref_lock_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
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
    # 用 ~ 替代 HOME 目录，减少隐私暴露和跨机器冲突
    home = str(Path.home())
    python_paths = [p.replace(home, "~") if p.startswith(home) else p for p in python_paths_raw]

    # 1. 更新 .vscode/settings.json
    vscode_dir = root_dir / ".vscode"
    settings_path = vscode_dir / "settings.json"
    if settings_path.exists():
        log.info("正在更新 .vscode/settings.json extraPaths...")
        try:
            import json5
            with open(settings_path, "r", encoding="utf-8") as f:
                data = json5.load(f)

            existing_paths = data.get("python.analysis.extraPaths", [])
            # 过滤掉旧的 .diy/ref 路径
            existing_paths = [p for p in existing_paths if ".diy/ref" not in p]
            data["python.analysis.extraPaths"] = existing_paths + python_paths

            with open(settings_path, "w", encoding="utf-8") as f:
                import json as json_lib
                json_lib.dump(data, f, indent=4)
        except Exception as e:
            log.error(f"更新 .vscode/settings.json 失败: {e}")

    # 2. 更新 pyrightconfig.json
    pyright_path = root_dir / "pyrightconfig.json"
    if pyright_path.exists():
        log.info("正在更新 pyrightconfig.json extraPaths...")
        try:
            with open(pyright_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            existing_paths = data.get("extraPaths", [])
            existing_paths = [p for p in existing_paths if ".diy/ref" not in p]
            data["extraPaths"] = existing_paths + python_paths
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
            with open(lock_path, "r", encoding="utf-8") as f:
                content = f.read()
            import re
            for block, _ in re.findall(r'\[\[package\]\](.*?)(\n\n|(?=\[\[package\]\])|$)', content, re.DOTALL):
                name = re.search(r'name\s*=\s*"([^"]+)"', block)
                ver = re.search(r'version\s*=\s*"([^"]+)"', block)
                if name and ver: resolved[name.group(1)] = ver.group(1)
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
            with open(pyproject_path, "r", encoding="utf-8") as f:
                content = f.read()
            import re
            m = re.search(r'dependencies\s*=\s*\[(.*?)\]', content, re.DOTALL)
            if m:
                for d in re.findall(r'"([^"]+)"', m.group(1)):
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
                if "@" in source_spec and not source_spec.startswith("git@"):
                    idx = source_spec.rfind("@")
                    if idx > 8: url_part, version = source_spec[:idx], source_spec[idx+1:]
                
                repo_info = parse_repo_url(url_part)
                if not repo_info: 
                    progress.advance(source_task)
                    return None
                name = f"{repo_info.owner}/{repo_info.repo}"
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
    write_ref_lock_file(root_dir, workspace_packages, sync_results)
    update_tsconfig(root_dir, workspace_packages, sync_results)
    update_python_ide_config(root_dir, sync_results)
    manage_agent_symlinks(root_dir)
    log.success(f"同步完成！耗时: {time.time() - start_time:.2f}s")
