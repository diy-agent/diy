"""dai profile list/show — 意图测试（ShellTest 版）。

意图测试 = CLI transcript（$ 命令 → 完整输出）。水手读即知 CLI 外观。
state.yaml 隔离由 conftest.py 的 fake_home fixture 保证。

注意：ShellTest 的行匹配是 strip + 精确/glob 匹配。
- `---` 在 ShellTest 中表示 stdout→stderr 切换，YAML 输出的 `---` 行不写进期望
- JSON 输出用 `*` glob 做关键词断言
"""

from __future__ import annotations

from pathlib import Path

from _shelltest import ShellTest


def test_intent_profile_list_default_yaml(sh: ShellTest, fake_home: Path):
    """意图: dai profile list 默认 YAML 输出三个预设 profile。"""
    sh.assert_session("""
        $ dai profile list
        quick:
        area: main
        merge: direct
        standard:
        area: branch
        merge: pr
        reviewed:
        area: worktree
        merge: pr
        approval: human
    """)


def test_intent_profile_list_json(sh: ShellTest, fake_home: Path):
    """意图: dai profile list --json 输出 JSON。

    用 * glob 匹配关键 profile 名，不校验完整 JSON 结构。
    """
    sh.assert_session("""
        $ dai profile list --json
        *quick*
        *standard*
        *reviewed*
    """)


def test_intent_profile_show_existing(sh: ShellTest, fake_home: Path):
    """意图: dai profile show quick 输出单个 profile YAML。"""
    sh.assert_session("""
        $ dai profile show quick
        area: main
        merge: direct
        approval: null
    """)


def test_intent_profile_show_json(sh: ShellTest, fake_home: Path):
    """意图: dai profile show quick --json 输出单个 profile JSON。"""
    sh.assert_session("""
        $ dai profile show quick --json
        *"area": "main"*
        *"merge": "direct"*
        *"approval": null*
    """)


def test_intent_profile_show_nonexistent(sh: ShellTest, fake_home: Path):
    """意图: dai profile show 不存在的 profile → exit ≠ 0。"""
    sh.assert_session("""
        $! dai profile show nonexistent
    """)
