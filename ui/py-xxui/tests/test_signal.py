"""Signal API 契约测试。

Signal 是 xxui 的状态原语，独立于 App/UI 存在。
"""
from xxui.signal import Signal


# ═══════════════════════════════════════════════
# 构造
# ═══════════════════════════════════════════════

class TestSignalConstruction:
    """Signal 可独立构造，不依赖 App。"""

    def test_standalone_construction(self):
        sig = Signal(0)
        assert sig.value == 0

    def test_initial_type_preserved(self):
        """Signal[T] 保持初始值类型。"""
        assert isinstance(Signal(0).value, int)
        assert isinstance(Signal("hello").value, str)
        assert isinstance(Signal(["a", "b"]).value, list)


# ═══════════════════════════════════════════════
# 读写
# ═══════════════════════════════════════════════

class TestSignalReadWrite:
    """Signal.value 基本读写语义。"""

    def test_read_returns_current_value(self):
        sig = Signal("hello")
        assert sig.value == "hello"

    def test_write_updates_value(self):
        sig = Signal(0)
        sig.value = 42
        assert sig.value == 42


# ═══════════════════════════════════════════════
# 观察者
# ═══════════════════════════════════════════════

class TestSignalObservers:
    """Signal 值变化时通知已注册的观察者，相等值不触发。"""

    def test_observer_called_on_change(self):
        sig = Signal(0)
        seen = []
        sig.on_change(lambda v: seen.append(v))

        sig.value = 1

        assert seen == [1]

    def test_equal_value_triggers_nothing(self):
        """新旧值相等：不通知观察者，不触发任何副作用。"""
        sig = Signal(0)
        seen = []
        sig.on_change(lambda v: seen.append(v))

        sig.value = 0

        assert seen == []

    def test_multiple_observers_all_notified(self):
        sig = Signal(0)
        a, b = [], []
        sig.on_change(lambda v: a.append(v))
        sig.on_change(lambda v: b.append(v))

        sig.value = 1

        assert a == [1]
        assert b == [1]

    def test_observer_receives_new_value(self):
        sig = Signal("old")
        received = []
        sig.on_change(lambda v: received.append(v))

        sig.value = "new"

        assert received == ["new"]

    def test_remove_observer_stops_notification(self):
        sig = Signal(0)
        seen = []
        unsub = sig.on_change(lambda v: seen.append(v))

        unsub()
        sig.value = 1

        assert seen == []

    def test_double_unsubscribe_no_error(self):
        """重复取消订阅不报错。"""
        sig = Signal(0)
        unsub = sig.on_change(lambda v: None)
        unsub()
        unsub()  # 不抛异常


# ═══════════════════════════════════════════════
# 所有权（为 scope 检查预留）
# ═══════════════════════════════════════════════

class TestSignalOwnership:
    """Signal 记录所属 ScopeNode，用于子树访问检查。"""

    def test_standalone_signal_has_no_owner(self):
        sig = Signal(0)
        assert sig.owner is None

    def test_owner_can_be_set(self):
        """owner 由 app.signal() 或其他 ScopeNode 在挂载时设置。"""
        sig = Signal(0)
        sig.owner = "fake-scope-node"
        assert sig.owner == "fake-scope-node"


# ═══════════════════════════════════════════════
# 依赖追踪（cell 构建于其上）
# ═══════════════════════════════════════════════

class TestSignalDependencyTracking:
    """Signal 提供依赖注册钩子，cell 系统构建于其上。"""

    def test_reading_registers_with_current_tracker(self):
        """读取 .value 时若存在 tracker，则注册依赖。"""
        sig = Signal(0)
        tracked = []
        sig._tracker = tracked.append  # 模拟 cell 执行时设置的 tracker

        _ = sig.value

        assert len(tracked) == 1
        assert tracked[0] is sig

    def test_reading_without_tracker_is_safe(self):
        """无 tracker 时正常读取，不报错。"""
        sig = Signal(0)
        assert sig._tracker is None
        assert sig.value == 0  # 不抛异常

    def test_writing_notifies_observers_then_enqueues_rerun(self):
        """写入时：通知观察者 → scheduler enqueue。先验证观察者部分。"""
        sig = Signal(0)
        seen = []
        sig.on_change(lambda v: seen.append(v))

        sig.value = 1

        assert seen == [1]
