"""diy-app 测试共享 fixture。"""

import os
import tempfile
from pathlib import Path

import pytest


@pytest.fixture
def fake_home(monkeypatch):
    """独立 $HOME 目录，隔离 ~/.diy/ 数据。"""
    tmp = Path(tempfile.mkdtemp(prefix="diy-app-test-"))

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
    monkeypatch.setenv("DIY_HOME", str(tmp))

    return tmp
