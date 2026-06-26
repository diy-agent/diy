"""dai scan — 意图测试（ShellTest 版）。

ShellTest 行匹配是 strip + 精确/glob 匹配。
注意：macOS `/var` → `/private/var` symlink，路径用 `*` glob 模糊匹配。
"""

from __future__ import annotations

from pathlib import Path

from _shelltest import ShellTest


def test_intent_dai_scan_yaml_output(sh: ShellTest, fake_home: Path):
    """意图: dai scan 默认 YAML 输出 workspace + spaces。"""
    ws = fake_home / "git"
    ws.mkdir(parents=True)
    (ws / "diy.yaml").write_text("config: true\n")
    for name in ["_diy", "diy", "diyq"]:
        (ws / name).mkdir()
        (ws / name / ".git").mkdir()

    sh.assert_session(f"""
        $ dai scan --path {ws}
        *workspace: *{ws}*
        *{ws}/_diy*
        *{ws}/diy*
        *{ws}/diyq*
    """)


def test_intent_dai_scan_json_output(sh: ShellTest, fake_home: Path):
    """意图: dai scan --json 输出 JSON。"""
    ws = fake_home / "git"
    ws.mkdir(parents=True)
    (ws / "diy.yaml").write_text("")

    for name in ["repo1", "repo2"]:
        (ws / name).mkdir()
        (ws / name / ".git").mkdir()

    sh.assert_session(f"""
        $ dai scan --json --path {ws}
        *{ws}/repo1*
        *{ws}/repo2*
    """)


def test_intent_dai_scan_no_diy_yaml(sh: ShellTest, fake_home: Path):
    """意图: dai scan 在 workspace 根外（无 diy.yaml）报错。"""
    empty = fake_home / "empty"
    empty.mkdir()
    sh.assert_session(f"""
        $! dai scan --path {empty}
    """)


def test_intent_dai_scan_empty_workspace(sh: ShellTest, fake_home: Path):
    """意图: workspace 下无 .git 目录时 spaces 为空列表。"""
    ws = fake_home / "git"
    ws.mkdir(parents=True)
    (ws / "diy.yaml").write_text("")

    sh.assert_session(f"""
        $ dai scan --path {ws}
        *workspace: *{ws}*
        spaces: []
    """)


def test_intent_dai_scan_max_depth_boundary(sh: ShellTest, fake_home: Path):
    """意图: .git 深度超出 max_depth=3 时不被发现。"""
    ws = fake_home / "git"
    ws.mkdir(parents=True)
    (ws / "diy.yaml").write_text("")

    deep = ws / "a" / "b" / "c" / "d"
    deep.mkdir(parents=True)
    (deep / ".git").mkdir()

    sh.assert_session(f"""
        $ dai scan --path {ws}
        *workspace: *{ws}*
        spaces: []
    """)


def test_intent_dai_scan_home_boundary(sh: ShellTest, fake_home: Path):
    """意图: diy.yaml 在 HOME 目录本身时应在 HOME 停住，不向上。"""
    (fake_home / "diy.yaml").write_text("")
    sh.assert_session(f"""
        $ dai scan --path {fake_home}
        *workspace: *{fake_home}*
        spaces: []
    """)
