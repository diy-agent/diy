"""dai agent monitor — agent 可观测意图测试。

验证 agent monitor 命令的基本行为：
- 无 agent 时返回空列表
- JSON 格式输出正确
- stream 命令注册正确
"""

from __future__ import annotations

from pathlib import Path

from _shelltest import ShellTest


def test_intent_agent_monitor_empty(sh: ShellTest, fake_home: Path):
    """无 agent 时 monitor 返回空列表。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai agent monitor
        (无 agent)
    """)


def test_intent_agent_monitor_json_empty(sh: ShellTest, fake_home: Path):
    """无 agent 时 monitor --json 返回空数组。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai agent monitor --json
        {"agents": []}
    """)


def test_intent_agent_stream_help(sh: ShellTest, fake_home: Path):
    """stream 命令注册正确，help 可用。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai agent stream --help
        *agent 事件流*
    """)
