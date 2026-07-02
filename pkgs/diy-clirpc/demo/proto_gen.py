"""proto_gen — 从 Cyclopts App 反射生成 ConnectRPC proto + 客户端桩

流水线:
  1. 遍历 Cyclopts 命令树，提取命令名、参数、文档、流式模式
  2. 生成 .proto 文件（每个命令一个 RPC 方法，带类型消息）
  3. 从 .proto 生成 Python/TS 客户端
  4. 服务端用新生成的 Servicer 路由到 Cyclopts Dispatch

用法:
    uv run python demo/proto_gen.py              # 生成 proto
    uv run python demo/proto_gen.py --gen-py      # 生成 proto + Python 桩
"""

from __future__ import annotations

import argparse
import ast
import inspect
import re
import textwrap
from pathlib import Path
from typing import Any, get_type_hints

from cyclopts import App

# ── 类型到 proto 类型映射 ──

PROTO_TYPE_MAP: dict[type, str] = {
    str: "string",
    int: "int32",
    float: "double",
    bool: "bool",
    bytes: "bytes",
}

# ── 多参数的集合映射 ──
COLLECTION_TYPES = {
    list: "repeated",
    set: "repeated",
    tuple: "repeated",
}

# ── 注入参数（不需要生成 proto 字段） ──
INJECTED_PARAMS = {"request", "response"}


def _python_type_to_proto_type(typ: type) -> str:
    """将 Python 类型注解转为 proto 类型字符串。"""
    origin = getattr(typ, "__origin__", None)
    if origin in COLLECTION_TYPES:
        args = getattr(typ, "__args__", [str])
        inner = _python_type_to_proto_type(args[0]) if args else "string"
        return f"repeated {inner}"
    if typ in PROTO_TYPE_MAP:
        return PROTO_TYPE_MAP[typ]
    # fallback
    name = getattr(typ, "__name__", str(typ))
    return f"string /* {name} */"


def _detect_stream_mode(func) -> str:
    """通过函数源码推断 RPC 流式模式。

    规则:
      - 读取 request.stdin → 需要流式输入（clientStream / duplexStream）
      - async def + 多次写入输出 → 流式输出（serverStream / duplexStream）
      - 否则 → unary
    """
    source = ""
    try:
        source = inspect.getsource(func)
    except Exception:
        pass

    has_stdin_iteration = bool(re.search(r"async\s+for\s+\w+\s+in\s+request\.stdin", source))
    has_await_sleep = "await asyncio.sleep" in source
    has_loop = bool(re.search(r"\b(for|while)\b\s*.*:\n", source))

    # 流式输出检测条件：有循环 + await 延迟，才是真正的流
    is_stream_output = bool(re.search(r"(?:for|while)\b.*:\n(?:.*\n)*?.*await\s+asyncio\.sleep", source))

    if has_stdin_iteration:
        if is_stream_output:
            return "duplexStream"
        return "clientStream"
    if is_stream_output:
        return "serverStream"
    if has_await_sleep:
        # 有 await sleep 但不在循环里 → 顺序流（如 log_tail 的多个 sleep)
        # 检查源码中 sleep 后跟 write/print 的节拍
        sleep_count = source.count("await asyncio.sleep")
        if sleep_count > 1:
            return "serverStream"
    return "unary"


def _flatten_command_tree(app: App, prefix: list[str] | None = None) -> list[dict]:
    """递归遍历 Cyclopts App 命令树，返回扁平化命令列表。

    Cyclopts 将每个命令存储为 App 对象（含子 App），
    实际函数在 cmd_app.default_command。
    """
    prefix = prefix or []
    commands = []
    seen = set()

    # _registered_commands 只含用户注册的命令，不含 -h/--help 等内置命令
    cmd_map = getattr(app, "_registered_commands", app._commands)

    for name, cmd_app in cmd_map.items():
        if name.startswith("-"):
            continue
        if id(cmd_app) in seen:
            continue
        seen.add(id(cmd_app))

        # 取出实际函数
        func = cmd_app.default_command if isinstance(cmd_app, App) else cmd_app
        if not callable(func):
            # 嵌套子 App（如 ui），递归
            sub_commands = _flatten_command_tree(
                cmd_app, prefix=prefix + [name]
            )
            commands.extend(sub_commands)
            continue

        commands.append({
            "name": name,
            "full_name": "_".join(prefix + [name]) if prefix else name,
            "argv": prefix + [name],
            "func": func,
            "doc": (func.__doc__ or "").strip(),
            "stream_mode": _detect_stream_mode(func),
            "params": _extract_params(func),
        })

    return commands


def _extract_params(func) -> list[dict]:
    """提取函数参数列表（跳过注入的 request/response）。"""
    sig = inspect.signature(func)
    params = []
    try:
        hints = get_type_hints(func)
    except Exception:
        hints = {}

    for pname, param in sig.parameters.items():
        if pname in INJECTED_PARAMS:
            continue
        if pname == "return":
            continue
        typ = hints.get(pname, str)
        default = param.default if param.default is not inspect.Parameter.empty else None
        has_default = param.default is not inspect.Parameter.empty

        params.append({
            "name": pname,
            "type": typ,
            "proto_type": _python_type_to_proto_type(typ),
            "has_default": has_default,
            "default": default,
        })

    return params


# ════════════════════════════════════════════════════════════
# Proto 生成器
# ════════════════════════════════════════════════════════════


def _camel_to_snake(name: str) -> str:
    """驼峰转蛇形（proto 字段命名用）。"""
    s1 = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", name)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s1).lower()


def _sanitize_identifier(name: str) -> str:
    """清理标识符，确保 proto 合法。"""
    name = re.sub(r"[^a-zA-Z0-9_]", "_", name)
    if name and name[0].isdigit():
        name = "n" + name
    return name or "unnamed"


def _method_name_from_cmd(cmd: dict) -> str:
    """命令名 → proto 方法名（PascalCase）。

    Cyclopts 命令名用连字符（task-list→TaskList），
    嵌套路径用下划线（ui_status→UiStatus）。
    """
    # 先用 _ 分割嵌套层，再用 - 分割单词
    parts = []
    for seg in cmd["full_name"].split("_"):
        for sub in seg.split("-"):
            parts.append(sub.capitalize())
    return "".join(parts)


def _message_name_from_cmd(method_name: str, suffix: str) -> str:
    """proto 消息名：方法名 + Request/Response"""
    return f"{method_name}{suffix}"


def generate_proto(app: App, package: str = "clirpc_gen") -> str:
    """从 Cyclopts App 生成 proto 文件内容。"""
    commands = _flatten_command_tree(app)

    lines = []
    lines.append('syntax = "proto3";')
    lines.append(f'package {package};')
    lines.append("")
    lines.append('import "google/protobuf/empty.proto";')
    lines.append("")

    # ── 服务定义 ──
    lines.append(f"// --- 从 Cyclopts App 自动生成 ---")
    lines.append(f"service CycloptsCommands {{")
    for cmd in commands:
        method = _method_name_from_cmd(cmd)
        req_msg = _message_name_from_cmd(method, "Request")
        resp_msg = _message_name_from_cmd(method, "Response")

        doc = cmd["doc"].split("\n")[0] if cmd["doc"] else cmd["name"]
        lines.append(f"  // {doc}")
        lines.append(f"  // argv: {' '.join(cmd['argv'])}")

        mode = cmd["stream_mode"]
        if mode == "unary":
            lines.append(f"  rpc {method}({req_msg}) returns ({resp_msg});")
        elif mode == "serverStream":
            lines.append(
                f"  rpc {method}({req_msg}) returns (stream {resp_msg});"
            )
        elif mode == "clientStream":
            lines.append(
                f"  rpc {method}(stream {req_msg}) returns ({resp_msg});"
            )
        elif mode == "duplexStream":
            lines.append(
                f"  rpc {method}(stream {req_msg}) returns (stream {resp_msg});"
            )
        lines.append("")
    lines.append("}")

    # ── 消息定义 ──
    for cmd in commands:
        method = _method_name_from_cmd(cmd)
        req_msg = _message_name_from_cmd(method, "Request")
        resp_msg = _message_name_from_cmd(method, "Response")

        # Request
        lines.append(f"// --- {cmd['full_name']} ---")
        needs_stdin = cmd["stream_mode"] in ("clientStream", "duplexStream")
        field_idx = 1
        lines.append(f"message {req_msg} {{")
        for p in cmd["params"]:
            comment = ""
            if p["has_default"]:
                comment = f"  // default={p['default']}"
            lines.append(
                f"  {p['proto_type']} {_camel_to_snake(p['name'])} = {field_idx};{comment}"
            )
            field_idx += 1
        if needs_stdin:
            lines.append(f"  bytes stdin = {field_idx};")
            field_idx += 1
            lines.append(f"  bool eof = {field_idx};")
        lines.append("}")

        # Response
        is_single_output = cmd["stream_mode"] in ("unary", "clientStream")
        if is_single_output:
            lines.append(f"message {resp_msg} {{")
            lines.append(f"  int32 exit_code = 1;")
            lines.append(f"  string stdout = 2;")
            lines.append(f"  string stderr = 3;")
            lines.append(f"}}")
        else:
            # Stream 模式：帧格式
            lines.append(f"message {resp_msg} {{")
            lines.append(f"  int32 channel = 1;  // 1=stdout, 2=stderr")
            lines.append(f"  string data = 2;")
            lines.append(f"  int32 exit_code = 3;  // 尾帧 exit code")
            lines.append(f"}}")
        lines.append("")

    return "\n".join(lines)


# ════════════════════════════════════════════════════════════
# Python 客户端桩生成器
# ════════════════════════════════════════════════════════════


def _type_to_python_annotation(proto_type: str) -> str:
    """proto 类型 → Python 类型注解。"""
    if proto_type.startswith("repeated "):
        inner = proto_type[len("repeated "):]
        return f"list[{_type_to_python_annotation(inner)}]"
    rev_map = {v: k for k, v in PROTO_TYPE_MAP.items()}
    py_type = rev_map.get(proto_type, str)
    return py_type.__name__


def _py_method_name(full_name: str) -> str:
    """full_name → Python 合法方法名（下划线分隔）。

    例: task-list → task_list, ui_status → ui_status
    """
    return full_name.replace("-", "_")


def generate_python_client(commands: list[dict]) -> str:
    """生成 Python 类型安全客户端代码。"""
    lines = []
    lines.append('"""')
    lines.append('自动生成的 CycloptsCommands 类型安全客户端')
    lines.append('')
    lines.append('用法:')
    lines.append('    client = CycloptsClient(address, transport="connect")')
    lines.append('    async with client:')
    lines.append('        result = await client.task_list()')
    lines.append('        detail = await client.task_detail(uri="task/001")')
    lines.append('        async for frame in client.log_tail():')
    lines.append('            print(frame.data)')
    lines.append('"""')
    lines.append('')
    lines.append('from __future__ import annotations')
    lines.append('')
    lines.append('from dataclasses import dataclass, field')
    lines.append('from typing import AsyncIterator, Optional')
    lines.append('')
    lines.append('from cli_rpc import CliRpc, CliOutput')
    lines.append('')

    # ── 每个命令的请求/响应 dataclass ──
    for cmd in commands:
        method = _method_name_from_cmd(cmd)
        req_msg = _message_name_from_cmd(method, "Request")
        resp_msg = _message_name_from_cmd(method, "Response")

        # Request
        if cmd["params"]:
            lines.append("@dataclass")
            lines.append(f"class {req_msg}:")
            for p in cmd["params"]:
                py_type = _type_to_python_annotation(p["proto_type"])
                if p["has_default"]:
                    default_repr = repr(p["default"])
                    lines.append(f"    {_camel_to_snake(p['name'])}: {py_type} = {default_repr}")
                else:
                    lines.append(f"    {_camel_to_snake(p['name'])}: {py_type}")
            lines.append("")
        else:
            lines.append(f"class {req_msg}:")
            lines.append("    pass")
            lines.append("")

        # Response
        mode = cmd["stream_mode"]
        is_single_output = mode in ("unary", "clientStream")
        if is_single_output:
            lines.append("@dataclass")
            lines.append(f"class {resp_msg}:")
            lines.append(f"    exit_code: int = 0")
            lines.append(f"    stdout: str = \"\"")
            lines.append(f"    stderr: str = \"\"")
            lines.append("")
        else:
            lines.append("@dataclass")
            lines.append(f"class {resp_msg}:")
            lines.append(f"    channel: int = 0")
            lines.append(f"    data: str = \"\"")
            lines.append(f"    exit_code: int = 0")
            lines.append("")

    # ── 客户端类 ──
    lines.append("")
    lines.append("class CycloptsClient:")
    lines.append('    """类型安全的 Cyclopts 命令客户端。"""')
    lines.append("")
    lines.append("    def __init__(self, address: str, transport: str = \"connect\"):")
    lines.append("        self._cli = CliRpc.create(address, transport=transport)")
    lines.append("")
    lines.append("    async def __aenter__(self):")
    lines.append("        await self._cli.__aenter__()")
    lines.append("        return self")
    lines.append("")
    lines.append("    async def __aexit__(self, *args):")
    lines.append("        await self._cli.__aexit__(*args)")
    lines.append("")

    for cmd in commands:
        method = _method_name_from_cmd(cmd)
        py_method = _py_method_name(cmd["full_name"])
        req_msg = _message_name_from_cmd(method, "Request")
        resp_msg = _message_name_from_cmd(method, "Response")
        mode = cmd["stream_mode"]
        argv_repr = "[" + ", ".join(f'"{a}"' for a in cmd["argv"]) + "]"

        # 参数列表
        if cmd["params"]:
            param_str = ", ".join(
                f"{_camel_to_snake(p['name'])}: {_type_to_python_annotation(p['proto_type'])}"
                for p in cmd["params"]
            )
        else:
            param_str = ""

        is_single_output = mode in ("unary", "clientStream")

        if mode == "unary":
            lines.append(f"    async def {py_method}(self{', ' + param_str if param_str else ''}) -> {resp_msg}:")
            lines.append(f'        """{cmd["doc"].split(chr(10))[0] if cmd["doc"] else cmd["name"]}"""')
            lines.append(f"        argv = {argv_repr}")
            if cmd["params"]:
                for p in cmd["params"]:
                    lines.append(f"        argv.append(str({_camel_to_snake(p['name'])}))")
            lines.append(f"        raw = await self._cli.unary(*argv)")
            lines.append(f"        return {resp_msg}(")
            lines.append(f"            exit_code=raw.exit_code,")
            lines.append(f"            stdout=raw.stdout.decode(),")
            lines.append(f"            stderr=raw.stderr.decode(),")
            lines.append(f"        )")
            lines.append("")
        elif mode == "serverStream":
            lines.append(f"    async def {py_method}(self{', ' + param_str if param_str else ''}) -> AsyncIterator[{resp_msg}]:")
            lines.append(f'        """{cmd["doc"].split(chr(10))[0] if cmd["doc"] else cmd["name"]}"""')
            lines.append(f"        stream = self._cli.stream(*{argv_repr})")
            lines.append(f"        async for frame in stream:")
            lines.append(f"            yield {resp_msg}(")
            lines.append(f"                channel=frame.channel,")
            lines.append(f"                data=frame.text,")
            lines.append(f"                exit_code=stream.exit_code or 0,")
            lines.append(f"            )")
            lines.append("")
        elif mode == "clientStream":
            lines.append(f"    async def {py_method}(self, stdin: AsyncIterator[bytes]{', ' + param_str if param_str else ''}) -> {resp_msg}:")
            lines.append(f'        """{cmd["doc"].split(chr(10))[0] if cmd["doc"] else cmd["name"]}"""')
            lines.append(f"        stream = self._cli.stream(*{argv_repr}, stdin=stdin)")
            lines.append(f"        frames = []")
            lines.append(f"        async for frame in stream:")
            lines.append(f"            frames.append(frame)")
            lines.append(f"        return {resp_msg}(")
            lines.append(f"            exit_code=stream.exit_code,")
            lines.append(f"            stdout=''.join(f.text for f in frames if not f.is_stderr),")
            lines.append(f"            stderr=''.join(f.text for f in frames if f.is_stderr),")
            lines.append(f"        )")
            lines.append("")
        elif mode == "duplexStream":
            lines.append(f"    async def {py_method}(self, stdin: AsyncIterator[bytes]{', ' + param_str if param_str else ''}) -> AsyncIterator[{resp_msg}]:")
            lines.append(f'        """{cmd["doc"].split(chr(10))[0] if cmd["doc"] else cmd["name"]}"""')
            lines.append(f"        stream = self._cli.stream(*{argv_repr}, stdin=stdin)")
            lines.append(f"        async for frame in stream:")
            lines.append(f"            yield {resp_msg}(")
            lines.append(f"                channel=frame.channel,")
            lines.append(f"                data=frame.text,")
            lines.append(f"                exit_code=stream.exit_code or 0,")
            lines.append(f"            )")
            lines.append("")

    return "\n".join(lines)


# ════════════════════════════════════════════════════════════
# 类型安全 Servicer 生成器
# ════════════════════════════════════════════════════════════


def _rpc_method_name(cmd: dict) -> str:
    """Proto 方法名（PascalCase），用于 URL 路径和 handler 方法名"""
    return _method_name_from_cmd(cmd)


def generate_typed_server(commands: list[dict], port: int = 8322) -> str:
    """生成类型安全 Servicer — Starlette ASGI app，每个命令一个路由。

    生成的模块可直接被 uvicorn 使用:
        uvicorn gen.cli_rpc_gen_server:app
    """
    lines = []
    lines.append('"""')
    lines.append('自动生成的类型安全 Cyclopts RPC Servicer')
    lines.append('')
    lines.append('用法:')
    lines.append(f'    uvicorn gen.cli_rpc_gen_server:app')
    lines.append('"""')
    lines.append('')
    lines.append('from __future__ import annotations')
    lines.append('')
    lines.append('import asyncio')
    lines.append('import json')
    lines.append('')
    lines.append('from starlette.applications import Starlette')
    lines.append('from starlette.requests import Request as StarletteRequest')
    lines.append('from starlette.responses import JSONResponse, PlainTextResponse')
    lines.append('from starlette.routing import Route')
    lines.append('')
    lines.append('from cli_rpc.cli.cyclopts._dispatch import CycloptsDispatch')
    lines.append('from cli_rpc.core._drain import _make_request_response, _drain_response_text')
    lines.append('')
    lines.append('')
    lines.append('class CycloptsServicer:')
    lines.append('    """类型安全 RPC Servicer — 每个 Cyclopts 命令一个 typed handler。"""')
    lines.append('')
    lines.append('    def __init__(self, dispatch: CycloptsDispatch):')
    lines.append('        self._dispatch = dispatch')
    lines.append('')
    lines.append('    def create_app(self) -> Starlette:')
    lines.append('        """创建 Starlette ASGI app。"""')
    lines.append('        routes = [')

    # URL 路由表
    for cmd in commands:
        method = _rpc_method_name(cmd)
        handler = f"self.handle_{method}"
        lines.append(f'            Route("/rpc/{method}", {handler}, methods=["POST"]),')
    lines.append('            Route("/healthz", lambda _: PlainTextResponse("OK")),')
    lines.append('        ]')
    lines.append('        return Starlette(routes=routes)')
    lines.append('')

    # 每个命令一个 handler
    for cmd in commands:
        method = _rpc_method_name(cmd)
        mode = cmd["stream_mode"]
        argv_parts = ', '.join(f'"{a}"' for a in cmd["argv"])
        doc_first = cmd["doc"].split("\n")[0] if cmd["doc"] else cmd["name"]

        # handler 注释
        lines.append(f'    # {doc_first}')
        lines.append(f'    # argv: {" ".join(cmd["argv"])}')

        if mode == "unary":
            lines.append(f'    async def handle_{method}(self, request: StarletteRequest) -> JSONResponse:')
            lines.append(f'        """{doc_first}"""')
            lines.append(f'        argv = [{argv_parts}]')
            # 从 JSON body 解析参数追加到 argv
            if cmd["params"]:
                lines.append(f'        body = await request.json()')
                for p in cmd["params"]:
                    snake = _camel_to_snake(p["name"])
                    lines.append(f'        if "{snake}" in body:')
                    lines.append(f'            argv.append(str(body["{snake}"]))')
            lines.append(f'        stdin_q = asyncio.Queue()')
            lines.append(f'        stdin_q.put_nowait(None)  # EOF')
            lines.append(f'        req, resp = _make_request_response(argv, dict(request.headers), stdin_q)')
            lines.append(f'        await self._dispatch.execute(argv, req, resp)')
            lines.append(f'        out_text, err_text = _drain_response_text(resp)')
            lines.append(f'        return JSONResponse({{"exit_code": resp.exit_code, "stdout": out_text, "stderr": err_text}})')
            lines.append('')

        elif mode == "serverStream":
            lines.append(f'    async def handle_{method}(self, request: StarletteRequest):')
            lines.append(f'        """{doc_first} (NDJSON stream)"""')
            lines.append(f'        argv = [{argv_parts}]')
            if cmd["params"]:
                lines.append(f'        body = await request.json()')
                for p in cmd["params"]:
                    snake = _camel_to_snake(p["name"])
                    lines.append(f'        if "{snake}" in body:')
                    lines.append(f'            argv.append(str(body["{snake}"]))')
            lines.append('')
            lines.append('        async def event_stream():')
            lines.append(f'            stdin_q = asyncio.Queue()')
            lines.append(f'            stdin_q.put_nowait(None)')
            lines.append(f'            req, resp = _make_request_response(argv, dict(request.headers), stdin_q)')
            lines.append(f'            await self._dispatch.execute(argv, req, resp)')
            lines.append(f'            from cli_rpc.core._drain import _drain_response_frames')
            lines.append(f'            async for frame in _drain_response_frames(resp):')
            lines.append(f'                yield json.dumps({{"channel": frame.channel, "data": frame.data.decode("utf-8", errors="replace")}}) + "\\n"')
            lines.append(f'            yield json.dumps({{"exit_code": resp.exit_code}}) + "\\n"')
            lines.append('')
            lines.append('        from starlette.responses import StreamingResponse')
            lines.append('        return StreamingResponse(event_stream(), media_type="application/x-ndjson")')
            lines.append('')

        elif mode == "clientStream":
            lines.append(f'    async def handle_{method}(self, request: StarletteRequest) -> JSONResponse:')
            lines.append(f'        """{doc_first} (client sends stdin in JSON body)"""')
            lines.append(f'        argv = [{argv_parts}]')
            lines.append(f'        body = await request.json()')
            lines.append(f'        stdin_text = body.get("stdin", "")')
            lines.append(f'        stdin_q = asyncio.Queue()')
            lines.append(f'        if stdin_text:')
            lines.append(f'            stdin_q.put_nowait(stdin_text.encode())')
            lines.append(f'        stdin_q.put_nowait(None)  # EOF')
            lines.append(f'        req, resp = _make_request_response(argv, dict(request.headers), stdin_q)')
            lines.append(f'        await self._dispatch.execute(argv, req, resp)')
            lines.append(f'        out_text, err_text = _drain_response_text(resp)')
            lines.append(f'        return JSONResponse({{"exit_code": resp.exit_code, "stdout": out_text, "stderr": err_text}})')
            lines.append('')

        elif mode == "duplexStream":
            lines.append(f'    async def handle_{method}(self, request: StarletteRequest):')
            lines.append(f'        """{doc_first} (NDJSON duplex stream)"""')
            lines.append(f'        argv = [{argv_parts}]')
            lines.append(f'        body = await request.json()')
            lines.append(f'        stdin_text = body.get("stdin", "")')
            lines.append('')
            lines.append('        async def event_stream():')
            lines.append(f'            stdin_q = asyncio.Queue()')
            lines.append(f'            if stdin_text:')
            lines.append(f'                stdin_q.put_nowait(stdin_text.encode())')
            lines.append(f'            stdin_q.put_nowait(None)')
            lines.append(f'            req, resp = _make_request_response(argv, dict(request.headers), stdin_q)')
            lines.append(f'            await self._dispatch.execute(argv, req, resp)')
            lines.append(f'            from cli_rpc.core._drain import _drain_response_frames')
            lines.append(f'            async for frame in _drain_response_frames(resp):')
            lines.append(f'                yield json.dumps({{"channel": frame.channel, "data": frame.data.decode("utf-8", errors="replace")}}) + "\\n"')
            lines.append(f'            yield json.dumps({{"exit_code": resp.exit_code}}) + "\\n"')
            lines.append('')
            lines.append('        from starlette.responses import StreamingResponse')
            lines.append('        return StreamingResponse(event_stream(), media_type="application/x-ndjson")')
            lines.append('')

    # ── 工厂函数 ──
    lines.append('# ════════════════════════════════════════════════════════════')
    lines.append('# 工厂函数 — 方便 uvicorn / 测试直接使用')
    lines.append('# ════════════════════════════════════════════════════════════')
    lines.append('')
    lines.append('')
    lines.append('def create_app(dispatch=None) -> Starlette:')
    lines.append('    """创建类型安全 RPC app。dispatch 为 None 时自动从 demo.commands 创建。"""')
    lines.append('    if dispatch is None:')
    lines.append('        from demo.commands import diy')
    lines.append('        dispatch = CycloptsDispatch(diy)')
    lines.append('    return CycloptsServicer(dispatch).create_app()')
    lines.append('')
    lines.append('')
    lines.append('# 默认 ASGI app（uvicorn 直接使用）')
    lines.append('app = create_app()')
    lines.append('')
    lines.append('')
    lines.append('def main():')
    lines.append('    """启动 uvicorn 服务端。"""')
    lines.append('    import uvicorn')
    lines.append(f'    uvicorn.run(app, host="127.0.0.1", port={port}, log_level="info")')
    lines.append('')
    lines.append('')
    lines.append('if __name__ == "__main__":')
    lines.append('    main()')

    return "\n".join(lines)


# ════════════════════════════════════════════════════════════
# 主入口
# ════════════════════════════════════════════════════════════


def main():
    parser = argparse.ArgumentParser(description="Cyclopts → proto 代码生成器")
    parser.add_argument("--gen-py", action="store_true", help="生成 Python 客户端桩")
    parser.add_argument("--gen-server", action="store_true", help="生成 Python 类型安全 Servicer")
    parser.add_argument("--out-dir", default="demo/gen", help="输出目录")
    args = parser.parse_args()

    from demo.commands import diy

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # ── 生成 proto ──
    proto_content = generate_proto(diy)
    proto_path = out_dir / "cli_rpc_gen.proto"
    proto_path.write_text(proto_content)
    print(f"✓ proto: {proto_path}")
    print()

    # ── 解析命令树用于后续生成 ──
    commands = _flatten_command_tree(diy)

    print("=== 命令表 ===")
    for cmd in commands:
        mode = cmd["stream_mode"]
        params = ", ".join(f"{p['name']}: {p['proto_type']}" for p in cmd["params"])
        doc_first = cmd["doc"].split("\n")[0] if cmd["doc"] else "(无文档)"
        print(f"  {mode:15s}  {' '.join(cmd['argv']):25s}  ({params})  {doc_first}")
    print()

    if args.gen_py:
        py_content = generate_python_client(commands)
        py_path = out_dir / "cli_rpc_gen_client.py"
        py_path.write_text(py_content)
        print(f"✓ Python client: {py_path}")

    if args.gen_server:
        svc_content = generate_typed_server(commands)
        svc_path = out_dir / "cli_rpc_gen_server.py"
        svc_path.write_text(svc_content)
        print(f"✓ typed server: {svc_path}")


if __name__ == "__main__":
    main()
