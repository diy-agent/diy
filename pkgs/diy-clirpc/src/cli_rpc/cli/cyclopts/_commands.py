"""Cyclopts 实验性命令定义 — 后面会替换为 diy 的真实命令。"""

from __future__ import annotations

import asyncio
from typing import Annotated

from cli_rpc.cli.cyclopts._dispatch import install_meta_launcher
from cli_rpc.core._types import Request, Response

from cyclopts import App, Parameter

# ── 注入用的类型别名 ──
Req = Annotated[Request, Parameter(parse=False)]
Resp = Annotated[Response, Parameter(parse=False)]

# ── Cyclopts App ──
# ⚠️  关键设置：exit_on_error=False 必须保持。
#      设为 True → Cyclopts 出错时 sys.exit(1)，会杀死 uvicorn 进程。
#      RPC 模式下必须让异常抛到 handler 层，由框架转 exit_code。
diy = App(
    name="diy", help_flags=["-h", "--help"], print_error=False, exit_on_error=False
)


# ════════════════════════════════════════════════════════════
# 命令定义
# ════════════════════════════════════════════════════════════


@diy.command
def task_list(*, response: Resp):
    """列出所有任务"""
    response.out.print("📋 任务列表:")
    response.out.print("  task/001  实现 RPC (active)")
    response.out.print("  task/002  重构 Gateway (pending)")


@diy.command
def task_detail(uri: str, *, response: Resp = None):
    """查看任务详情"""
    response.out.print(f"📄 任务 {uri}:")
    response.out.print("  状态: active")
    response.out.print("  优先级: high")


@diy.command
def ref_sync(*, response: Resp):
    """同步 ref"""
    response.out.print("✅ ref 同步完成")


@diy.command
async def log_tail(*, request: Req, response: Resp):
    """实时日志（模拟 serverStream，含 stderr 分流）"""
    response.out.print("📋 开始监听日志...")
    for i in range(3):
        response.out.print(f"[{i}] 心跳正常")
        await asyncio.sleep(0.2)
    response.err.print("⚠️ 连接超时，重试中...")
    await asyncio.sleep(0.2)
    for i in range(3, 5):
        response.out.print(f"[{i}] 连接恢复")
        await asyncio.sleep(0.2)
    response.out.print("--- 日志结束 ---")


@diy.command
async def chat(*, request: Req, response: Resp):
    """回声 stdin — 通过 duplexStream 接收 stdin 并返回"""
    async for chunk in request.stdin:
        response.out.write(chunk)
    response.out.print("✓ 对话结束")


@diy.command
async def count_bytes(*, request: Req, response: Resp):
    """统计 stdin 字节数 — 通过 duplexStream 或 clientStream"""
    total = 0
    async for chunk in request.stdin:
        total += len(chunk)
    response.out.print(f"  stdin: {total} bytes")


# ── 嵌套子命令 ──

ui = App(name="ui")


@ui.command
def status(*, response: Resp):
    """管控台状态"""
    response.out.print("✅ 管控台运行中 (pid=12345)")


@ui.command(name="tree")
def ui_tree(*, response: Resp):
    """任务树"""
    response.out.print("📁 task/")
    response.out.print("  ├── 001 实现 RPC")
    response.out.print("  ├── 002 重构 Gateway")
    response.out.print("  └── 003 写测试")


diy.command(ui)

# ── 安装 meta app launcher（替代 CycloptsRouter）──
install_meta_launcher(diy)


__all__ = ["diy", "ui"]
