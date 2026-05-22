"""pytest 浏览器测试配置 — Panel server + Playwright。

添加 --no-browser 标记可跳过浏览器测试。
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
    """启动 Panel 开发服务器，返回 base_url。"""
    port = _find_free_port()
    proc = subprocess.Popen(
        [
            "uv",
            "run",
            "panel",
            "serve",
            "tests/browser_test_app.py",
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

    yield base_url

    proc.terminate()
    proc.wait(timeout=5)


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption("--no-browser", action="store_true", help="跳过浏览器测试")


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "browser: 需要 headless browser 的测试")


def pytest_collection_modifyitems(
    config: pytest.Config, items: list[pytest.Item]
) -> None:
    if config.getoption("no_browser"):
        skip = pytest.mark.skip(reason="--no-browser 跳过")
        for item in items:
            if "browser" in item.keywords:
                item.add_marker(skip)
