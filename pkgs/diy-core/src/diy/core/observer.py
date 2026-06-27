"""
Agent 可观测模型 — 协议定义 + 数据模型。

设计原则：
  - 接口是 async 协议，传输层可替换
  - 同进程调用和跨进程调用使用相同接口
  - 装配时决定：直连 / Unix socket / WebSocket / HTTP

用法：
    observer = InProcessAgentObserver(manager)
    snapshot = await observer.snapshot("local/task/1")
    async for event in observer.stream("local/task/1"):
        print(event)
"""

from __future__ import annotations

import asyncio
import logging
import time
from abc import ABC, abstractmethod
from collections import deque
from dataclasses import dataclass, field
from typing import AsyncIterator

from .backend import AgentState

logger = logging.getLogger("diy.observer")


# ════════════════════════════════════════════════════════════════
# 数据模型
# ════════════════════════════════════════════════════════════════


@dataclass
class ProcessMetrics:
    """子进程系统级指标。"""
    pid: int = 0
    alive: bool = False
    status: str = ""  # "running" | "sleeping" | "zombie" | "dead" | ""
    cpu_user: float = 0  # 用户 CPU 时间（秒）
    cpu_system: float = 0  # 系统 CPU 时间（秒）
    mem_rss: int = 0  # 常驻内存（字节）
    num_threads: int = 0
    num_fds: int = 0  # 文件描述符数
    uptime: float = 0  # 进程存活时间（秒）


@dataclass
class AgentSnapshot:
    """单个 agent 的完整观测快照。"""
    # ── 身份 ──
    task_uri: str = ""
    session_id: str = ""
    # ── 状态 ──
    state: str = "idle"  # starting | idle | running | error | stopped
    provider: str = ""
    model: str = ""
    # ── 对话 ──
    message_count: int = 0
    last_user_msg: str = ""  # 最后一条用户消息（截断）
    last_assistant_msg: str = ""  # 最后一条助手消息（截断）
    # ── 实时指标（running 时有效） ──
    event_count: int = 0  # 本次 prompt 事件数
    last_event_type: str = ""  # 最后事件类型
    last_event_age: float = 0  # 距最后事件秒数
    prompt_elapsed: float = 0  # prompt 已运行秒数
    # ── 进程指标 ──
    process: ProcessMetrics = field(default_factory=ProcessMetrics)
    # ── 时间戳 ──
    snapshot_ts: float = 0  # 快照生成时间


@dataclass
class AgentEvent:
    """agent 事件流中的单个事件。"""
    ts: float = 0  # 时间戳
    level: str = ""  # "raw" | "protocol" | "agent" | "lifecycle" | "error"
    kind: str = ""  # 事件类型：stdout/stderr/jsonl/text_delta/tool_call/...
    source: str = ""  # "pi" | "acp" | "system"
    data: str = ""  # 事件内容（raw=原始文本, protocol=JSON摘要, agent=业务数据）
    size: int = 0  # 原始字节数
    meta: dict = field(default_factory=dict)  # 额外元数据

    def to_dict(self) -> dict:
        """序列化到 dict（供 JSON 输出）。"""
        return {
            "ts": self.ts,
            "level": self.level,
            "kind": self.kind,
            "source": self.source,
            "data": self.data,
            "size": self.size,
            "meta": dict(self.meta),
        }

    def format(self, compact: bool = False) -> str:
        """格式化为人类可读文本。compact=True 省略长 data。"""
        import time as _time

        ts = _time.strftime("%H:%M:%S", _time.localtime(self.ts))
        data = self.data[:80] + "..." if compact and len(self.data) > 80 else self.data
        return f"[{ts}] [{self.level}] [{self.kind}] {data}"


# ════════════════════════════════════════════════════════════════
# 协议（接口）
# ════════════════════════════════════════════════════════════════


class AgentObserver(ABC):
    """agent 可观测接口 — async 协议，传输层可替换。

    实现方式：
      - InProcessAgentObserver — 直接访问 agent 实例（同进程）
      - SocketAgentObserver — 通过 Unix socket 调用（跨进程，未来）
      - WebSocketAgentObserver — 通过 WebSocket 调用（远程，未来）
    """

    @abstractmethod
    async def list_agents(self) -> list[AgentSnapshot]:
        """获取所有 agent 快照。"""
        ...

    @abstractmethod
    async def snapshot(self, task_uri: str) -> AgentSnapshot | None:
        """获取单个 agent 详细快照。"""
        ...

    @abstractmethod
    async def stream(
        self, task_uri: str, *, max_events: int = 200
    ) -> AsyncIterator[AgentEvent]:
        """订阅 agent 事件流（stdout/stderr/agent 事件）。

        yield AgentEvent 直到 agent 停止或调用方取消。
        max_events: 缓冲区最大事件数（超出丢弃最旧）。
        """
        ...

    async def close(self) -> None:
        """清理资源。"""
        pass


# ════════════════════════════════════════════════════════════════
# 进程指标采集（stdlib，无需 psutil）
# ════════════════════════════════════════════════════════════════


def collect_process_metrics(proc) -> ProcessMetrics:
    """从 subprocess.Process 采集系统级指标。"""
    import os

    m = ProcessMetrics()
    if proc is None:
        return m

    m.pid = proc.pid
    m.alive = proc.returncode is None

    if not m.alive:
        m.status = "dead"
        return m

    # 进程状态（通过 kill 0 判断）
    try:
        os.kill(proc.pid, 0)
        m.status = "running"
    except ProcessLookupError:
        m.status = "dead"
        m.alive = False
    except PermissionError:
        m.status = "running"  # 有权访问但不能发信号（macOS 沙箱）

    # 尝试用 psutil 获取详细指标（可选依赖）
    try:
        import psutil

        p = psutil.Process(proc.pid)
        with p.oneshot():
            st = p.status()
            m.status = st if st != "sleeping" else "sleeping"
            ct = p.cpu_times()
            m.cpu_user = ct.user
            m.cpu_system = ct.system
            m.mem_rss = p.memory_info().rss
            m.num_threads = p.num_threads()
            m.num_fds = p.num_fds()
    except ImportError:
        pass
    except Exception:
        pass  # psutil 不可用或进程已退出

    return m


# ════════════════════════════════════════════════════════════════
# 实现：同进程直连
# ════════════════════════════════════════════════════════════════


class InProcessAgentObserver(AgentObserver):
    """直接访问 AgentManager 实例（同进程，零开销）。"""

    def __init__(self, manager) -> None:
        self._mgr = manager
        # 事件缓冲区：task_uri → deque[AgentEvent]
        self._buffers: dict[str, deque[AgentEvent]] = {}
        self._start_ts: float = time.time()

    async def list_agents(self) -> list[AgentSnapshot]:
        states = self._mgr.list()
        now = time.time()
        result = []
        for s in states:
            # 注入 observer 到 agent 实例
            agent = self._mgr.get(s.task_uri)
            if agent is not None and hasattr(agent, "_observer"):
                agent._observer = self
            snap = self._state_to_snapshot(s, now)
            result.append(snap)
        return result

    async def snapshot(self, task_uri: str) -> AgentSnapshot | None:
        agent = self._mgr.get(task_uri)
        if agent is None:
            return None
        # 注入 observer
        if hasattr(agent, "_observer"):
            agent._observer = self
            # AcpAgent 需要把 _push_event 传给 _AcpClient
            if hasattr(agent, "_client") and hasattr(agent._client, "_push_event"):
                agent._client._push_event = agent._push_event
        s = agent.state_snapshot()
        now = time.time()
        snap = self._state_to_snapshot(s, now)
        # 补充 history 信息
        history = agent.history
        if history:
            for m in reversed(history):
                if m.role == "user" and not snap.last_user_msg:
                    snap.last_user_msg = m.content[:120]
                elif m.role == "assistant" and not snap.last_assistant_msg:
                    snap.last_assistant_msg = m.content[:120]
                if snap.last_user_msg and snap.last_assistant_msg:
                    break
        # 补充进程指标
        proc = getattr(agent, "_proc", None)
        snap.process = collect_process_metrics(proc)
        snap.process.uptime = now - self._start_ts
        return snap

    async def stream(
        self, task_uri: str, *, max_events: int = 200
    ) -> AsyncIterator[AgentEvent]:
        """订阅事件流 — 从 agent._push_event() 推入的 buffer 中消费。

        事件由 PiRpcAgent._on_event() 在每个 text_delta / tool_call / agent_end 时
        通过 push_event() 推入 buffer，stream() 只负责 yield。
        """
        buf = self._buffers.setdefault(
            task_uri, deque(maxlen=max_events)
        )
        last_idx = 0

        while True:
            # 检查 agent 是否还活着
            agent = self._mgr.get(task_uri)
            if agent is None:
                yield AgentEvent(
                    ts=time.time(),
                    kind="lifecycle",
                    source="system",
                    data="agent 已停止",
                )
                break

            # 从 buffer 中 yield 新事件
            while last_idx < len(buf):
                yield buf[last_idx]
                last_idx += 1

            await asyncio.sleep(0.1)  # 100ms 轮询 buffer

    def push_event(self, task_uri: str, event: AgentEvent) -> None:
        """外部推入事件（供 SignalBridge / stderr 捕获调用）。"""
        buf = self._buffers.setdefault(task_uri, deque(maxlen=200))
        buf.append(event)

    def _state_to_snapshot(self, s: AgentState, now: float) -> AgentSnapshot:
        return AgentSnapshot(
            task_uri=s.task_uri,
            session_id=s.session_id,
            state=s.state,
            provider=s.provider,
            model=s.model,
            message_count=s.message_count,
            event_count=s.event_count,
            last_event_type=s.last_event_type,
            last_event_age=s.last_event_age,
            prompt_elapsed=s.prompt_elapsed,
            snapshot_ts=now,
        )
