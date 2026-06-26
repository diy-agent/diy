"""dai subject — Subject 树管理意图测试。

sh fixture 已激活 .venv（dai 直接可用）。
fake_home fixture 将 $HOME 隔离到临时目录，~/ 路径在子进程内有效。
"""

from __future__ import annotations

from pathlib import Path

from _shelltest import ShellTest


def test_intent_subject_add_and_list(sh: ShellTest, fake_home: Path):
    """添加 subject → 列表 → 树状。"""
    (fake_home / "git").mkdir()
    (fake_home / "git" / ".git").touch()
    (fake_home / "git" / "diy").mkdir()
    (fake_home / "git" / "diy" / ".git").touch()
    (fake_home / "git" / "diy" / "_diy").mkdir()

    sh.assert_session("""
        $ dai subject add ~/git --desc "根目录"
        status: success
        data:
          path: ~/git
          description: 根目录

        $ dai subject add ~/git/diy --desc "diy 生态根"
        status: success
        data:
          path: ~/git/diy
          description: diy 生态根

        $ dai subject add ~/git/diy/_diy --desc "核心工具"
        status: success
        data:
          path: ~/git/diy/_diy
          description: 核心工具

        $ dai subject list
        ~/git:
          description: 根目录
          is_git: true
        ~/git/diy:
          description: diy 生态根
          is_git: true
        ~/git/diy/_diy:
          description: 核心工具
          is_git: false

        $ dai subject tree
        ~/git:
          description: 根目录
          is_git: true
          children:
            ~/git/diy:
              description: diy 生态根
              is_git: true
              children:
                ~/git/diy/_diy:
                  description: 核心工具
                  is_git: false
    """)


def test_intent_subject_remove(sh: ShellTest, fake_home: Path):
    """删除 subject。"""
    (fake_home / "git").mkdir()
    (fake_home / "git" / ".git").touch()
    (fake_home / "git" / "sub").mkdir()

    sh.assert_session("""
        $ dai subject add ~/git --desc git
        status: success
        data:
          path: ~/git
          description: git

        $ dai subject add ~/git/sub --desc sub
        status: success
        data:
          path: ~/git/sub
          description: sub

        $ dai subject remove ~/git/sub
        status: success

        $ dai subject list
        ~/git:
          description: git
          is_git: true

        $! dai subject show ~/git/sub
        *
    """)


def test_intent_subject_duplicate(sh: ShellTest, fake_home: Path):
    """重复添加 → 报错。"""
    (fake_home / "x").mkdir()

    sh.assert_session("""
        $ dai subject add ~/x --desc x
        status: success
        data:
          path: ~/x
          description: x

        $! dai subject add ~/x
        *
    """)


def test_intent_subject_scan(sh: ShellTest, fake_home: Path):
    """scan 扫描文件系统发现 subject。"""
    (fake_home / "repos" / "alpha").mkdir(parents=True)
    (fake_home / "repos" / "beta").mkdir()
    (fake_home / "repos" / "alpha" / ".git").touch()
    (fake_home / "repos" / "beta" / ".git").touch()

    sh.assert_session("""
        $ dai subject scan --root ~/repos
        status: success
        data:
          found: 2

        $ dai subject tree
        ~/repos/alpha:
          is_git: true
        ~/repos/beta:
          is_git: true
    """)
