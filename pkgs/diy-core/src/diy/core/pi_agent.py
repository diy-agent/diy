"""
PiRpcAgent — AgentBackend 实现，使用 pi --mode rpc 子进程。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import time
from datetime import datetime
from pathlib import Path
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from .observer import AgentEvent

from .backend import AgentBackend, AgentCallbacks, AgentState, Message

logger = logging.getLogger("diy.pi")


class PiRpcAgent(AgentBackend):
    """AgentBackend — 通过 pi --mode rpc 子进程实现。"""

    def __init__(
        self,
        task_uri: str,
        *,
        callbacks: AgentCallbacks | None = None,
        provider: str | None = None,
        model: str | None = None,
    ) -> None:
        self._task_uri = task_uri
        self._callbacks = callbacks or AgentCallbacks()
        self._provider = provider
        self._model = model

        self._proc: asyncio.subprocess.Process | None = None
        self._session_id: str = ""
        self._history: list[Message] = []
        self._msg_queue: asyncio.Queue[tuple[str, asyncio.Future[str]]] = (
            asyncio.Queue()
        )
        self._stop_ev = asyncio.Event()
        self._ready_ev = asyncio.Event()
        self._state: str = "starting"
        self._done = False

        # 流式缓冲
        self._current_text = ""
        self._current_thinking = ""
        self._prompt_done = asyncio.Event()
        self._last_event_ts: float = 0.0
        # ── 诊断追踪 ──
        self._event_count: int = 0  # 本次 prompt 收到的事件总数
        self._last_event_type: str = ""  # 最后事件类型
        self._prompt_start_ts: float = 0.0  # prompt 发送时间
        # ── 可观测推送（由外部注入） ──
        self._observer = None  # type: ignore[assignment]

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
        pi_bin = self._find_pi()
        args = [
            pi_bin,
            "--mode",
            "rpc",
            "--thinking",
            "off",
        ]
        if self._provider:
            args += ["--provider", self._provider]
        if self._model:
            args += ["--model", self._model]

        logger.info("[%s] 启动 pi: %s", self._task_uri, " ".join(args))

        _sp = __import__("subprocess")

        try:
            self._proc = _sp.Popen(
                args,
                stdin=_sp.PIPE,
                stdout=_sp.PIPE,
                stderr=_sp.PIPE,
                cwd=cwd,
            )

            loop = asyncio.get_running_loop()

            # 并发启动 stdout reader + stderr reader（run_in_executor + read(4096)）
            # QAsyncio 不支持 create_subprocess_exec，回退到 Popen
            reader = asyncio.create_task(
                self._read_loop(loop), name=f"pi-rd-{self._task_uri}"
            )
            asyncio.create_task(
                self._read_stderr(loop), name=f"pi-err-{self._task_uri}"
            )

            self._session_id = f"pi-{self._task_uri}"
            self._state = "idle"
            self._ready_ev.set()
            logger.info("[%s] pi 就绪 pid=%d", self._task_uri, self._proc.pid)

            await self._service_loop(reader)

        except Exception as exc:
            self._state = "error"
            logger.error("[%s] %s", self._task_uri, exc)
            if self._callbacks.on_error:
                self._callbacks.on_error(str(exc))
        finally:
            self._done = True
            self._state = "stopped"
            logger.info("[%s] pi 已停止", self._task_uri)

    async def _read_loop(self, loop) -> None:
        """持续读取 stdout — 三层监控：raw → protocol → agent。

        QAsyncio 兼容：使用 Popen + run_in_executor(read)。
        用 read(4096) 代替 readline()——有数据就返回，不等 \\n，
        避免阻塞半行时线程泄漏。
        """
        if not self._proc or not self._proc.stdout:
            return

        buf = ""
        while True:
            try:
                data = await loop.run_in_executor(
                    None, self._proc.stdout.read, 4096
                )
            except Exception:
                break
            if not data:  # EOF
                break

            # ── Layer 1: raw 字节流 ──
            self._push_event("raw", "pi", data.decode("utf-8", errors="replace")[:500], size=len(data))

            # ── Layer 2+3: 拆行 + JSONL 解析 ──
            buf += data.decode("utf-8", errors="replace")
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                line = line.strip()
                if not line:
                    continue

                # Layer 2: 协议消息
                self._push_event("protocol", "pi", line[:300], line_len=len(line))

                # Layer 3: 业务事件
                try:
                    ev = json.loads(line)
                    await self._on_event(ev)
                except json.JSONDecodeError:
                    self._push_event("error", "pi", f"JSON 解析失败: {line[:100]}")

        # ── EOF 后处理 buf 中残留的半行 ──
        if buf.strip():
            line = buf.strip()
            self._push_event("protocol", "pi", line[:300], line_len=len(line), partial=True)
            try:
                ev = json.loads(line)
                await self._on_event(ev)
            except json.JSONDecodeError:
                self._push_event("error", "pi", f"JSON 解析失败(EOF): {line[:100]}")

    async def _read_stderr(self, loop) -> None:
        """持续读取 stderr — Layer 1 raw 监控。"""
        if not self._proc or not self._proc.stderr:
            return

        while True:
            try:
                data = await loop.run_in_executor(
                    None, self._proc.stderr.read, 4096
                )
            except Exception:
                break
            if not data:
                break
            text = data.decode("utf-8", errors="replace")
            self._push_event("raw", "pi", text[:500], size=len(data), stream="stderr")

    def _push_event(self, level: str, kind: str, data: str, **meta) -> None:
        """推送事件到 observer（如果已注入）。

        level: "raw" | "protocol" | "agent" | "lifecycle" | "error"
        kind: 事件类型（stdout/stderr/jsonl/text_delta/tool_call/...）
        """
        if self._observer is None:
            return
        from .observer import AgentEvent

        self._observer.push_event(
            self._task_uri,
            AgentEvent(
                ts=time.time(),
                level=level,
                kind=kind,
                source="pi",
                data=data,
                size=meta.pop("size", 0),
                meta=meta,
            ),
        )

    async def _on_event(self, ev: dict[str, Any]) -> None:
        t = ev.get("type")
        now = __import__("time").time()

        if t == "message_update":
            self._last_event_ts = now
            self._event_count += 1
            d = ev.get("assistantMessageEvent", {})
            dt = d.get("type", "")
            self._last_event_type = dt or t

            if dt == "text_delta":
                txt: str = d.get("delta", "") or ""
                if txt:
                    self._current_text += txt
                    self._push_event("agent", "pi", txt[:200], event_type="text_delta")
                    if self._callbacks.on_delta:
                        self._callbacks.on_delta(txt)

            elif dt == "thinking_delta":
                txt = d.get("delta", "") or ""
                if txt:
                    self._current_thinking += txt
                    self._push_event("agent", "pi", txt[:200], event_type="thinking_delta")
                    if self._callbacks.on_reasoning:
                        self._callbacks.on_reasoning(txt)

            elif dt == "toolcall_start":
                tc = d.get("toolCall", {}) or {}
                self._last_event_type = f"tool:{tc.get('name', '?')}"
                tool_name = tc.get("name", "?")
                self._push_event("agent", "pi", f"tool:{tool_name}", event_type="toolcall_start", tool_name=tool_name)
                if self._callbacks.on_tool_start:
                    self._callbacks.on_tool_start(
                        tc.get("name", "?"),
                        tc.get("id", ""),
                        tc.get("arguments", {}),
                    )

        elif t == "agent_end":
            self._last_event_type = "agent_end"
            self._last_event_ts = now
            self._push_event("agent", "pi", "agent_end", event_type="agent_end")
            if self._current_text.strip():
                self._history.append(
                    Message(
                        role="assistant",
                        content=self._current_text.strip(),
                        reasoning=self._current_thinking.strip(),
                        timestamp=datetime.now().strftime("%H:%M:%S"),
                    )
                )
            self._current_text = ""
            self._current_thinking = ""
            self._prompt_done.set()

    async def _service_loop(self, reader: asyncio.Task) -> None:
        while not self._stop_ev.is_set():
            if self._proc and self._proc.returncode is not None:
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
            self._current_text = ""
            self._current_thinking = ""
            self._prompt_done.clear()
            # ── 重置诊断计数器 ──
            self._event_count = 0
            self._last_event_type = ""

            try:
                await self._write({"type": "prompt", "message": text})
                now = __import__("time").time()
                self._last_event_ts = now
                self._prompt_start_ts = now
                logger.info(
                    "[%s] prompt 发送 (provider=%s model=%s)",
                    self._task_uri, self._provider, self._model,
                )

                IDLE = 30
                TOTAL = 120
                deadline = now + TOTAL

                while True:
                    remaining = deadline - __import__("time").time()
                    if remaining <= 0:
                        elapsed = __import__("time").time() - self._prompt_start_ts
                        raise TimeoutError(
                            f"总超时 ({TOTAL}s) — "
                            f"已运行 {elapsed:.0f}s, "
                            f"收到 {self._event_count} 个事件, "
                            f"最后事件: {self._last_event_type or '(无)'}"
                        )
                    idle_wait = min(IDLE, remaining)
                    try:
                        await asyncio.wait_for(
                            self._prompt_done.wait(), timeout=idle_wait
                        )
                        break
                    except TimeoutError:
                        # idle 超时：检查最后一次事件
                        now = __import__("time").time()
                        if now - self._last_event_ts >= IDLE:
                            elapsed = now - self._prompt_start_ts
                            raise TimeoutError(
                                f"静默超时 ({IDLE}s 无事件) — "
                                f"已运行 {elapsed:.0f}s, "
                                f"收到 {self._event_count} 个事件, "
                                f"最后事件: {self._last_event_type or '(无)'}"
                            ) from None

                future.set_result("end_turn")
                if self._callbacks.on_finished:
                    self._callbacks.on_finished("end_turn")
            except TimeoutError as exc:
                future.set_result("timeout")
                logger.warning(
                    "[%s] %s", self._task_uri, exc,
                )
                if self._callbacks.on_error:
                    self._callbacks.on_error(f"prompt 超时 — {exc}")
                if self._callbacks.on_finished:
                    self._callbacks.on_finished("timeout")
                # 停掉卡住的 pi，下次 send 时 AgentManager 会创建新 agent
                self._state = "error"
                self._stop_ev.set()
                if self._proc and self._proc.returncode is None:
                    try:
                        self._proc.terminate()
                    except Exception:
                        pass
            except Exception as exc:
                future.set_exception(exc)
                if self._callbacks.on_error:
                    self._callbacks.on_error(str(exc))
                if self._callbacks.on_finished:
                    self._callbacks.on_finished(f"error:{exc}")
            finally:
                self._state = "idle"

        reader.cancel()
        try:
            await reader
        except asyncio.CancelledError:
            logger.debug("[pi] reader 已取消")

    async def _write(self, data: dict[str, Any]) -> None:
        """写入 stdin — run_in_executor 避免阻塞 Qt 事件循环。

        Popen.stdin.write 是同步的，放到线程池执行。必须 flush()，
        否则数据留在缓冲区无法到达子进程 stdin。
        """
        if self._proc and self._proc.stdin:
            line = json.dumps(data, ensure_ascii=False) + "\n"
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(
                None, self._proc.stdin.write, line.encode("utf-8")
            )
            await loop.run_in_executor(None, self._proc.stdin.flush)

    # ── AgentBackend 交互 ──

    async def send(self, text: str) -> str:
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        await self._msg_queue.put((text, future))
        return await future

    async def cancel(self) -> None:
        await self._write({"type": "abort"})

    async def stop(self) -> None:
        self._stop_ev.set()
        if self._proc and self._proc.returncode is None:
            await self._write({"type": "abort"})
            self._proc.terminate()
            try:
                loop = asyncio.get_running_loop()
                await asyncio.wait_for(
                    loop.run_in_executor(None, self._proc.wait), timeout=3
                )
            except TimeoutError:
                self._proc.kill()
        for _ in range(50):
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
            provider=self._provider or "",
            model=self._model or "",
            pid=self._proc.pid if self._proc else 0,
            event_count=self._event_count,
            last_event_type=self._last_event_type,
            last_event_age=(now - self._last_event_ts) if self._last_event_ts else 0,
            prompt_elapsed=(now - self._prompt_start_ts) if self._prompt_start_ts and self._state == "running" else 0,
        )

    # ── 工具 ──

    @staticmethod
    def _find_pi() -> str:
        for c in ["pi", str(Path.home() / ".bun" / "bin" / "pi")]:
            if "/" not in c:
                if shutil.which(c):
                    return c
            elif Path(c).is_file() and os.access(c, os.X_OK):
                return c
        return "pi"
