"""dai task star/unstar — 焦点视意图测试。

star/unstar 操作 symlink 到 $DIY_HOME/star/ 目录，
实现零拷贝焦点视图。

设计原则：
- star = 关注（创建 symlink）
- unstar = 取消关注（删除 symlink，数据不动）
- list 默认只显示 starred
- list --all 显示全部
- create 自动 star
"""

from __future__ import annotations

from pathlib import Path

from _shelltest import ShellTest


def test_intent_task_star(sh: ShellTest, fake_home: Path):
    """star 任务 → 创建 symlink 到 $DIY_HOME/star/。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/diy --desc "测试 subject"
        status: success
        data:
          path: ~/diy
          description: 测试 subject

        $ dai task create --title "测试任务" --subject ~/diy
        status: success
        data:
          uri: local/task/1
          title: 测试任务
          state: pending

        $ dai task star local/task/1
        status: success
        data:
          uri: local/task/1
          starred: true

        $ test -L $DIY_HOME/star/local/task/1 && echo "symlink exists"
        symlink exists
    """)


def test_intent_task_unstar(sh: ShellTest, fake_home: Path):
    """unstar 任务 → 删除 symlink，数据不动。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/diy --desc "测试 subject"
        status: success
        data:
          path: ~/diy
          description: 测试 subject

        $ dai task create --title "测试任务" --subject ~/diy
        status: success
        data:
          uri: local/task/1

        $ dai task star local/task/1
        status: success

        $ dai task unstar local/task/1
        status: success
        data:
          uri: local/task/1
          starred: false

        $ test -L $DIY_HOME/star/local/task/1 && echo "symlink exists" || echo "symlink removed"
        symlink removed
    """)


def test_intent_task_list_default_shows_starred(sh: ShellTest, fake_home: Path):
    """list 默认只显示 starred 任务。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/diy --desc "测试 subject"
        status: success

        $ dai task create --title "任务A" --subject ~/diy
        status: success
        data:
          uri: local/task/1

        $ dai task create --title "任务B" --subject ~/diy
        status: success
        data:
          uri: local/task/2

        $ dai task star local/task/1
        status: success

        $ dai task list
        tasks:
          local/task/1:
            title: 任务A
    """)


def test_intent_task_list_all(sh: ShellTest, fake_home: Path):
    """list --all 显示全部任务（含未 star 的）。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/diy --desc "测试 subject"
        status: success

        $ dai task create --title "任务A" --subject ~/diy
        status: success

        $ dai task create --title "任务B" --subject ~/diy
        status: success

        $ dai task star local/task/1
        status: success

        $ dai task list --all
        tasks:
          local/task/1:
            title: 任务A
          local/task/2:
            title: 任务B
    """)


def test_intent_task_create_auto_star(sh: ShellTest, fake_home: Path):
    """create 自动 star 新任务。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/diy --desc "测试 subject"
        status: success

        $ dai task create --title "新任务" --subject ~/diy
        status: success
        data:
          uri: local/task/1
          starred: true

        $ test -L $DIY_HOME/star/local/task/1 && echo "symlink exists"
        symlink exists
    """)


def test_intent_task_star_missing(sh: ShellTest):
    """star 不存在的任务 → 报错。"""
    sh.assert_session("""
        $ dai task star local/task/9999
        ---
        错误: 任务 local/task/9999 不存在
    """)


def test_intent_task_unstar_missing(sh: ShellTest):
    """unstar 不存在的任务 → 报错。"""
    sh.assert_session("""
        $ dai task unstar local/task/9999
        ---
        错误: 任务 local/task/9999 不存在
    """)


def test_intent_task_star_idempotent(sh: ShellTest, fake_home: Path):
    """star 重复 star 同一任务 → 幂等成功。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/diy --desc "测试 subject"
        status: success

        $ dai task create --title "测试任务" --subject ~/diy
        status: success

        $ dai task star local/task/1
        status: success

        $ dai task star local/task/1
        status: success
    """)


def test_intent_task_unstar_not_starred(sh: ShellTest, fake_home: Path):
    """unstar 未 star 的任务 → 幂等成功。"""
    (fake_home / "diy").mkdir()
    (fake_home / "diy" / ".git").touch()

    sh.assert_session("""
        $ dai subject add ~/diy --desc "测试 subject"
        status: success

        $ dai task create --title "测试任务" --subject ~/diy
        status: success

        $ dai task unstar local/task/1
        status: success
    """)
