"""diy Core — 任务相关业务逻辑。

所有校验 + 后置操作收拢在此，前端壳只负责调此模块 + 展示结果。
"""

from __future__ import annotations

from pathlib import Path

from diy.core._state import _norm, get_task, load_state, star_task
from diy.core._state import create_task as _state_create

from .validator import FieldError, ValidationError


def create_task(
    title: str,
    subject: str,
    parent: str | None = None,
    detail: str | None = None,
    body_file: str | None = None,
    source_type: str = "local",
    source_uri: str | None = None,
) -> dict:
    """创建任务。校验 + 业务 + star + notify 全部在此。

    参数与 _state.create_task 一致，增加 body_file 读取。
    返回: 任务 dict（含 starred=True）
    抛出: ValidationError — 输入不合法（收集全部错误）
          ValueError      — 业务冲突（URI 已存在等）
    """

    # ════════════════════════════════════════
    # 1. 验证 — 收集全部错误，不短路
    # ════════════════════════════════════════
    errors: list[FieldError] = []
    subject_n = _norm(subject)
    state = load_state()

    if not title:
        errors.append(FieldError("title", "required", "标题不能为空"))
    elif len(title) > 200:
        errors.append(FieldError("title", "too_long", "标题不超过 200 字符"))

    if subject_n not in state.get("subjects", {}):
        errors.append(
            FieldError(
                "subject",
                "not_found",
                f"subject {subject_n!r} 未注册",
            )
        )

    if parent is not None and get_task(parent) is None:
        errors.append(
            FieldError(
                "parent",
                "not_found",
                f"parent {parent!r} 不存在",
            )
        )

    # body_file 读取
    body = ""
    if body_file:
        try:
            body = Path(body_file).read_text(encoding="utf-8")
        except OSError as exc:
            errors.append(
                FieldError(
                    "body_file",
                    "read_error",
                    f"无法读取 {body_file!r}: {exc}",
                )
            )

    if errors:
        raise ValidationError(errors)

    # ════════════════════════════════════════
    # 2. 业务执行
    # ════════════════════════════════════════
    uri = _state_create(
        title=title,
        subject=subject_n,
        parent=parent,
        detail=detail,
        source_type=source_type,
        source_uri=source_uri,
        body=body,
    )

    # ════════════════════════════════════════
    # 3. 后置操作
    # ════════════════════════════════════════
    star_task(uri)

    task = get_task(uri) or {}
    task["starred"] = True
    return task
