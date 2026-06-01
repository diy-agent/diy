"""EventLog 工具自身的单元测试。"""

from helpers import EventLog


def test_record_and_retrieve():
    log = EventLog()
    log.record("e1")
    log.record("e2")
    assert log.events == ["e1", "e2"]


def test_clear():
    log = EventLog()
    log.record("e1")
    log.clear()
    assert log.events == []


def test_eq_list():
    log = EventLog()
    log.record("a")
    log.record("b")
    assert log == ["a", "b"]
    assert log != ["a"]
    assert log != ["a", "b", "c"]
