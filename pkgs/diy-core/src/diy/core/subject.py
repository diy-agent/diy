"""diy Core — Subject 相关业务逻辑。

校验 + 业务操作收拢在此，前端壳只负责调此模块 + 展示结果。
"""

from __future__ import annotations

from diy.core._state import _norm, _subject_is_git, load_state, save_state

from .validator import FieldError, ValidationError


def add_subject(path: str, desc: str | None = None) -> dict:
    """注册 subject。

    返回: subject dict
    抛出: ValidationError — 已存在
    """
    path_n = _norm(path)
    state = load_state()
    subjects = state.setdefault("subjects", {})

    if path_n in subjects:
        raise ValidationError(
            [
                FieldError("path", "already_exists", f"subject {path_n!r} 已存在"),
            ]
        )

    entry: dict[str, str] = {}
    if desc:
        entry["description"] = desc
    subjects[path_n] = entry
    save_state(state)

    return {"path": path_n, **entry}


def remove_subject(path: str) -> dict:
    """删除 subject。

    返回: {"path": ...}
    抛出: ValidationError — 不存在
    """
    path_n = _norm(path)
    state = load_state()
    subjects = state.get("subjects", {})

    if path_n not in subjects:
        raise ValidationError(
            [
                FieldError("path", "not_found", f"subject {path_n!r} 不存在"),
            ]
        )

    # 检查是否有 task 引用此 subject
    from diy.core._state import list_tasks

    for uri, task in list_tasks().items():
        if task.get("subject") == path_n:
            raise ValueError(f"subject {path_n!r} 有任务引用 ({uri})")

    del subjects[path_n]
    save_state(state)

    # 清理空 subject 嵌套路径
    to_delete = [p for p in subjects if p == path_n or p.startswith(path_n + "/")]
    for p in to_delete:
        subjects.pop(p, None)
    save_state(state)

    return {"path": path_n}


def show_subject(path: str) -> dict:
    """查看单个 subject。

    返回: subject dict（含实时 is_git 检测）
    抛出: ValidationError — 不存在
    """
    path_n = _norm(path)
    state = load_state()
    subjects = state.get("subjects", {})

    if path_n not in subjects:
        raise ValidationError(
            [
                FieldError("path", "not_found", f"subject {path_n!r} 不存在"),
            ]
        )

    entry = dict(subjects[path_n])
    entry["is_git"] = _subject_is_git(path_n)
    return entry
