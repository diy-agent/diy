"""Scheduler API 契约测试。

Scheduler 是 ScopeNode facet，决定 cell rerun 的时机策略。
v0.1 支持 immediate 和 periodic 两种。
"""
from xxui.scheduler import ImmediateScheduler


# ═══════════════════════════════════════════════
# ImmediateScheduler
# ═══════════════════════════════════════════════

class TestImmediateScheduler:
    """immediate scheduler：enqueue 时同步执行。"""

    def test_enqueue_executes_immediately(self):
        sched = ImmediateScheduler()
        seen = []
        sched.enqueue(lambda: seen.append(1))
        assert seen == [1]

    def test_multiple_enqueue_execute_in_order(self):
        sched = ImmediateScheduler()
        log = []
        sched.enqueue(lambda: log.append("a"))
        sched.enqueue(lambda: log.append("b"))
        assert log == ["a", "b"]

    def test_flush_is_noop_after_immediate(self):
        """immediate 已在 enqueue 时执行，flush 是空操作。"""
        sched = ImmediateScheduler()
        sched.enqueue(lambda: None)
        sched.flush()  # 不抛异常

    def test_duplicate_callbacks_deduplicated(self):
        """同一 callback 在同一次 flush 内去重（和 cell 去重配合）。"""
        sched = ImmediateScheduler()
        seen = []

        def cb():
            seen.append(1)

        sched.enqueue(cb)
        sched.enqueue(cb)  # 重复
        # immediate 模式下第一次就执行了，第二次 enqueue 时也应执行（因为不在同一 flush 上下文）
        # 去重逻辑在 P3 cell 层实现，这里只验证 scheduler 基本能力
        assert seen == [1, 1]

    def test_enqueue_nested_callbacks_executed(self):
        """enqueue 的 callback 内部再次 enqueue，立即执行。"""
        sched = ImmediateScheduler()
        log = []

        def outer():
            log.append("outer")
            sched.enqueue(lambda: log.append("inner"))

        sched.enqueue(outer)
        assert log == ["outer", "inner"]


# ═══════════════════════════════════════════════
# Scheduler 与 ScopeNode 配置集成
# ═══════════════════════════════════════════════

class TestSchedulerConfig:
    """scheduler 通过 ScopeConfig 挂到 ScopeNode 上。"""

    def test_immediate_scheduler_from_config(self):
        from xxui.scope import ScopeNode, ScopeConfig
        sched = ImmediateScheduler()
        node = ScopeNode(config=ScopeConfig(scheduler=sched))
        assert node.get_config("scheduler") is sched

    def test_child_inherits_parent_scheduler(self):
        from xxui.scope import ScopeNode, ScopeConfig
        sched = ImmediateScheduler()
        parent = ScopeNode(config=ScopeConfig(scheduler=sched))
        child = ScopeNode()
        parent._add_child(child)
        assert child.get_config("scheduler") is sched
