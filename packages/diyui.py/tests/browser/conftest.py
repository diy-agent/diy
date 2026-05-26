"""
浏览器测试专用 conftest。

Pytest 约定：
  conftest.py 的作用域是从它所在目录向下所有子目录。本文件放在 tests/browser/ 下，
  只会影响 browser 目录内的测试，不会污染 unit / intent / integration 等其他测试。
"""

from __future__ import annotations

import socket
import subprocess
import time
from collections.abc import Generator

import pytest


def _find_free_port() -> int:
    """找到可用端口。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def panel_server() -> Generator[str, None, None]:
    """启动 Panel 开发服务器，返回 base_url。

    scope="session"：整个测试 session 只启动一次，所有 browser 测试共享。
    测试方法通过参数名注入：def test_xxx(page, panel_server): ...
    yield 之前的代码是 setup，yield 之后的代码是 teardown（测试结束后执行）。
    """
    port = _find_free_port()
    proc = subprocess.Popen(
        [
            "uv",
            "run",
            "panel",
            "serve",
            "tests/browser/browser_test_app.py",
            "--port",
            str(port),
            "--allow-websocket-origin",
            f"localhost:{port}",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    base_url = f"http://localhost:{port}"

    # 等待 server 就绪（最多 15 秒）
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                break
        except (ConnectionRefusedError, OSError):
            time.sleep(0.5)
    else:
        proc.terminate()
        proc.wait()
        raise RuntimeError(f"Panel server 未能在 {port} 启动")

    yield base_url  # ← 测试在这里执行

    # teardown：测试结束后关闭 server
    proc.terminate()
    proc.wait(timeout=5)


def pytest_addoption(parser: pytest.Parser) -> None:
    """注册 --no-browser 命令行选项。

    pytest 在启动时自动调用此函数。用户可通过 `--no-browser` 跳过浏览器测试。
    """
    parser.addoption("--no-browser", action="store_true", help="跳过浏览器测试")


def pytest_configure(config: pytest.Config) -> None:
    """注册 browser marker。

    pytest 在配置阶段自动调用。注册后测试文件可用 `@pytest.mark.browser`。
    """
    config.addinivalue_line("markers", "browser: 需要 headless browser 的测试")


def pytest_collection_modifyitems(
    config: pytest.Config, items: list[pytest.Item]
) -> None:
    """测试收集后、执行前的钩子。

    pytest 自动调用。若用户传了 --no-browser，遍历所有已收集的测试项，
    把带 browser marker 的标记为 skip。
    """
    if config.getoption("no_browser"):
        skip = pytest.mark.skip(reason="--no-browser 跳过")
        for item in items:
            if "browser" in item.keywords:
                item.add_marker(skip)
