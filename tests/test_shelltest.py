"""ShellTest 意图测试 — PTY-based shell interaction engine.

每一条测试 = 一个 ShellTest 功能点的需求文档 + 可直接执行的验证。
"""

import os

from diy.test import ShellTest


def test_intent_cwd_initial():
    """ShellTest(cwd="/tmp") → session.cwd 等于归一化后的传入路径。"""
    with ShellTest(cwd="/tmp").session() as sh:
        assert sh.cwd == os.path.realpath("/tmp")


def test_intent_cwd_default():
    """ShellTest() 不传 cwd → session.cwd == os.getcwd()。"""
    with ShellTest().session() as sh:
        assert sh.cwd == os.getcwd()


def test_intent_cwd_after_cd():
    """cd 改变工作目录，session.cwd property 实时反映。"""
    with ShellTest().session() as sh:
        orig = sh.cwd
        sh.run("cd /tmp")
        assert sh.cwd == "/tmp"
        sh.run("cd /var")
        assert sh.cwd == "/var"
        sh.run(f"cd {orig}")
        assert sh.cwd == orig


def test_intent_exit_code_true():
    """true → exit_code 0"""
    with ShellTest().session() as sh:
        code, _, _ = sh.run("true")
        assert code == 0


def test_intent_exit_code_false():
    """false → exit_code 1"""
    with ShellTest().session() as sh:
        code, _, _ = sh.run("false")
        assert code == 1


def test_intent_exit_code_exit_42():
    """exit 42 → exit_code 42（进程退出场景的退出码捕获）"""
    with ShellTest().session() as sh:
        code, _, _ = sh.run("exit 42")
        assert code == 42


def test_intent_output_echo():
    """echo hello world → 输出 "hello world" """
    with ShellTest().session() as sh:
        _, out, _ = sh.run("echo hello world")
        assert out == "hello world"


def test_intent_output_multiline():
    """printf 多行输出正确捕获。"""
    with ShellTest().session() as sh:
        _, out, _ = sh.run("printf 'multi\nline'")
        assert "multi" in out
        assert "line" in out


def test_intent_output_stderr_separate():
    """stderr 和 stdout 各自独立返回，泾渭分明。"""
    with ShellTest().session() as sh:
        _, out, err = sh.run("echo out; echo err >&2")
        assert "out" in out
        assert "err" in err
        assert "err" not in out
        assert "out" not in err


def test_intent_shell_specified():
    """可指定 shell（/bin/sh），cwd 和退出码仍然正常工作。"""
    with ShellTest(shell="/bin/sh", cwd="/tmp").session() as sh:
        assert sh.cwd == os.path.realpath("/tmp")
        code, _, _ = sh.run("true")
        assert code == 0
