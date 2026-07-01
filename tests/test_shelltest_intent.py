"""ShellTest API 意图测试。

每个测试 = ShellTest 的一条可执行需求文档。
形式参考 test_dai_task_intent.py——干净的 setup，直接验证契约，
使用 assert_session 做多行 transcript 式断言。
"""

from diy.test import ShellTest


def test_intent_exit_code_direct():
    """退出码从 PS1 内嵌的 $? 自动捕获，不需要命令里 echo $?。

    也不拦截非零退出码——像真 bash 一样，$? 自取。
    """
    sh = ShellTest()
    sh.assert_session("$ true")
    sh.assert_session("""
        $ false; echo $?
        1
    """)


def test_intent_separate_channels():
    """stdout 和 stderr 各自独立返回，不混淆。"""
    ShellTest().assert_session("""
        $ echo out; echo err >&2
        out
        ---
        err
    """)


def test_intent_stateful_session():
    """环境变量跨 run() 持久。"""
    with ShellTest().session() as s:
        s.run("export MSG=world")
        code, out, _ = s.run("echo $MSG")
        assert code == 0
        assert out == "world"


def test_intent_error_output_separate():
    """命令失败时 stderr 有内容，stdout 空，后续命令不受影响。"""
    ShellTest().assert_session("""
        $ cat /nonexistent_file_xyz
        ---
        {{regex:.*No such file.*}}

        $ echo still ok
        still ok
    """)


def test_intent_sentinel():
    """* 通配符和 {{regex:...}} 匹配。"""
    ShellTest().assert_session(r"""
        $ echo '任务 #42 创建成功'
        任务 * 创建成功

        $ echo '2026-06-10 12:00:00  INFO 启动完成'
        {{regex:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}}} * INFO *
    """)


def test_intent_ps1_readonly():
    """PS1 被 readonly 保护，用户写入报错，marker 不受影响。"""
    with ShellTest().session() as s:
        code, _, err = s.run("PS1=HAHA")
        assert code == 1
        assert "readonly" in err

        code, out, _ = s.run("echo still works")
        assert code == 0
        assert out == "still works"


def test_intent_ps1_prefix_readable():
    """ps1_prefix 让 prompt 可读，marker 仍在行中可解析。"""
    with ShellTest(ps1_prefix=r"\w\$ ").session() as s:
        code, out, _ = s.run("echo hello")
        assert code == 0
        assert out == "hello"

        _, _, err = s.run("true")
        last_line_lines = [l for l in err.strip().split("\n") if l.strip()]  # noqa: E741  # l 作循环变量，非数字 1
        if last_line_lines:
            assert "__ST_" in last_line_lines[-1]
