"""
PiRpcAgent — AgentBackend 实现，使用 pi --mode rpc 子进程。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

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

    @staticmethod
    def _session_path(task_uri: str) -> Path:
        """返回 task 对应的 pi session 文件路径（确定性路径）。"""
        _diy_home = Path(os.environ.get("DIY_HOME", os.path.expanduser("~/.diy")))
        safe_name = task_uri.replace("/", "_")
        return _diy_home / "pi-sessions" / f"{safe_name}.jsonl"

    async def run(self, cwd: str | None = None) -> None:
        pi_bin = self._find_pi()
        session_path = self._session_path(self._task_uri)
        session_path.parent.mkdir(parents=True, exist_ok=True)
        args = [
            pi_bin,
            "--mode",
            "rpc",
            "--thinking",
            "off",
            "--session",
            str(session_path),
        ]
        if self._provider:
            args += ["--provider", self._provider]
        if self._model:
            args += ["--model", self._model]

        logger.info("[%s] 启动 pi: %s", self._task_uri, " ".join(args))

        import subprocess as _sp

        try:
            self._proc = _sp.Popen(
                args,
                stdin=_sp.PIPE,
                stdout=_sp.PIPE,
                stderr=_sp.PIPE,
                cwd=cwd,
            )

            reader = asyncio.create_task(
                self._read_loop(), name=f"pi-rd-{self._task_uri}"
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

    async def _read_loop(self) -> None:
        """持续读取 stdout JSONL 事件（使用 run_in_executor 兼容 QAsyncio）。

        加入超时让 CancelledError 能及时传播——纯 run_in_executor 在线程池里
        阻塞 readline，事件循环退出时无法中断该线程，导致 shutdown 卡死。
        """
        if not self._proc or not self._proc.stdout:
            return
        loop = asyncio.get_running_loop()

        try:
            while True:
                try:
                    line = await asyncio.wait_for(
                        loop.run_in_executor(None, self._proc.stdout.readline),
                        timeout=1.0,
                    )
                except TimeoutError:
                    # 超时只是为了给 CancelledError 传播机会，不处理
                    continue
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").rstrip("\n\r")
                if not text:
                    continue
                try:
                    ev = json.loads(text)
                except json.JSONDecodeError:
                    continue
                await self._on_event(ev)
        except asyncio.CancelledError:
            # 关闭子进程 stdout 让线程池里的 readline 立即返回
            if self._proc and self._proc.stdout:
                self._proc.stdout.close()
            raise

    async def _on_event(self, ev: dict[str, Any]) -> None:
        t = ev.get("type")

        if t == "message_update":
            self._last_event_ts = __import__("time").time()
            d = ev.get("assistantMessageEvent", {})
            dt = d.get("type")

            if dt == "text_delta":
                txt: str = d.get("delta", "") or ""
                if txt:
                    self._current_text += txt
                    if self._callbacks.on_delta:
                        self._callbacks.on_delta(txt)

            elif dt == "thinking_delta":
                txt = d.get("delta", "") or ""
                if txt:
                    self._current_thinking += txt
                    if self._callbacks.on_reasoning:
                        self._callbacks.on_reasoning(txt)

            elif dt == "toolcall_start":
                tc = d.get("toolCall", {}) or {}
                if self._callbacks.on_tool_start:
                    self._callbacks.on_tool_start(
                        tc.get("name", "?"),
                        tc.get("id", ""),
                        tc.get("arguments", {}),
                    )

        elif t == "agent_end":
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

            try:
                self._write({"type": "prompt", "message": text})
                self._last_event_ts = __import__("time").time()

                IDLE = 30
                TOTAL = 120
                deadline = __import__("time").time() + TOTAL

                while True:
                    remaining = deadline - __import__("time").time()
                    if remaining <= 0:
                        raise TimeoutError("总超时")
                    idle_wait = min(IDLE, remaining)
                    try:
                        await asyncio.wait_for(
                            self._prompt_done.wait(), timeout=idle_wait
                        )
                        break
                    except TimeoutError:
                        # idle 超时：检查最后一次事件
                        if __import__("time").time() - self._last_event_ts >= IDLE:
                            raise TimeoutError("静默超时") from None

                future.set_result("end_turn")
                if self._callbacks.on_finished:
                    self._callbacks.on_finished("end_turn")
            except TimeoutError:
                future.set_result("timeout")
                if self._callbacks.on_error:
                    self._callbacks.on_error("prompt 超时")
                if self._callbacks.on_finished:
                    self._callbacks.on_finished("timeout")
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

    def _write(self, data: dict[str, Any]) -> None:
        if self._proc and self._proc.stdin:
            line = json.dumps(data, ensure_ascii=False) + "\n"
            self._proc.stdin.write(line.encode("utf-8"))
            self._proc.stdin.flush()

    # ── AgentBackend 交互 ──

    async def send(self, text: str) -> str:
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        await self._msg_queue.put((text, future))
        return await future

    async def cancel(self) -> None:
        self._write({"type": "abort"})

    async def stop(self) -> None:
        self._stop_ev.set()
        if self._proc and self._proc.returncode is None:
            self._write({"type": "abort"})
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
        return AgentState(
            task_uri=self._task_uri,
            session_id=self._session_id,
            state=self._state,
            message_count=len(self._history),
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
