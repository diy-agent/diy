"""验证器 — FieldError + ValidationError + Schema 定义。"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class FieldError:
    """单个字段错误。

    field: 字段名
    code:  错误码（not_found, too_long, required, read_error 等）
    msg:   人类可读消息
    """

    field: str
    code: str
    msg: str


class ValidationError(Exception):
    """Core 验证失败。收集全部输入错误，一次性抛出。"""

    def __init__(self, errors: list[FieldError]):
        self.errors = errors
        super().__init__("; ".join(e.msg for e in errors))

    def to_json(self) -> str:
        import json

        return json.dumps(
            {
                "status": "error",
                "errors": [
                    {"field": e.field, "code": e.code, "msg": e.msg}
                    for e in self.errors
                ],
            }
        )

    def to_text(self) -> str:
        """多行文本，CLI 直接打印。"""
        return "\n".join(f"  {e.field}: {e.code} — {e.msg}" for e in self.errors)
