"""轻量指标存储，API 对齐 OpenTelemetry Metrics API。

接口签名与 opentelemetry-api 一致：
  meter.create_counter(name) → counter.add(amount, attributes)
  meter.create_histogram(name) → histogram.record(amount, attributes)

后面想接真实 OTel exporter 时，把 _create_instrument 的实现
换成 opentelemetry-sdk 就好，调用代码不动。
"""

from __future__ import annotations

import time
from typing import Any

# ── OTel-compatible instrument 接口 ──


class _Counter:
    """单调递增计数器，匹配 OTel Counter.add()。"""

    def __init__(self, store: MetricsStore, name: str):
        self._store = store
        self._name = name

    def add(self, amount: int | float = 1, attributes: dict | None = None) -> None:
        self._store._counters[self._name] = (
            self._store._counters.get(self._name, 0) + amount
        )


class _Histogram:
    """瞬时值 + 时间序列，匹配 OTel Histogram.record()。

    OTel 标准 Histogram 记录分布统计（min/max/sum/count），
    我们简化成 gauge + 时间序列（tradeoff：不保存分布，只存最近值）。
    """

    def __init__(self, store: MetricsStore, name: str):
        self._store = store
        self._name = name

    def record(self, amount: int | float, attributes: dict | None = None) -> None:
        now = time.time()
        self._store._gauges[self._name] = amount
        if self._name not in self._store._histories:
            self._store._histories[self._name] = []
        h = self._store._histories[self._name]
        h.append((now, float(amount)))
        if len(h) > self._store._max_history:
            self._store._histories[self._name] = h[-self._store._max_history :]


# ── Meter ──


class Meter:
    """匹配 OTel Meter.create_counter() / create_histogram()。"""

    def __init__(self, store: MetricsStore) -> None:
        self._store = store

    def create_counter(
        self, name: str, unit: str = "", description: str = ""
    ) -> _Counter:
        return _Counter(self._store, name)

    def create_histogram(
        self, name: str, unit: str = "", description: str = ""
    ) -> _Histogram:
        return _Histogram(self._store, name)


# ── MetricsStore ──


class MetricsStore:
    """进程内指标存储。

    使用方式（otel 风格的 API）:
        meter = store.meter
        counter = meter.create_counter("health.checks")
        counter.add(1)
        gauge = meter.create_histogram("agent.count")
        gauge.record(5)
    """

    def __init__(self, max_history: int = 1000):
        self._counters: dict[str, float] = {}
        self._gauges: dict[str, float] = {}
        self._histories: dict[str, list[tuple[float, float]]] = {}
        self._max_history = max_history
        self._meter = Meter(self)

    @property
    def meter(self) -> Meter:
        """获取 OTel 兼容 Meter，用于创建 instrument。"""
        return self._meter

    # ── 快捷方法（不通过 Meter，直接记） ──

    def counter(self, name: str, delta: int | float = 1) -> None:
        """快捷：counter.add(delta)"""
        self._counters[name] = self._counters.get(name, 0) + delta

    def gauge(self, name: str, value: float) -> None:
        """快捷：histogram.record(value)"""
        now = time.time()
        self._gauges[name] = value
        if name not in self._histories:
            self._histories[name] = []
        h = self._histories[name]
        h.append((now, value))
        if len(h) > self._max_history:
            self._histories[name] = h[-self._max_history :]

    # ── 快照 ──

    def snapshot(self) -> dict[str, Any]:
        return {
            "counters": dict(self._counters),
            "gauges": dict(self._gauges),
            "histories": {
                k: [{"t": ts, "v": v} for ts, v in entries[-100:]]
                for k, entries in self._histories.items()
            },
        }

    # ── 读取 ──

    def get_counter(self, name: str, default: float = 0) -> float:
        return self._counters.get(name, default)

    def get_gauge(self, name: str, default: float = 0.0) -> float:
        return self._gauges.get(name, default)

    def get_history(
        self, name: str, default: None = None
    ) -> list[tuple[float, float]] | None:
        return self._histories.get(name, default)
