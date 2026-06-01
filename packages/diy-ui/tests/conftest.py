"""
Pytest conftest 约定：
  只要 tests/ 目录下有 conftest.py（即使是空文件），pytest 就会把 tests/ 加入
  sys.path。这样 tests/ 下的模块（如 helpers.py）可以被 `from helpers import ...`
  直接引用，无需写 `from tests.helpers import ...`。

  本文件同时注册全局 CLI 选项和 marker，供 browser 子目录的 conftest 使用。
"""

from __future__ import annotations

import pytest


def pytest_addoption(parser: pytest.Parser) -> None:
    """注册 --no-browser 命令行选项。

    pytest 在启动时自动调用此函数。用户可通过 `--no-browser` 跳过浏览器测试。
    放在根 conftest 以保证所有子目录都可访问该选项。
    """
    parser.addoption("--no-browser", action="store_true", help="跳过浏览器测试")
