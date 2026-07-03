"""diy ref — 项目边界识别意图测试。

通过 Python 直接测核心函数（find_project_boundary、_collect_sources_from_all_boundaries），
避免 shell 子进程启动 Python 的启动延迟（~2s > ShellTest quiet timeout）。

测试场景：
  1. 子项目边界（package.json）：在子项目目录 boundary = 子项目自身
  2. 根项目边界（pyproject.toml）：在根项目目录 boundary = 根
  3. Git 兜底边界：无 py/package.json 但有 .git → boundary = git 根
  4. 深层子项目 source 收集：_collect_sources_from_all_boundaries 递归找到 2 层深 diy.yaml
"""

from __future__ import annotations

from pathlib import Path


def test_find_project_boundary_package_json(fake_home: Path):
    """package.json 作为子项目边界标记。"""
    root = fake_home / "test-monorepo"
    sub = root / "packages" / "web-ui"
    sub.mkdir(parents=True)

    (root / "diy.yaml").write_text("sources: []\n")
    (root / ".git").mkdir()
    (sub / "package.json").write_text('{"name": "web-ui"}\n')

    # 从子项目目录 → 边界是子项目（需 resolve() 匹配 find_project_boundary 内部 resolve）
    from diy.cli._sync import find_project_boundary
    assert find_project_boundary(start=sub) == sub.resolve()

    # 从根目录 → 边界是根
    assert find_project_boundary(start=root) == root.resolve()


def test_find_project_boundary_pyproject_toml(fake_home: Path):
    """pyproject.toml 作为子项目边界标记。"""
    root = fake_home / "test-monorepo"
    sub = root / "pkgs" / "diy-extras"
    sub.mkdir(parents=True)

    (root / "diy.yaml").write_text("sources: []\n")
    (root / ".git").mkdir()
    (sub / "pyproject.toml").write_text("[project]\nname = 'diy-extras'\n")

    from diy.cli._sync import find_project_boundary
    assert find_project_boundary(start=sub) == sub.resolve()
    assert find_project_boundary(start=root) == root.resolve()


def test_find_project_boundary_git_fallback(fake_home: Path):
    """无 py/package.json/diy.yaml → .git 兜底边界。"""
    root = fake_home / "git-only-repo"
    nested = root / "src" / "deeply" / "nested"
    nested.mkdir(parents=True)

    (root / ".git").mkdir()

    from diy.cli._sync import find_project_boundary
    assert find_project_boundary(start=nested) == root.resolve()
    assert find_project_boundary(start=root) == root.resolve()


def test_find_project_boundary_diy_yaml_priority(fake_home: Path):
    """diy.yaml 优先级最高，覆盖其他标记。"""
    root = fake_home / "test-root"
    sub = root / "has-all"
    sub.mkdir(parents=True)

    (root / "diy.yaml").write_text("sources: []\n")
    (sub / "diy.yaml").write_text("sources: []\n")
    (sub / "package.json").write_text('{"name": "has-all"}\n')
    (sub / ".git").mkdir()

    from diy.cli._sync import find_project_boundary
    assert find_project_boundary(start=sub) == sub.resolve()
    assert find_project_boundary(start=root) == root.resolve()


def test_find_project_boundary_upward_traversal(fake_home: Path):
    """子目录无标记时向上遍历到最近的项目边界。"""
    root = fake_home / "test-monorepo"
    deep = root / "some" / "random" / "dir"
    deep.mkdir(parents=True)

    (root / "pyproject.toml").write_text("[project]\nname = 'test'\n")
    (root / ".git").mkdir()

    from diy.cli._sync import find_project_boundary
    assert find_project_boundary(start=deep) == root.resolve()


def test_collect_sources_recursive(fake_home: Path):
    """_collect_sources_from_all_boundaries 递归找到 2 层深子项目的 diy.yaml。"""
    root = fake_home / "deep-project"
    sub = root / "pkgs" / "ts" / "electron-ui"
    sub.mkdir(parents=True)

    # 根：diy.yaml + .git
    (root / "diy.yaml").write_text("sources:\n  - https://github.com/root/repo\n")
    (root / ".git").mkdir()
    (root / "package.json").write_text('{"name": "deep-project"}\n')

    # 2 层深子项目：package.json + diy.yaml
    (sub / "package.json").write_text('{"name": "electron-ui"}\n')
    (sub / "diy.yaml").write_text("sources:\n  - https://github.com/shadcn-ui/ui\n")

    from diy.cli._sync import _collect_sources_from_all_boundaries
    sources = _collect_sources_from_all_boundaries(root)

    assert "https://github.com/root/repo" in sources
    assert "https://github.com/shadcn-ui/ui" in sources


def test_collect_sources_skips_vendor_dirs(fake_home: Path):
    """递归扫描跳过 node_modules / .git / .venv 等目录。"""
    root = fake_home / "test-project"
    sub = root / "node_modules" / "some-pkg"
    sub.mkdir(parents=True)

    (root / "diy.yaml").write_text("sources: []\n")
    (root / ".git").mkdir()
    # node_modules 下有 package.json 但不应被扫描
    (sub / "package.json").write_text('{"name": "some-pkg"}\n')
    (sub / "diy.yaml").write_text("sources:\n  - https://github.com/evil/repo\n")

    from diy.cli._sync import _collect_sources_from_all_boundaries
    sources = _collect_sources_from_all_boundaries(root)

    assert "https://github.com/evil/repo" not in sources
