"""diy-llm 意图测试共享配置。

sh fixture 使用 subprocess 直接运行 diy-llm（非 PTY，因为 litellm 导入在 PTY 中会 hang）。
fake_home fixture 将 $HOME 隔离到临时目录。
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

import pytest

_PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def run_diy_llm(args: str, *, cwd: str | None = None) -> tuple[int, str, str]:
    """Run diy-llm CLI in subprocess (pipe, no PTY)."""
    cmd = f"source .venv/bin/activate && diy-llm {args}"
    p = subprocess.run(
        ["bash", "--norc", "-c", cmd],
        capture_output=True,
        text=True,
        cwd=cwd or _PROJECT,
        timeout=30,
    )
    return p.returncode, p.stdout.strip(), p.stderr.strip()


@pytest.fixture
def sh():
    """简化的命令执行器，返回 (code, stdout, stderr)。"""
    return lambda args: run_diy_llm(args)


@pytest.fixture
def fake_home(monkeypatch):
    """独立 $HOME — diy-llm 数据存于临时目录，隔离测试。"""
    tmp = Path(tempfile.mkdtemp(prefix="diy-llm-test-"))
    real = Path.home()

    for d in [".config", ".local", ".ssh", ".cache"]:
        src = real / d
        if src.exists():
            (tmp / d).symlink_to(src)
    for f in [".gitconfig"]:
        src = real / f
        if src.exists():
            (tmp / f).symlink_to(src)

    monkeypatch.setenv("HOME", str(tmp))
    return tmp
