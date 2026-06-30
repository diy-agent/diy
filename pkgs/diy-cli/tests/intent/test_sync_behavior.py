"""意图测试：混合生态同步逻辑。

表达："当项目同时包含 Node 和 Python 依赖时，sync 命令能正确隔离元数据并更新各自的 IDE 配置"。
"""

import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock
from diy.cli._sync import sync_dependencies
from ..helpers import FakeProject, sync_snapshot

@pytest.fixture
def mock_registry():
    """Mock NPM 和 PyPI 的响应。"""
    import json as json_lib
    
    def mock_npm_view(cmd: list[str], **kwargs) -> str:
        return ""

    def mock_urlopen(url: str, **kwargs) -> MagicMock:
        import json as json_lib
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp

        # 处理 NPM Registry API (以 registry.npmjs.org 开头或自定义)
        if "shared-pkg" in url and ("registry.npmjs.org" in url or "https://registry.npmjs.org" in url or "shared-pkg" in url):
            # 只有当它是 Node 相关的请求时才返回 Node 数据
            # 我们通过上下文来判断，虽然这里有点粗略
            if "pypi.org" not in url:
                data = {
                    "repository": {
                        "url": "git+https://github.com/npm-user/shared-js.git"
                    }
                }
                mock_resp.read.return_value = json_lib.dumps(data).encode()
                return mock_resp

        if "js-lib" in url or "pkg-a" in url or "pkg-b" in url:
             data = {"repository": {"url": "https://github.com/user/repo.git"}}
             mock_resp.read.return_value = json_lib.dumps(data).encode()
             return mock_resp

        # 处理 PyPI Registry API
        if "pypi.org" in url:
            if "shared-pkg" in url:
                data = {
                    "info": {
                        "project_urls": {
                            "Source": "https://github.com/py-user/shared-py.git"
                        }
                    }
                }
                mock_resp.read.return_value = json_lib.dumps(data).encode()
            elif "py-lib" in url:
                data = {
                    "info": {
                        "project_urls": {
                            "Source": "https://github.com/user/repo.git"
                        }
                    }
                }
                mock_resp.read.return_value = json_lib.dumps(data).encode()
        return mock_resp

    def _mock_git_clone(cmd: list[str], dest: str, label: str, status_cb, env=None) -> None:
        """Mock git clone: 创建目标目录，不实际执行 git"""
        from pathlib import Path as _P
        _P(dest).mkdir(parents=True, exist_ok=True)
        (Path(dest) / ".git").mkdir(parents=True, exist_ok=True)

    with patch("subprocess.check_output", side_effect=mock_npm_view), \
         patch("urllib.request.urlopen", side_effect=mock_urlopen), \
         patch("diy.cli._sync._git_clone_with_progress", side_effect=_mock_git_clone), \
         patch("diy.cli._sync.get_best_tag", return_value="v1.0.0"):
        yield

def test_sync_avoids_ecosystem_collision(tmp_path, mock_registry):
    """
    意图：同名包在不同生态下应指向不同的仓库。
    """
    # 1. 准备一个混合项目
    project_root = tmp_path / "my-project"
    project_root.mkdir()
    project = FakeProject(project_root)
    project.add_diy_yaml({"name": "test-project"})
    project.add_package_json({"name": "root", "workspaces": ["packages/*"]})

    # Node 子包
    js_pkg_dir = project_root / "packages" / "js-part"
    js_pkg_dir.mkdir(parents=True)
    js_pkg = FakeProject(js_pkg_dir)
    js_pkg.add_package_json({
        "name": "js-part",
        "dependencies": {"shared-pkg": "1.0.0"}
    })

    # Python 子包
    py_pkg_dir = project_root / "packages" / "py-part"
    py_pkg_dir.mkdir(parents=True)
    py_pkg = FakeProject(py_pkg_dir)
    py_pkg.add_pyproject_toml('[project]\nname = "py-part"\ndependencies = [\n  "shared-pkg",\n]')

    # 根目录 Lock
    project.add_package_lock({
        "packages": {
            "packages/js-part/node_modules/shared-pkg": {"version": "1.0.0"}
        }
    })
    project.add_uv_lock('[[package]]\nname = "shared-pkg"\nversion = "1.0.0"')

    project.add_tsconfig_ide({"compilerOptions": {"paths": {}}})

    # 2. 执行同步 (Mock 路径)
    home_dir = tmp_path / "home"
    home_dir.mkdir()
    cache_dir = home_dir / ".diy"
    meta_path = cache_dir / "meta.json"

    with patch("diy.cli._sync.Path.cwd", return_value=project_root), \
         patch("diy.cli._sync.Path.home", return_value=home_dir), \
         patch("diy.cli._sync.GLOBAL_CACHE_DIR", cache_dir), \
         patch("diy.cli._sync.METADATA_CACHE_PATH", meta_path):

        sync_dependencies()

        snapshot = sync_snapshot(project_root)

        # 验证 Node 子包的依赖 — 新格式 key→path 直接用 eco:name 区分
        assert "node:shared-pkg:" in snapshot
        assert ".diy/ref/github.com/npm-user/shared-js/v1.0.0" in snapshot

        # 验证 Python 子包的依赖 — 同名但不同生态，指向不同仓库
        assert "python:shared-pkg:" in snapshot
        assert ".diy/ref/github.com/py-user/shared-py/v1.0.0" in snapshot

def test_ide_config_updates(tmp_path, mock_registry):
    """
    意图：同步后自动更新 TSConfig 路径配置。
    """
    project_root = tmp_path / "ide-project"
    project_root.mkdir()
    project = FakeProject(project_root)
    project.add_diy_yaml({"name": "ide-test"})

    # 模拟已有 TS 配置
    project.add_tsconfig_ide({"compilerOptions": {"paths": {"old": ["./old"]}}})

    project.add_package_json({"dependencies": {"js-lib": "1.0.0"}})
    project.add_package_lock({"packages": {"node_modules/js-lib": {"version": "1.0.0"}}})
    project.add_pyproject_toml('[project]\ndependencies = ["py-lib"]')
    project.add_uv_lock('[[package]]\nname = "py-lib"\nversion = "2.0.0"')

    home_dir = tmp_path / "home"
    home_dir.mkdir()
    cache_dir = home_dir / ".diy"
    meta_path = cache_dir / "meta.json"

    with patch("diy.cli._sync.Path.cwd", return_value=project_root), \
         patch("diy.cli._sync.Path.home", return_value=home_dir), \
         patch("diy.cli._sync.GLOBAL_CACHE_DIR", cache_dir), \
         patch("diy.cli._sync.METADATA_CACHE_PATH", meta_path), \
         patch("subprocess.check_output", return_value="https://github.com/user/repo.git"):
        
        sync_dependencies()
        
        snapshot = sync_snapshot(project_root)
        
        # 验证 TSConfig 更新
        assert "TSConfig Paths:" in snapshot
        assert "js-lib: .diy/ref/github.com/user/repo/v1.0.0" in snapshot


def test_pruning_behavior(tmp_path, mock_registry):
    """
    意图：当依赖从清单中删除后，同步应自动从 IDE 配置中移除对应的路径。
    """
    project_root = tmp_path / "prune-project"
    project_root.mkdir()
    project = FakeProject(project_root)
    project.add_diy_yaml({"name": "prune-test"})
    
    # 1. 初始状态：有两个依赖
    project.add_package_json({"dependencies": {"pkg-a": "1.0.0", "pkg-b": "1.0.0"}})
    project.add_package_lock({
        "packages": {
            "node_modules/pkg-a": {"version": "1.0.0"},
            "node_modules/pkg-b": {"version": "1.0.0"}
        }
    })
    project.add_tsconfig_ide({"compilerOptions": {"paths": {}}})

    home_dir = tmp_path / "home"
    home_dir.mkdir()
    cache_dir = home_dir / ".diy"
    
    with patch("diy.cli._sync.Path.cwd", return_value=project_root), \
         patch("diy.cli._sync.Path.home", return_value=home_dir), \
         patch("diy.cli._sync.GLOBAL_CACHE_DIR", cache_dir), \
         patch("diy.cli._sync.METADATA_CACHE_PATH", cache_dir / "meta.json"), \
         patch("subprocess.check_output", return_value="https://github.com/user/repo.git"):
        
        sync_dependencies()
        snapshot_1 = sync_snapshot(project_root)
        assert "pkg-a: .diy/ref/github.com/user/repo/v1.0.0" in snapshot_1
        assert "pkg-b: .diy/ref/github.com/user/repo/v1.0.0" in snapshot_1

        # 2. 删除 pkg-b
        project.add_package_json({"dependencies": {"pkg-a": "1.0.0"}})
        # 注意：pkg-b 仍留在 package-lock.json 中 (模拟未运行 npm install 的情况)
        
        sync_dependencies()
        snapshot_2 = sync_snapshot(project_root)
        
        # 验证：pkg-a 还在，pkg-b 已被移除
        assert "pkg-a: .diy/ref/github.com/user/repo/v1.0.0" in snapshot_2
        assert "pkg-b" not in snapshot_2
