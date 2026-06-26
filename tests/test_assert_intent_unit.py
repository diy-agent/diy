"""assert_intent 引擎单元测试。

测试引擎核心逻辑：sentinel 匹配、JSON/YAML 嗅探、_json_contains。
不启动子进程（不测试 _run_blocks / assert_intent 集成流程）。
"""

from _assert_intent import (
    _json_contains,
    _line_matches,
    _sentinel_to_regex,
    _try_parse_json,
    _try_parse_yaml,
)

# ════════════════════════════════════════════════════════════════
# _sentinel_to_regex
# ════════════════════════════════════════════════════════════════


def test_sentinel_to_regex_any():
    """{{*}} → .*?"""
    assert _sentinel_to_regex("{{*}}") == r".*?"


def test_sentinel_to_regex_regex():
    """{{regex:...}} → 提取正则字符串"""
    assert _sentinel_to_regex("{{regex:^\\d+$}}") == "^\\d+$"
    assert _sentinel_to_regex("{{regex:\\w+}}") == "\\w+"


def test_sentinel_to_regex_none():
    """不匹配的字符串 → None"""
    assert _sentinel_to_regex("普通文本") is None
    assert _sentinel_to_regex("{{}}") is None
    assert _sentinel_to_regex("") is None


# ════════════════════════════════════════════════════════════════
# _line_matches
# ════════════════════════════════════════════════════════════════


def test_line_matches_exact():
    """精确匹配 — 无 sentinel"""
    assert _line_matches("hello world", "hello world")
    assert not _line_matches("hello world", "hello")


def test_line_matches_any_standalone():
    """纯 {{*}} 独占行 → 匹配任意"""
    assert _line_matches("{{*}}", "")
    assert _line_matches("{{*}}", "任意文本 123 !!!")


def test_line_matches_any_inline():
    """行内 {{*}} → 匹配中间任意"""
    assert _line_matches("开始 {{*}} 结束", "开始 中间任意 结束")
    assert _line_matches("创建任务 {{*}} 成功", "创建任务 #42 成功")
    assert _line_matches("prefix {{*}}", "prefix anything here")


def test_line_matches_regex():
    """行内 {{regex:...}}"""
    assert _line_matches("{{regex:^\\d+$}}", "42")
    assert not _line_matches("{{regex:^\\d+$}}", "abc42")
    assert _line_matches("ID: {{regex:\\d+}}", "ID: 123")


def test_line_matches_mixed():
    """混合 {{*}} 和 {{regex:...}}"""
    assert _line_matches("{{*}} 和 {{regex:\\w+}}", "任意 和 Hello")
    assert not _line_matches("{{*}} 和 {{regex:\\d+}}", "任意 和 Hello")


# ════════════════════════════════════════════════════════════════
# _json_contains
# ════════════════════════════════════════════════════════════════


def test_json_contains_exact():
    """精确匹配"""
    assert _json_contains({"a": 1}, {"a": 1, "b": 2})
    assert not _json_contains({"a": 1, "c": 3}, {"a": 1})
    assert _json_contains(42, 42)
    assert not _json_contains(42, 43)


def test_json_contains_list():
    """列表无序匹配"""
    assert _json_contains([1, 2], [2, 1, 3])
    assert _json_contains([], [1, 2, 3])
    assert not _json_contains([1, 2, 3], [1, 2])
    assert not _json_contains([1, 2], [1])


def test_json_contains_sentinel_any():
    """JSON 中的 {{*}} 匹配任意标量"""
    assert _json_contains({"a": "{{*}}"}, {"a": "任意值"})
    assert _json_contains({"a": "{{*}}"}, {"a": 42})
    assert _json_contains({"a": "{{*}}"}, {"a": None})


def test_json_contains_sentinel_regex():
    """JSON 中的 {{regex:...}}"""
    assert _json_contains({"id": "{{regex:^\\d+$}}"}, {"id": "42"})
    assert not _json_contains({"id": "{{regex:^\\d+$}}"}, {"id": "abc"})


def test_json_contains_nested():
    """嵌套 dict/list"""
    expected = {"user": {"name": "{{*}}", "age": "{{regex:^\\d+$}}"}}
    actual = {"user": {"name": "Alice", "age": "30", "extra": True}}
    assert _json_contains(expected, actual)


def test_json_contains_type_mismatch():
    """类型不一致"""
    assert not _json_contains({"a": None}, {"a": "不是None"})
    assert not _json_contains([1], "不是列表")


# ════════════════════════════════════════════════════════════════
# _try_parse_json / _try_parse_yaml
# ════════════════════════════════════════════════════════════════


def test_try_parse_json():
    """JSON 解析"""
    assert _try_parse_json('{"a": 1}') == {"a": 1}
    assert _try_parse_json("无效json") is None


def test_try_parse_yaml():
    """YAML 解析"""
    data = _try_parse_yaml("a: 1\nb: 2")
    assert data == {"a": 1, "b": 2}
    assert _try_parse_yaml("普通文本") is None


def test_try_parse_yaml_with_prefix():
    """YAML 带 --- 前缀"""
    data = _try_parse_yaml("---\na: 1\nb: 2")
    assert data == {"a": 1, "b": 2}
