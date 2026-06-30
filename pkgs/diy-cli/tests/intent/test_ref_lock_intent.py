"""意图测试：ref.lock.yaml 格式与 diy sync 行为。

新格式设计目标：
  - 平面 key→path 映射（不复制 manifest 结构）
  - 只取直接依赖（pyproject.toml/package.json 声明的），忽略传递依赖
  - 版本号取自 uv.lock / package-lock.json（包管理器已解析好）
  - diy.yaml sources 也纳入映射
  - workspace 内部包不出现在 ref 中
  - 依赖查找规则：名字来自 manifest，版本来自 lock 文件

语法（assert_intent）：
  $ <command>              — 执行命令
  <text line>              — 预期输出行（substring 匹配）
  { ... }                  — JSON 预期（结构匹配）
  # <comment>              — 注释行（跳过）
"""

import json
import os
from pathlib import Path
import pytest
from unittest.mock import patch, MagicMock

from ..helpers import FakeProject, sync_snapshot


def _mock_git_clone(cmd: list[str], dest: str, label: str, status_cb, env=None) -> None:
    """Mock git clone: 创建目标目录，不实际执行 git"""
    Path(dest).mkdir(parents=True, exist_ok=True)
    (Path(dest) / ".git").mkdir(parents=True, exist_ok=True)


def _assert_ref_yaml(root: Path, expected_entries: dict[str, str]) -> None:
    """断言 ref.lock.yaml 包含指定的 key→path 映射（v4/v5 格式）。"""
    import yaml as _yaml
    ref_path = root / ".diy" / "ref.lock.yaml"
    assert ref_path.exists(), f"{ref_path} 不存在"

    data = _yaml.safe_load(ref_path.read_text())
    assert isinstance(data, dict), f"ref.lock.yaml 应为 dict, 实际: {type(data)}"

    ver = data.get("version")
    assert ver in (4, 5), f"version 应为 4 或 5, 实际: {ver}"

    # 展平所有 ecosystem → name → path
    flat: dict[str, str] = {}

    if ver >= 5 and "refs" in data:
        # v5: refs → eco → scope → category|pkgs → {name: path}
        for eco, scopes in data["refs"].items():
            if not isinstance(scopes, dict):
                continue
            for scope_name, categories in scopes.items():
                if not isinstance(categories, dict):
                    continue
                first_val = next(iter(categories.values())) if categories else None
                if isinstance(first_val, dict):
                    # Has categories: {dependencies: {name: path}} or
                    # {dependency-groups: {group: {name: path}}}
                    for cat_key, cat_val in categories.items():
                        if not isinstance(cat_val, dict):
                            continue
                        sub_first = next(iter(cat_val.values())) if cat_val else None
                        if isinstance(sub_first, dict):
                            # Sub-grouped: {group: {name: path}}
                            for pkgs in cat_val.values():
                                for name, path in pkgs.items():
                                    flat[f"{eco}:{name}"] = path
                        else:
                            # Flat: {name: path}
                            for name, path in cat_val.items():
                                flat[f"{eco}:{name}"] = path
                else:
                    # No categories — scope directly maps to {name: path} (e.g. source)
                    for name, path in categories.items():
                        flat[f"{eco}:{name}"] = path
    elif "scopes" in data:
        # v4: scopes → scope → eco → name → path
        scopes = data.get("scopes", {})
        for scope_name, ecosystems in scopes.items():
            for eco, packages in ecosystems.items():
                for name, path in packages.items():
                    flat[f"{eco}:{name}"] = path
    elif "refs" in data:
        # v2/v3: refs → eco → name → path
        refs = data["refs"]
        for eco, packages in refs.items():
            if isinstance(packages, dict):
                for name, path in packages.items():
                    if isinstance(path, str):
                        flat[f"{eco}:{name}"] = path

    for key, path in expected_entries.items():
        assert key in flat, f"缺少 key: {key}, 实际有: {sorted(flat.keys())}"
        assert flat[key] == path, (
            f"key {key} 路径不匹配:\n"
            f"  期望: {path}\n"
            f"  实际: {flat[key]}"
        )


class TestRefLockFormat:
    """ref.lock.yaml 格式正确性。"""

    def test_flat_mapping_just_one_key_per_line(self, tmp_path):
        """意图：每行一个 key→path，纯平面对应，无嵌套结构。"""
        project = FakeProject(tmp_path)
        project.add_diy_yaml({"name": "flat-test"})
        project.add_pyproject_toml(
            '[project]\nname = "flat-test"\ndependencies = ["rich"]'
        )
        # uv.lock 中 rich 版本为 15.0.0
        project.add_uv_lock(
            '[[package]]\nname = "rich"\nversion = "15.0.0"\n'
        )

        home = tmp_path / "home"
        home.mkdir()
        cache = home / ".diy"

        with patch("diy.cli._sync.Path.cwd", return_value=tmp_path), \
             patch("diy.cli._sync.Path.home", return_value=home), \
             patch("diy.cli._sync.GLOBAL_CACHE_DIR", cache), \
             patch("diy.cli._sync.METADATA_CACHE_PATH", cache / "meta.json"), \
             patch("urllib.request.urlopen") as mock_urlopen, \
             patch("diy.cli._sync.get_best_tag", return_value=None), \
             patch("diy.cli._sync._git_clone_with_progress", side_effect=_mock_git_clone):
            # Mock PyPI 返回 rich 在 github.com/Textualize/rich
            resp = MagicMock()
            resp.__enter__.return_value = resp
            resp.read.return_value = json.dumps({
                "info": {"project_urls": {"Source": "https://github.com/Textualize/rich"}}
            }).encode()
            mock_urlopen.return_value = resp

            from diy.cli._sync import sync_dependencies
            sync_dependencies()

        _assert_ref_yaml(tmp_path, {
            "python:rich": "~/.diy/ref/github.com/Textualize/rich/15.0.0",
        })

    def test_workspace_internal_deps_excluded(self, tmp_path):
        """意图：monorepo workspace 内部包不写入 ref.lock.yaml。"""
        root = tmp_path / "mono"
        root.mkdir()
        pkg_dir = root / "packages" / "my-lib"
        pkg_dir.mkdir(parents=True)

        # diy.yaml
        import yaml as _yaml
        (root / "diy.yaml").write_text(_yaml.dump({"name": "mono", "sources": []}))
        # pyproject.toml — workspace members（有效 TOML）
        (root / "pyproject.toml").write_text(
            '[project]\nname = "mono"\ndependencies = ["my-lib"]\n'
            '[tool.uv.workspace]\nmembers = ["packages/my-lib"]\n'
            '[tool.uv.sources]\nmy-lib = { workspace = true }\n'
        )
        # 子包 pyproject.toml — 必须有 [project] header 才能被 get_workspace_packages 识别
        (pkg_dir / "pyproject.toml").write_text(
            '[project]\nname = "my-lib"\nversion = "0.1.0"\n'
        )
        # uv.lock
        (root / "uv.lock").write_text(
            '[[package]]\nname = "my-lib"\nversion = "0.1.0"\nsource = { workspace = true }\n'
        )

        home = tmp_path / "home"
        home.mkdir()
        cache = home / ".diy"
        (root / ".diy").mkdir(parents=True, exist_ok=True)

        with patch("diy.cli._sync.Path.cwd", return_value=root), \
             patch("diy.cli._sync.Path.home", return_value=home), \
             patch("diy.cli._sync.GLOBAL_CACHE_DIR", cache), \
             patch("diy.cli._sync.METADATA_CACHE_PATH", cache / "meta.json"), \
             patch("diy.cli._sync._git_clone_with_progress", side_effect=_mock_git_clone):
            from diy.cli._sync import sync_dependencies
            sync_dependencies()

        ref_path = root / ".diy" / "ref.lock.yaml"
        assert ref_path.exists(), "ref.lock.yaml 应该生成"
        text = ref_path.read_text()
        assert "my-lib" not in text, (
            f"workspace 内部包 my-lib 不应出现在 ref.lock.yaml\n"
            f"实际内容:\n{text}"
        )

    def test_version_from_lock_not_spec(self, tmp_path):
        """意图：pyproject 声明 `pyyaml>=6.0`，但 ref 路径取 uv.lock 解析结果 `6.0.2`。"""
        project = FakeProject(tmp_path)
        project.add_diy_yaml({"name": "version-test"})
        project.add_pyproject_toml(
            '[project]\nname = "version-test"\ndependencies = ["pyyaml>=6.0"]\n'
        )
        # uv.lock 中 pyyaml 实际版本为 6.0.2
        project.add_uv_lock(
            '[[package]]\nname = "pyyaml"\nversion = "6.0.2"\n'
        )

        home = tmp_path / "home"
        home.mkdir()
        cache = home / ".diy"

        with patch("diy.cli._sync.Path.cwd", return_value=tmp_path), \
             patch("diy.cli._sync.Path.home", return_value=home), \
             patch("diy.cli._sync.GLOBAL_CACHE_DIR", cache), \
             patch("diy.cli._sync.METADATA_CACHE_PATH", cache / "meta.json"), \
             patch("urllib.request.urlopen") as mock_urlopen, \
             patch("diy.cli._sync.get_best_tag", return_value=None), \
             patch("diy.cli._sync._git_clone_with_progress", side_effect=_mock_git_clone):
            resp = MagicMock()
            resp.__enter__.return_value = resp
            resp.read.return_value = json.dumps({
                "info": {"project_urls": {"Source": "https://github.com/yaml/pyyaml"}}
            }).encode()
            mock_urlopen.return_value = resp

            from diy.cli._sync import sync_dependencies
            sync_dependencies()

        ref_path = tmp_path / ".diy" / "ref.lock.yaml"
        text = ref_path.read_text()
        # 路径末段必须是 6.0.2，不能是 >=6.0
        assert "pyyaml/6.0.2" in text, (
            f"版本应取自 uv.lock (6.0.2)，而不是 pyproject spec (>=6.0)\n"
            f"实际:\n{text}"
        )
        assert ">=" not in text, (
            f"路径中不应包含未解析的 spec 字符串 '>='\n"
            f"实际:\n{text}"
        )

    def test_nodejs_direct_dep_only_ignores_transitive(self, tmp_path):
        """意图：Node 项目只取 package.json 直接依赖，忽略传递依赖。

        package.json → react（直接），package-lock.json 含 react + 其 50 个传递依赖。
        ref.lock.yaml 应只有 `node:react`，不出现 react-dom、scheduler 等。
        """
        project = FakeProject(tmp_path)
        project.add_diy_yaml({"name": "node-test"})
        project.add_package_json({
            "name": "node-test",
            "dependencies": {"react": "^18.2.0"},
        })
        # package-lock.json 含 react + 大量传递依赖
        project.add_package_lock({
            "packages": {
                "node_modules/react": {"version": "18.2.0", "resolved": "..."},
                "node_modules/loose-envify": {"version": "1.4.0", "resolved": "..."},
                "node_modules/js-tokens": {"version": "4.0.0", "resolved": "..."},
            },
        })

        home = tmp_path / "home"
        home.mkdir()
        cache = home / ".diy"

        with patch("diy.cli._sync.Path.cwd", return_value=tmp_path), \
             patch("diy.cli._sync.Path.home", return_value=home), \
             patch("diy.cli._sync.GLOBAL_CACHE_DIR", cache), \
             patch("diy.cli._sync.METADATA_CACHE_PATH", cache / "meta.json"), \
             patch("subprocess.check_output") as mock_co, \
             patch("diy.cli._sync._git_clone_with_progress", side_effect=_mock_git_clone):
            # npm view 返回 react 的仓库 URL
            mock_co.return_value = "https://github.com/facebook/react.git"

            from diy.cli._sync import sync_dependencies
            sync_dependencies()

        _assert_ref_yaml(tmp_path, {
            "node:react": "~/.diy/ref/github.com/facebook/react/18.2.0",
        })

    def test_sources_from_diy_yaml(self, tmp_path):
        """意图：diy.yaml 的 sources 也写入 ref.lock.yaml，key 前缀为 source:。"""
        project = FakeProject(tmp_path)
        project.add_diy_yaml({
            "name": "source-test",
            "sources": [
                "https://github.com/github/gh-aw@main",
                "https://github.com/github/docs@main",
            ],
        })
        project.add_pyproject_toml(
            '[project]\nname = "source-test"\ndependencies = []\n'
        )

        home = tmp_path / "home"
        home.mkdir()
        cache = home / ".diy"

        with patch("diy.cli._sync.Path.cwd", return_value=tmp_path), \
             patch("diy.cli._sync.Path.home", return_value=home), \
             patch("diy.cli._sync.GLOBAL_CACHE_DIR", cache), \
             patch("diy.cli._sync.METADATA_CACHE_PATH", cache / "meta.json"), \
             patch("diy.cli._sync.get_best_tag", return_value=None), \
             patch("diy.cli._sync._git_clone_with_progress", side_effect=_mock_git_clone):
            from diy.cli._sync import sync_dependencies
            sync_dependencies()

        _assert_ref_yaml(tmp_path, {
            "source:github.com/github/gh-aw": "~/.diy/ref/github.com/github/gh-aw/main",
            "source:github.com/github/docs": "~/.diy/ref/github.com/github/docs/main",
        })


class TestRefAdd:
    """diy ref add 行为测试。"""

    def _setup_boundary(self, tmp_path, diy_yaml: dict | None = None) -> Path:
        """创建项目边界（.git + diy.yaml）并返回路径"""
        if diy_yaml is None:
            diy_yaml = {"sources": []}
        (tmp_path / ".git").mkdir()
        import yaml as _y
        (tmp_path / "diy.yaml").write_text(_y.dump(diy_yaml))
        return tmp_path

    def test_add_invalid_url_rejected(self, tmp_path):
        """意图：非 git 仓库的 URL（如 deepwiki）应拒绝添加"""
        root = self._setup_boundary(tmp_path)

        with patch("diy.cli.ref.find_project_root", return_value=root), patch("diy.cli.ref.Path.cwd", return_value=root), \
             patch("subprocess.run") as mock_run:
            # git ls-remote 失败
            mock_run.return_value.returncode = 128

            from diy.cli.ref import ref_add
            with pytest.raises(SystemExit):
                ref_add(url="https://deepwiki.com/brentyi/tyro")

        # diy.yaml 不应包含该 URL
        import yaml as _y
        cfg = _y.safe_load((root / "diy.yaml").read_text()) or {}
        assert "https://deepwiki.com/brentyi/tyro" not in str(cfg.get("sources", []))

    def test_add_valid_url(self, tmp_path):
        """意图：有效的 git 仓库 URL 应写入 diy.yaml"""
        root = self._setup_boundary(tmp_path)

        with patch("diy.cli.ref.find_project_root", return_value=root), patch("diy.cli.ref.Path.cwd", return_value=root), \
             patch("subprocess.run") as mock_run, \
             patch("diy.cli.ref.sync_dependencies"):
            # git ls-remote 成功
            mock_run.return_value.returncode = 0
            mock_run.return_value.stdout = ""

            from diy.cli.ref import ref_add
            ref_add(url="https://github.com/brentyi/tyro")

        import yaml as _y
        cfg = _y.safe_load((root / "diy.yaml").read_text()) or {}
        assert "https://github.com/brentyi/tyro" in cfg.get("sources", [])

    def test_add_duplicate_url_skipped(self, tmp_path):
        """意图：完全相同的 URL 再次添加应跳过"""
        root = self._setup_boundary(tmp_path, {
            "sources": ["https://github.com/brentyi/tyro"]
        })

        with patch("diy.cli.ref.find_project_root", return_value=root), patch("diy.cli.ref.Path.cwd", return_value=root), \
             patch("subprocess.run") as mock_run:
            mock_run.return_value.returncode = 0

            from diy.cli.ref import ref_add
            ref_add(url="https://github.com/brentyi/tyro")

        # 不应重复
        import yaml as _y
        cfg = _y.safe_load((root / "diy.yaml").read_text()) or {}
        assert cfg.get("sources") == ["https://github.com/brentyi/tyro"]

    def test_add_replace_different_url_same_host(self, tmp_path):
        """意图：同 host/owner/repo 但不同 URL（如版本不同） → 替换旧条目"""
        root = self._setup_boundary(tmp_path, {
            "sources": ["https://github.com/brentyi/tyro@v1"]
        })

        with patch("diy.cli.ref.find_project_root", return_value=root), patch("diy.cli.ref.Path.cwd", return_value=root), \
             patch("subprocess.run") as mock_run:
            mock_run.return_value.returncode = 0

            from diy.cli.ref import ref_add
            ref_add(url="https://github.com/brentyi/tyro@v2")

        import yaml as _y
        cfg = _y.safe_load((root / "diy.yaml").read_text()) or {}
        sources = cfg.get("sources", [])
        assert "https://github.com/brentyi/tyro@v1" not in sources, "旧版本应被替换"
        assert "https://github.com/brentyi/tyro@v2" in sources, "新版本应存在"

    def test_add_different_host_same_owner_repo(self, tmp_path):
        """意图：不同 host 但同 owner/repo → 各自独立，不替换"""
        root = self._setup_boundary(tmp_path, {
            "sources": ["https://github.com/brentyi/tyro"]
        })

        with patch("diy.cli.ref.find_project_root", return_value=root), patch("diy.cli.ref.Path.cwd", return_value=root), \
             patch("subprocess.run") as mock_run:
            mock_run.return_value.returncode = 0

            from diy.cli.ref import ref_add
            ref_add(url="https://gitlab.com/brentyi/tyro")

        import yaml as _y
        cfg = _y.safe_load((root / "diy.yaml").read_text()) or {}
        sources = cfg.get("sources", [])
        assert "https://github.com/brentyi/tyro" in sources
        assert "https://gitlab.com/brentyi/tyro" in sources

