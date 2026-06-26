"""diy Core — 中间件：前端壳的公共包装器。

三个前端壳各一个函数，由 dispatch/按钮事件/command handler 调用。
异常只在这里捕获、格式化，前端壳 handler 里零 try/except。
"""

from __future__ import annotations

import io as _io
import json
import sys

import yaml

from .validator import ValidationError


def cli_call(fn, *args, json_output: bool = False, **kwargs) -> None:
    """CLI 命令公共包装器。

    成功: YAML 或 JSON 到 stdout
    失败: 格式化到 stderr，sys.exit(1)
    """
    try:
        result = fn(*args, **kwargs)
        out = {"status": "success", "data": result}
        if json_output:
            json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
            sys.stdout.write("\n")
        else:
            yaml.dump(
                out,
                sys.stdout,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )
    except ValidationError as e:
        out = {
            "status": "error",
            "errors": [
                {"field": e.field, "code": e.code, "msg": e.msg} for e in e.errors
            ],
        }
        if json_output:
            json.dump(out, sys.stderr, indent=2, ensure_ascii=False)
            sys.stderr.write("\n")
        else:
            print(e.to_text(), file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        print(f"错误: {e}", file=sys.stderr)
        sys.exit(1)


def gateway_call(fn, *args, **kwargs) -> str:
    """Gateway handler 公共包装器（同进程）。

    返回 YAML 字符串（成功）或 JSON 错误串（失败）。
    客户端（CLI）自己处理展示。
    """
    try:
        result = fn(*args, **kwargs)
        buf = _io.StringIO()
        yaml.dump(
            {"status": "ok", "data": result},
            buf,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )
        return buf.getvalue()
    except ValidationError as e:
        return e.to_json()
    except ValueError as e:
        return json.dumps({"status": "error", "msg": str(e)})
