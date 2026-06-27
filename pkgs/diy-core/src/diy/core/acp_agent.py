"""
AcpAgent — AgentBackend 实现，使用 hermes acp 子进程（ACP 协议）。
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from acp import (
    PROTOCOL_VERSION,
    RequestError,
    spawn_agent_process,
    text_block,
)
from acp.core import ClientSideConnection
from acp.schema import (
    AgentMessageChunk,
    AgentThoughtChunk,
    ClientCapabilities,
    Implementation,
    TextContentBlock,
    ToolCallProgress,
    ToolCallStart,
    UsageUpdate,
)

from .backend import AgentBackend, AgentCallbacks, AgentState, Message

logger = logging.getLogger("diy.acp")

# ── 抑制 SDK 解析噪音 ──
logging.getLogger("acp").setLevel(logging.WARNING)

# ════════════════════════════════════════════════════════════════
# 内部 ACP Client
# ════════════════════════════════════════════════════════════════


class _AcpClient:
    """ACP session_update 接收器：累积流式 delta → 回调 → 拼装 Message。"""
    def __init__(self, callbacks: AgentCallbacks) -> None:
        self._cb = callbacks
        self.content_buf: list[str] = []
        self.reasoning_buf: list[str] = []
        self.tool_buf: list[dict] = []
        # ── 诊断追踪 ──
        self.event_count: int = 0
        self.last_event_type: str = ""
        # ── 可观测推送（由 AcpAgent 注入） ──
        self._push_event = None  # type: ignore[assignment]

    def on_connect(self, conn: ClientSideConnection) -> None:
        pass

    async def session_update(
        self,
        session_id: str,
        update: AgentMessageChunk
        | AgentThoughtChunk
        | ToolCallStart
        | ToolCallProgress
        | UsageUpdate
        | Any,
        **kwargs: Any,
    ) -> None:
        self.event_count += 1
        if isinstance(update, AgentMessageChunk):
            self.last_event_type = "text_delta"
            content = update.content
            text = (
                content.text
                if isinstance(content, TextContentBlock)
                else (str(content) if isinstance(content, str) else "")
            )
            if text:
                self.content_buf.append(text)
                if self._push_event:
                    self._push_event("agent", "text_delta", text[:200], event_type="text_delta")
                if self._cb.on_delta:
                    self._cb.on_delta(text)

        elif isinstance(update, AgentThoughtChunk):
            self.last_event_type = "thinking_delta"
            if update.thought and update.thought.content:
                self.reasoning_buf.append(update.thought.content)
                if self._push_event:
                    self._push_event("agent", "thinking_delta", update.thought.content[:200], event_type="thinking_delta")
                if self._cb.on_reasoning:
                    self._cb.on_reasoning(update.thought.content)

        elif isinstance(update, (ToolCallStart, ToolCallProgress)):
            tc = update.tool_call if hasattr(update, "tool_call") else None
            if tc:
                self.last_event_type = f"tool:{tc.name or '?'}"
                if self._push_event:
                    self._push_event("agent", "tool_call", f"tool:{tc.name or '?'}", event_type="toolcall_start", tool_name=tc.name)
                info = {
                    "name": tc.name or "?",
                    "id": tc.id or "",
                    "args": tc.arguments if isinstance(tc.arguments, dict) else {},
                }
                self.tool_buf.append(info)
                if self._cb.on_tool_start:
                    self._cb.on_tool_start(info["name"], info["id"], info["args"])

        elif isinstance(update, UsageUpdate):
            self.last_event_type = "usage"

    def finalize_message(self) -> Message:
        msg = Message(
            role="assistant",
            content="".join(self.content_buf),
            reasoning="\n".join(self.reasoning_buf),
            tool_calls=list(self.tool_buf),
            timestamp=datetime.now().strftime("%H:%M:%S"),
        )
        self.content_buf.clear()
        self.reasoning_buf.clear()
        self.tool_buf.clear()
        return msg

    # ── ACP Client 占位方法 ──

    async def request_permission(self, *a: Any, **kw: Any) -> Any:
        raise RequestError.method_not_found("session/request_permission")

    async def write_text_file(self, *a: Any, **kw: Any) -> Any:
        raise RequestError.method_not_found("fs/write_text_file")

    async def read_text_file(self, *a: Any, **kw: Any) -> Any:
        raise RequestError.method_not_found("fs/read_text_file")

    async def create_terminal(self, *a: Any, **kw: Any) -> Any:
        raise RequestError.method_not_found("terminal/create")

    async def terminal_output(self, *a: Any, **kw: Any) -> Any:
        raise RequestError.method_not_found("terminal/output")

    async def release_terminal(self, *a: Any, **kw: Any) -> Any:
        raise RequestError.method_not_found("terminal/release")

    async def wait_for_terminal_exit(self, *a: Any, **kw: Any) -> Any:
        raise RequestError.method_not_found("terminal/wait_for_exit")

    async def kill_terminal(self, *a: Any, **kw: Any) -> Any:
        raise RequestError.method_not_found("terminal/kill")

    async def ext_method(self, *a: Any, **kw: Any) -> Any:
        raise RequestError.method_not_found("ext_method")

    async def ext_notification(self, *a: Any, **kw: Any) -> None:
        raise RequestError.method_not_found("ext_notification")


# ════════════════════════════════════════════════════════════════
# AcpAgent
# ════════════════════════════════════════════════════════════════


class AcpAgent(AgentBackend):
    """AgentBackend — 通过 hermes acp 子进程实现。"""

    def __init__(
        self,
        task_uri: str,
        callbacks: AgentCallbacks | None = None,
        session_id: str | None = None,
    ) -> None:
        self._task_uri = task_uri
        self._callbacks = callbacks or AgentCallbacks()
        self._client = _AcpClient(self._callbacks)
        self._conn: ClientSideConnection | None = None
        self._session_id: str = session_id or ""
        self._restore_session_id: str | None = session_id  # 要恢复的旧 session
        self._history: list[Message] = []
        self._msg_queue: asyncio.Queue[tuple[str, asyncio.Future[str]]] = (
            asyncio.Queue()
        )
        self._stop_ev = asyncio.Event()
        self._ready_ev = asyncio.Event()
        self._state: str = "starting"
        self._done = False
        # ── 诊断追踪 ──
        self._prompt_start_ts: float = 0.0
        # ── 可观测推送（由外部注入） ──
        self._observer = None  # type: ignore[assignment]

    def _push_event(self, level: str, kind: str, data: str, **meta) -> None:
        """推送事件到 observer（如果已注入）。"""
        if self._observer is None:
            return
        import time

        from .observer import AgentEvent

        self._observer.push_event(
            self._task_uri,
            AgentEvent(
                ts=time.time(),
                level=level,
                kind=kind,
                source="acp",
                data=data,
                size=meta.pop("size", 0),
                meta=meta,
            ),
        )

    # ── AgentBackend 属性 ──

    @property
    def task_uri(self) -> str:
        return self._task_uri

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def history(self) -> list[Message]:
        return list(self._history)

    @property
    def state(self) -> str:
        return self._state

    @property
    def ready(self) -> asyncio.Event:
        return self._ready_ev

    @property
    def is_alive(self) -> bool:
        return self._state not in ("stopped", "error")

    # ── AgentBackend 生命周期 ──

    async def run(self, cwd: str | None = None) -> None:
        hermes_bin = self._find_hermes()
        logger.info("[%s] 启动 ACP: %s acp", self._task_uri, hermes_bin)

        try:
            async with spawn_agent_process(self._client, hermes_bin, "acp") as (
                conn,
                proc,
            ):
                self._conn = conn

                result = await conn.initialize(
                    protocol_version=PROTOCOL_VERSION,
                    client_capabilities=ClientCapabilities(),
                    client_info=Implementation(name="diy-acp-agent", version="0.1.0"),
                )
                logger.info(
                    "[%s] ACP handshake: %s v%s",
                    self._task_uri,
                    result.agent_info.name,
                    result.agent_info.version,
                )

                if self._restore_session_id:
                    # 恢复已有 session
                    logger.info(
                        "[%s] 恢复 session: %s",
                        self._task_uri,
                        self._restore_session_id,
                    )
                    session = await conn.load_session(
                        session_id=self._restore_session_id,
                        cwd=cwd or os.getcwd(),
                    )
                    self._session_id = self._restore_session_id
                else:
                    session = await conn.new_session(cwd=cwd or os.getcwd())
                    self._session_id = session.session_id
                    logger.info("[%s] 新 session: %s", self._task_uri, self._session_id)

                self._state = "idle"
                self._ready_ev.set()

                await self._service_loop(proc)

        except Exception as exc:
            self._state = "error"
            logger.error("[%s] %s", self._task_uri, exc)
            if self._callbacks.on_error:
                self._callbacks.on_error(str(exc))
        finally:
            self._done = True
            self._state = "stopped"
            logger.info("[%s] ACP stopped", self._task_uri)

    async def _service_loop(self, proc: asyncio.subprocess.Process) -> None:
        while not self._stop_ev.is_set():
            if proc.returncode is not None:
                logger.warning(
                    "[%s] hermes acp 已退出 code=%d", self._task_uri, proc.returncode
                )
                break

            try:
                text, future = await asyncio.wait_for(
                    self._msg_queue.get(), timeout=0.3
                )
            except TimeoutError:
                continue

            self._history.append(
                Message(
                    role="user",
                    content=text,
                    timestamp=datetime.now().strftime("%H:%M:%S"),
                )
            )
            self._state = "running"
            # ── 重置诊断计数器 ──
            self._client.event_count = 0
            self._client.last_event_type = ""
            self._prompt_start_ts = __import__("time").time()

            try:
                result = await asyncio.wait_for(
                    self._conn.prompt(
                        session_id=self._session_id, prompt=[text_block(text)]
                    ),
                    timeout=120,
                )
                msg = self._client.finalize_message()
                if msg.content or msg.reasoning:
                    self._history.append(msg)
                future.set_result(result.stop_reason)
            except TimeoutError:
                elapsed = __import__("time").time() - self._prompt_start_ts
                detail = (
                    f"已运行 {elapsed:.0f}s, "
                    f"收到 {self._client.event_count} 个事件, "
                    f"最后事件: {self._client.last_event_type or '(无)'}"
                )
                future.set_result("timeout")
                logger.warning("[%s] prompt 总超时 — %s", self._task_uri, detail)
                if self._callbacks.on_error:
                    self._callbacks.on_error(f"prompt 总超时 — {detail}")
                try:
                    await self._conn.cancel(session_id=self._session_id)
                except Exception:
                    logger.debug("[acp] cancel 异常（连接已关闭）", exc_info=True)
            except Exception as exc:
                future.set_exception(exc)
                if self._callbacks.on_error:
                    self._callbacks.on_error(str(exc))
            finally:
                self._state = "idle"

    # ── AgentBackend 交互 ──

    async def send(self, text: str) -> str:
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        await self._msg_queue.put((text, future))
        return await future

    async def cancel(self) -> None:
        if self._conn and self._session_id:
            await self._conn.cancel(session_id=self._session_id)

    async def stop(self) -> None:
        self._stop_ev.set()
        for _ in range(100):
            if self._done:
                break
            await asyncio.sleep(0.1)

    # ── 快照 ──

    def state_snapshot(self) -> AgentState:
        now = __import__("time").time()
        return AgentState(
            task_uri=self._task_uri,
            session_id=self._session_id,
            state=self._state,
            message_count=len(self._history),
            event_count=self._client.event_count,
            last_event_type=self._client.last_event_type,
            prompt_elapsed=(now - self._prompt_start_ts) if self._prompt_start_ts and self._state == "running" else 0,
        )

    # ── 工具 ──

    @staticmethod
    def _find_hermes() -> str:
        for c in ["hermes", str(Path.home() / ".local" / "bin" / "hermes")]:
            if "/" not in c:
                if shutil.which(c):
                    return c
            elif Path(c).is_file() and os.access(c, os.X_OK):
                return c
        return "hermes"
