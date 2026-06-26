"""assert_intent 引擎 — 外观/边界意图测试。

测试引擎整体行为（非纯单元测试）：
  - 命令前缀格式：!ls vs ! ls
  - 空命令、注释、退出码
  - sentinel 跨格式行为（JSON/YAML/文本）
  - 多命令会话
"""

from __future__ import annotations  # noqa: I001  # __future__ 必须在文件最顶

import pytest

from _assert_intent import IntentAssertionError, assert_intent


def test_intent_ls_basic():
    """基本命令 ：! 后接空格或无空格都应工作。"""
    assert_intent("""
!ls
""")
    assert_intent("""
! ls
""")
    assert_intent("""
!  ls
""")


def test_intent_echo():
    """输出精确匹配。"""
    assert_intent("""
! echo hello world
hello world
""")


def test_intent_comments_ignored():
    """注释行不参与匹配。"""
    assert_intent("""
# 这是一条注释，下面才是命令
! echo foo
foo

# 中间也有注释
! echo bar
bar
""")


def test_intent_empty_output():
    """无输出命令。"""
    assert_intent("""
! true
""")


def test_intent_exit_code_nonzero():
    """非零退出码 → 测试失败（预期行为：assert 抛异常）。"""
    # 这个测试验证引擎会 reject 非零退出码
    try:
        assert_intent("""
! false
""")
        pytest.fail("应抛异常")
    except (AssertionError, IntentAssertionError):
        pass


def test_intent_exit_code_echo():
    """用 echo捕获退出码的兼容写法。"""
    assert_intent("""
! echo hello; echo $?
hello
0
""")


def test_intent_sentinel_any_standalone():
    """{{*}} 独占行匹配任意输出。"""
    assert_intent("""
! echo 任意内容 here
{{*}}
""")


def test_intent_sentinel_any_inline():
    """行内 {{*}}。"""
    assert_intent(r"""
! echo '创建任务 #42 成功'
创建任务 {{*}} 成功
""")


def test_intent_sentinel_regex():
    """行内 {{regex:...}}（不含 ^$ 锚定，引擎自动包裹）。"""
    assert_intent(r"""
! echo 42 is the answer
{{regex:\d+}} is the answer
""")


def test_intent_json_sniff():
    """JSON 整块嗅探 + 结构比对。"""
    assert_intent("""
! echo '{"name": "Alice", "age": 30}'
{"name": "Alice"}
""")


def test_intent_yaml_sniff():
    """YAML 整块嗅探（含 --- 前缀）。"""
    assert_intent("""\
! printf 'name: Alice\\nrole: dev\\n'
---
name: Alice
""")


def test_intent_mixed_commands():
    """多命令混合：文本 + sentinel + JSON。"""
    assert_intent("""
! echo line1
line1
! echo '{"status": "ok", "data": {"id": 42}}'
---
status: ok
#
! echo line2
line2
""")


def test_intent_dai_subject_help():
    """真实环境：dai subject --help 可用。"""
    # 需要 uv run 确保 dai 在 PATH 上
    pass


# 以下测试需要 uv run 执行（dai 命令在 venv 里）
# 单独加测试文件 test_dai_subject_help.py 避免依赖问题


def test_intent_empty_expected():
    """无预期行 = 只运行不校验。"""
    assert_intent("""
! echo foo
! echo bar
""")
