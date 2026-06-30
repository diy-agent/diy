import json
import os
import shutil
from pathlib import Path
from unittest.mock import MagicMock, patch

import yaml


def _extract_snapshot_pkgs(categories: dict, eco: str, lines: list) -> None:
    """从 v5 categories 中提取 'eco:name: ~/path' 行到 lines."""
    for cat_key, cat_val in categories.items():
        if isinstance(cat_val, dict):
            first_val = next(iter(cat_val.values())) if cat_val else None
            if isinstance(first_val, dict):
                # Sub-grouped: {group: {name: path}}
                for pkgs in cat_val.values():
                    for name, path in pkgs.items():
                        if isinstance(path, str) and ".diy/ref" in path:
                            short = path[path.find(".diy/ref"):]
                            lines.append(f"  {eco}:{name}: ~/{short}")
            else:
                # Flat: {name: path}
                for name, path in cat_val.items():
                    if isinstance(path, str) and ".diy/ref" in path:
                        short = path[path.find(".diy/ref"):]
                        lines.append(f"  {eco}:{name}: ~/{short}")



class FakeProject:
    def __init__(self, root: Path) -> None:
        self.root = root
        (root / ".diy" / "ref").mkdir(parents=True, exist_ok=True)

    def add_package_json(self, content: dict) -> None:
        with open(self.root / "package.json", "w") as f:
            json.dump(content, f)
            
    def add_package_lock(self, content: dict) -> None:
        with open(self.root / "package-lock.json", "w") as f:
            json.dump(content, f)

    def add_pyproject_toml(self, content: str) -> None:
        with open(self.root / "pyproject.toml", "w") as f:
            f.write(content)

    def add_uv_lock(self, content: str) -> None:
        with open(self.root / "uv.lock", "w") as f:
            f.write(content)

    def add_diy_yaml(self, content: dict) -> None:
        with open(self.root / "diy.yaml", "w") as f:
            yaml.dump(content, f)

    def add_tsconfig_ide(self, content: dict) -> None:
        with open(self.root / "tsconfig.ide.json", "w") as f:
            json.dump(content, f)

def sync_snapshot(root: Path) -> str:
    """生成项目同步后的状态快照。"""
    lines = []

    # 1. 检查 ref.lock.yaml
    for ext in (".yaml", ".json"):
        lock_path = root / ".diy" / f"ref.lock{ext}"
        if lock_path.exists():
            break
    else:
        lock_path = None

    if lock_path and lock_path.exists():
        text = lock_path.read_text()
        lines.append("RefLock:")
        if lock_path.suffix == ".json":
            data = json.loads(text)
            for ws in data.get("workspaces", []):
                lines.append(f"  Workspace: {ws['name']} ({ws['ecosystem']})")
                for dep in ws.get("dependencies", []):
                    mirror = dep.get("mirrorPath", "None")
                    if mirror and "~" in mirror:
                        mirror = mirror[mirror.find(".diy/ref"):]
                    lines.append(f"    - {dep['name']}@{dep.get('resolvedVersion', '???')} -> {mirror}")
        else:
            # v2/v3/v4/v5 YAML
            data = yaml.safe_load(text) or {}
            ver = data.get("version", 0)
            refs = data.get("refs", {})
            scopes = data.get("scopes", {})
            if isinstance(refs, dict):
                if ver >= 5:
                    # v5: refs → eco → scope → category|pkgs → {name: path}
                    for eco, scopes_v5 in refs.items():
                        if not isinstance(scopes_v5, dict):
                            continue
                        for scope_name, entry in scopes_v5.items():
                            if not isinstance(entry, dict):
                                continue
                            first_val = next(iter(entry.values())) if entry else None
                            if isinstance(first_val, dict):
                                # Has categories: {dependencies: {name: path}} etc.
                                _extract_snapshot_pkgs(entry, eco, lines)
                            else:
                                # No categories: {name: path} (e.g. source)
                                for name, path in entry.items():
                                    if isinstance(path, str) and ".diy/ref" in path:
                                        short = path[path.find(".diy/ref"):]
                                        lines.append(f"  {eco}:{name}: ~/{short}")
                else:
                    # v2/v3: {python:rich: ~/path} or {python: {rich: {path: ~/path}}}
                    for eco, pkgs in refs.items():
                        if isinstance(pkgs, dict):
                            for name, path_or_info in pkgs.items():
                                if isinstance(path_or_info, str):
                                    path = path_or_info
                                elif isinstance(path_or_info, dict):
                                    path = path_or_info.get("path", "")
                                if path and ".diy/ref" in path:
                                    short = path[path.find(".diy/ref"):]
                                    lines.append(f"  {eco}:{name}: ~/{short}")
            if isinstance(scopes, dict):
                # v4 scopes 格式: {scopes: {scope: {eco: {name: path}}}}
                for scope_name, ecosystems in scopes.items():
                    for eco, packages in ecosystems.items():
                        if isinstance(packages, dict):
                            for name, path in packages.items():
                                if isinstance(path, str) and ".diy/ref" in path:
                                    short = path[path.find(".diy/ref"):]
                                    lines.append(f"  {eco}:{name}: ~/{short}")
    # 2. 检查 tsconfig.ide.json
    ts_path = root / "tsconfig.ide.json"
    if ts_path.exists():
        with open(ts_path, "r") as f:
            data = json.load(f)
        lines.append("TSConfig Paths:")
        paths = data.get("compilerOptions", {}).get("paths", {})
        for k, v in sorted(paths.items()):
            path_val = v[0]
            if ".diy/ref" in path_val:
                path_val = path_val[path_val.find(".diy/ref"):]
            lines.append(f"  {k}: {path_val}")

    # 3. 检查 .vscode/settings.json
    vscode_path = root / ".vscode" / "settings.json"
    if vscode_path.exists():
        with open(vscode_path, "r") as f:
            data = json.load(f)
        lines.append("VSCode ExtraPaths:")
        for p in data.get("python.analysis.extraPaths", []):
            if ".diy/ref" in p:
                p = p[p.find(".diy/ref"):]
            lines.append(f"  - {p}")

    return "\n".join(lines)
