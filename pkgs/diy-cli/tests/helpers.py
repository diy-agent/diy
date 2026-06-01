import os
import json
import yaml
from pathlib import Path
from unittest.mock import MagicMock, patch
import shutil

class FakeProject:
    def __init__(self, root: Path):
        self.root = root
        (root / ".diy" / "ref").mkdir(parents=True, exist_ok=True)
        
    def add_package_json(self, content: dict):
        with open(self.root / "package.json", "w") as f:
            json.dump(content, f)
            
    def add_package_lock(self, content: dict):
        with open(self.root / "package-lock.json", "w") as f:
            json.dump(content, f)

    def add_pyproject_toml(self, content: str):
        with open(self.root / "pyproject.toml", "w") as f:
            f.write(content)

    def add_uv_lock(self, content: str):
        with open(self.root / "uv.lock", "w") as f:
            f.write(content)

    def add_diy_yaml(self, content: dict):
        with open(self.root / "diy.yaml", "w") as f:
            yaml.dump(content, f)

    def add_tsconfig_ide(self, content: dict):
        with open(self.root / "tsconfig.ide.json", "w") as f:
            json.dump(content, f)

def sync_snapshot(root: Path) -> str:
    """生成项目同步后的状态快照。"""
    lines = []
    
    # 1. 检查 ref.lock.json
    lock_path = root / ".diy" / "ref.lock.json"
    if lock_path.exists():
        with open(lock_path, "r") as f:
            data = json.load(f)
        lines.append("RefLock:")
        for ws in data.get("workspaces", []):
            lines.append(f"  Workspace: {ws['name']} ({ws['ecosystem']})")
            for dep in ws.get("dependencies", []):
                mirror = dep.get("mirrorPath", "None")
                if mirror and "~" in mirror:
                    # 简化路径显示
                    mirror = mirror[mirror.find(".diy/ref"):]
                lines.append(f"    - {dep['name']}@{dep.get('resolvedVersion', '???')} -> {mirror}")

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
