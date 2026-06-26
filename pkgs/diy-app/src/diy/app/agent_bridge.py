"""Agent Bridge — GUI ↔ Agent 通信协议。

基于文件系统的轻量 bridge:
  ~/.diy/agents/<uri-sanitized>/
  ├── status.json    # agent 状态
  ├── progress.log   # 最后 20 行输出
  └── steer.log      # /steer 对话历史

Agent 启动时写 status.json，GUI 用 QFileSystemWatcher 监控。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

_AGENTS_DIR = Path.home() / ".diy" / "agents"


# ═══════════════════════════════════════════════════════
# 读写
# ═══════════════════════════════════════════════════════


@dataclass
class AgentStatus:
    agent_id: str
    task_id: str = ""  # 任务 URI（向后兼容，旧 agent 可能还是 int）
    state: str = "running"  # running | done | blocked | error
    pid: int | None = None
    model: str = ""
    started_at: str = ""

    def to_dict(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "task_id": self.task_id,
            "state": self.state,
            "pid": self.pid,
            "model": self.model,
            "started_at": self.started_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> AgentStatus:
        tid = d.get("task_id", "")
        return cls(
            agent_id=d.get("agent_id", ""),
            task_id=str(tid) if tid else "",
            state=d.get("state", "running"),
            pid=d.get("pid"),
            model=d.get("model", ""),
            started_at=d.get("started_at", ""),
        )


def _task_dir(task_id: str) -> Path:
    return _AGENTS_DIR / task_id


def write_status(status: AgentStatus) -> None:
    """agent 写入自身状态。"""
    d = _task_dir(status.task_id)
    d.mkdir(parents=True, exist_ok=True)

    status.started_at = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    tmp = d / "status.json.tmp"
    with open(tmp, "w") as fh:
        json.dump(status.to_dict(), fh, indent=2)
    tmp.replace(d / "status.json")


def read_status(task_id: str) -> AgentStatus | None:
    """GUI 读取 agent 状态。"""
    p = _task_dir(task_id) / "status.json"
    if not p.exists():
        return None
    with open(p) as fh:
        return AgentStatus.from_dict(json.load(fh))


def read_progress(task_id: str, tail: int = 20) -> str:
    """读取 agent 执行进度（最后 N 行）。"""
    p = _task_dir(task_id) / "progress.log"
    if not p.exists():
        return ""
    with open(p) as fh:
        lines = fh.readlines()
    return "".join(lines[-tail:])


def list_agents() -> list[AgentStatus]:
    """列出所有活跃 agent（递归扫描 ~/.diy/agents/）。"""
    result: list[AgentStatus] = []
    if not _AGENTS_DIR.exists():
        return result

    for p in _AGENTS_DIR.rglob("status.json"):
        try:
            with open(p) as fh:
                status = AgentStatus.from_dict(json.load(fh))
            result.append(status)
        except (json.JSONDecodeError, KeyError):
            pass
    return result


def clear_status(task_id: str) -> None:
    """清除 agent 状态（agent 完成后调用）。"""
    sf = _task_dir(task_id) / "status.json"
    if sf.exists():
        sf.unlink()


# ═══════════════════════════════════════════════════════
# Steer 通信
# ═══════════════════════════════════════════════════════


def steer_send(task_uri: str, message: str) -> None:
    """GUI 发送 /steer 消息给 agent。"""
    d = _AGENTS_DIR / task_uri
    d.mkdir(parents=True, exist_ok=True)

    ts = datetime.now().strftime("%H:%M:%S")
    with open(d / "steer.log", "a") as fh:
        fh.write(f"[{ts}] ← {message}\n")


def steer_read(task_uri: str) -> str:
    """读取 steer 对话历史。"""
    p = _AGENTS_DIR / task_uri / "steer.log"
    if not p.exists():
        return ""
    with open(p) as fh:
        return fh.read()


def steer_reply(task_uri: str, message: str) -> None:
    """agent 回复 /steer 消息。"""
    d = _AGENTS_DIR / task_uri
    d.mkdir(parents=True, exist_ok=True)

    ts = datetime.now().strftime("%H:%M:%S")
    with open(d / "steer.log", "a") as fh:
        fh.write(f"[{ts}] → {message}\n")


# ═══════════════════════════════════════════════════════
# Agent 启动辅助
# ═══════════════════════════════════════════════════════


def make_agent_id(task_uri: str) -> str:
    """生成 agent ID。"""
    return f"agent-{task_uri}-{datetime.now().strftime('%H%M%S')}"
