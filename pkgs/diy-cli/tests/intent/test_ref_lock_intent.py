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

from helpers import FakeProject, sync_snapshot


def _assert_ref_yaml(root: Path, expected_entries: dict[str, str]):
    """断言 ref.lock.yaml 包含指定的 key→path 映射。"""
    ref_path = root / ".diy" / "ref.lock.yaml"
    assert ref_path.exists(), f"{ref_path} 不存在"

    text = ref_path.read_text()
    lines = text.splitlines()

    # 验证头
    assert lines[0].strip() == "version: 2", f"首行应为 version: 2, 实际: {lines[0]}"

    for key, path in expected_entries.items():
        assert f"{key}:" in text, f"缺少 key: {key}"
        assert path in text, f"key {key} 的路径不匹配, 期望含: {path}"


class TestRefLockFormat:
    """ref.lock.yaml 格式正确性。"""

    def test_flat_mapping_just_one_key_per_line(self, tmp_path):
        """意图：每行一个 key→path，纯平面对应，无嵌套结构。"""
        project = FakeProject(tmp_path)
        project.add_diy_yaml({"name": "flat-test"})
        project.add_pyproject_toml(
            'name = "flat-test"\ndependencies = ["rich"]'
        )
        # uv.lock 中 rich 版本为 15.0.0
        project.add_uv_lock(
            '[[package]]\nname = "rich"\nversion = "15.0.0"\n'
        )

        home = tmp_path / "home"
        home.mkdir()
        cache = home / ".diy"

        with patch("diycli._sync.Path.cwd", return_value=tmp_path), \
             patch("diycli._sync.Path.home", return_value=home), \
             patch("diycli._sync.GLOBAL_CACHE_DIR", cache), \
             patch("diycli._sync.METADATA_CACHE_PATH", cache / "meta.json"), \
             patch("urllib.request.urlopen") as mock_urlopen, \
             patch("subprocess.check_call"):
            # Mock PyPI 返回 rich 在 github.com/Textualize/rich
            resp = MagicMock()
            resp.__enter__.return_value = resp
            resp.read.return_value = json.dumps({
                "info": {"project_urls": {"Source": "https://github.com/Textualize/rich"}}
            }).encode()
            mock_urlopen.return_value = resp

            from diycli._sync import sync_dependencies
            sync_dependencies()

        _assert_ref_yaml(tmp_path, {
            "python:rich": "~/.diy/ref/github.com/Textualize/rich/v15.0.0",
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

        with patch("diycli._sync.Path.cwd", return_value=root), \
             patch("diycli._sync.Path.home", return_value=home), \
             patch("diycli._sync.GLOBAL_CACHE_DIR", cache), \
             patch("diycli._sync.METADATA_CACHE_PATH", cache / "meta.json"), \
             patch("subprocess.check_call"):
            from diycli._sync import sync_dependencies
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
            'name = "version-test"\ndependencies = ["pyyaml>=6.0"]\n'
        )
        # uv.lock 中 pyyaml 实际版本为 6.0.2
        project.add_uv_lock(
            '[[package]]\nname = "pyyaml"\nversion = "6.0.2"\n'
        )

        home = tmp_path / "home"
        home.mkdir()
        cache = home / ".diy"

        with patch("diycli._sync.Path.cwd", return_value=tmp_path), \
             patch("diycli._sync.Path.home", return_value=home), \
             patch("diycli._sync.GLOBAL_CACHE_DIR", cache), \
             patch("diycli._sync.METADATA_CACHE_PATH", cache / "meta.json"), \
             patch("urllib.request.urlopen") as mock_urlopen, \
             patch("subprocess.check_call"):
            resp = MagicMock()
            resp.__enter__.return_value = resp
            resp.read.return_value = json.dumps({
                "info": {"project_urls": {"Source": "https://github.com/yaml/pyyaml"}}
            }).encode()
            mock_urlopen.return_value = resp

            from diycli._sync import sync_dependencies
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

        with patch("diycli._sync.Path.cwd", return_value=tmp_path), \
             patch("diycli._sync.Path.home", return_value=home), \
             patch("diycli._sync.GLOBAL_CACHE_DIR", cache), \
             patch("diycli._sync.METADATA_CACHE_PATH", cache / "meta.json"), \
             patch("subprocess.check_output") as mock_co, \
             patch("subprocess.check_call"):
            # npm view 返回 react 的仓库 URL
            mock_co.return_value = "https://github.com/facebook/react.git"

            from diycli._sync import sync_dependencies
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
            'name = "source-test"\ndependencies = []\n'
        )

        home = tmp_path / "home"
        home.mkdir()
        cache = home / ".diy"

        with patch("diycli._sync.Path.cwd", return_value=tmp_path), \
             patch("diycli._sync.Path.home", return_value=home), \
             patch("diycli._sync.GLOBAL_CACHE_DIR", cache), \
             patch("diycli._sync.METADATA_CACHE_PATH", cache / "meta.json"), \
             patch("subprocess.check_call"):
            from diycli._sync import sync_dependencies
            sync_dependencies()

        _assert_ref_yaml(tmp_path, {
            "source:github/gh-aw": "~/.diy/ref/github.com/github/gh-aw/main",
            "source:github/docs": "~/.diy/ref/github.com/github/docs/main",
        })
