"""assert_intent 引擎 — 意图测试断言核心。

匹配策略（优先级递减）：
  1. 整块嗅探 JSON → 结构比对（_json_contains，键序无关）
  2. 整块嗅探 YAML → 结构比对
  3. 逐行字符串匹配（支持 sentinel）

Sentinel：
  - {{*}}           → 匹配任意内容（行内 / 独占行）
  - {{regex:...}}   → 正则匹配

命令前缀 `!`（代替 `$`，避免 shell 变量混淆）。

用法：
    from _assert_intent import assert_intent

    assert_intent(\"\"\"
    ! ls
    文件1
    文件2
    \"\"\", cwd="/tmp")
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import uuid
from typing import Any


class IntentAssertionError(AssertionError):
    """自定义异常，防止 pytest 展开周边源码。"""

    pass


# ── Sentinel ──

_RE_ANY = re.compile(r"\{\{\*\}\}")
_RE_REGEX = re.compile(r"\{\{regex:(.*?)\}\}")
_RE_SENTINEL = re.compile(r"\{\{\*\}\}|" + _RE_REGEX.pattern)


def _sentinel_to_regex(pattern: str) -> str | None:
    """将 sentinel 模式转为正则。返回 None 表示纯文本匹配。"""
    if _RE_ANY.fullmatch(pattern.strip()):
        return r".*?"
    m = _RE_REGEX.fullmatch(pattern.strip())
    if m:
        return m.group(1)
    return None


def _line_matches(expect: str, actual: str) -> bool:
    """逐行匹配，支持 sentinel。"""
    if expect.strip() == "{{*}}":
        return True

    regex_parts: list[str] = []
    last = 0
    for m in _RE_SENTINEL.finditer(expect):
        regex_parts.append(re.escape(expect[last : m.start()]))
        if m.group(0) == "{{*}}":
            regex_parts.append(r".*?")
        else:
            regex_parts.append(m.group(1))
        last = m.end()
    regex_parts.append(re.escape(expect[last:]))

    pat = "^" + "".join(regex_parts) + "$"
    return bool(re.fullmatch(pat, actual))


# ── JSON / YAML 嗅探 ──


def _try_parse_json(text: str) -> Any | None:
    try:
        return json.loads(text)
    except Exception:
        return None


def _try_parse_yaml(text: str) -> Any | None:
    """尝试 YAML 解析。去掉 --- 前缀后试 parse。"""
    import yaml

    try:
        cleaned = text.strip()
        if cleaned.startswith("---"):
            cleaned = cleaned[3:].strip()
        data = yaml.safe_load(cleaned)
        return data if isinstance(data, (dict, list)) else None
    except Exception:
        return None


def _json_contains(expected: Any, actual: Any) -> bool:
    """递归结构包含匹配。expected 是约束集，actual 可有额外字段。

    - dict → 检查每个 expected key 在 actual 中存在且值匹配
    - list → 无序匹配，每个 expected 元素在 actual 中找到对应
    - str  → 支持 sentinel 匹配
    - 其他 → 精确比较
    """
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return False
        return all(
            k in actual and _json_contains(expected[k], actual[k]) for k in expected
        )
    if isinstance(expected, list):
        if not isinstance(actual, list):
            return False
        if not expected:
            return True
        remaining = list(actual)
        for ei in expected:
            for i, ai in enumerate(remaining):
                if _json_contains(ei, ai):
                    remaining.pop(i)
                    break
            else:
                return False
        return True
    # 标量：sentinel 或精确匹配
    if isinstance(expected, str):
        pat = _sentinel_to_regex(expected)
        if pat == r".*?":
            return True  # {{*}} 匹配任意标量
        if pat and isinstance(actual, str):
            return bool(re.fullmatch(pat, str(actual)))
        return expected == actual
    return expected == actual


# ── 执行 ──


def _run_blocks(
    blocks: list[tuple[str, list[str]]],
    cwd: str | None = None,
    env: dict[str, str] | None = None,
) -> None:
    full_env = os.environ.copy()
    if env:
        full_env.update(env)

    proc = subprocess.Popen(
        ["bash", "--norc"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=cwd,
        env=full_env,
    )
    assert proc.stdin and proc.stdout and proc.stderr

    try:
        for cmd, expected_lines in blocks:
            marker = f"__END_{uuid.uuid4().hex[:8]}__"
            proc.stdin.write(f"{cmd}\necho {marker} $?\n")
            proc.stdin.flush()

            out: list[str] = []
            exit_code = None
            for line in proc.stdout:
                if marker in line:
                    parts = line.strip().split()
                    if parts and parts[-1].isdigit():
                        exit_code = int(parts[-1])
                    break
                out.append(line.rstrip("\n"))

            actual = "\n".join(out).strip()
            if exit_code != 0:
                stderr = (
                    proc.stderr.read() if proc.poll() is not None else "(进程仍存活)"
                )
                raise IntentAssertionError(
                    f"! {cmd}\n退出码 {exit_code}\nstderr: {stderr}"
                )

            # 过滤注释和空行
            check = [
                ln
                for ln in expected_lines
                if ln.strip() and not ln.strip().startswith("#")
            ]
            if not check:
                continue

            joined = "\n".join(check).strip()

            # 1) 嗅探 JSON
            ej = _try_parse_json(joined)
            aj = _try_parse_json(actual)
            if ej is not None and aj is not None:
                ok = _json_contains(ej, aj)
                if not ok:
                    raise IntentAssertionError(
                        f"! {cmd}\n"
                        f"期望: {json.dumps(ej, ensure_ascii=False)}\n"
                        f"实际: {json.dumps(aj, ensure_ascii=False)}"
                    )
                continue

            # 2) 嗅探 YAML
            ey = _try_parse_yaml(joined)
            ay = _try_parse_yaml(actual)
            if ey is not None and ay is not None:
                ok = _json_contains(ey, ay)
                if not ok:
                    raise IntentAssertionError(
                        f"! {cmd}\n"
                        f"期望: {json.dumps(ey, ensure_ascii=False)}\n"
                        f"实际: {json.dumps(ay, ensure_ascii=False)}"
                    )
                continue

            # 3) 逐行字符串匹配
            actual_lines = actual.split("\n")
            ai = 0
            for el in check:
                s = el.strip()
                if not s:
                    continue
                if s == "{{*}}":
                    ai += 1
                    continue
                found = False
                cursor = ai
                first_candidate = (
                    actual_lines[ai] if ai < len(actual_lines) else "(无更多行)"
                )
                while cursor < len(actual_lines):
                    if _line_matches(el, actual_lines[cursor]):
                        found = True
                        ai = cursor + 1
                        break
                    cursor += 1
                if not found:
                    raise IntentAssertionError(
                        f"! {cmd}\n期望: {el}\n实际: {first_candidate!r}"
                    )
    finally:
        proc.stdin.close()
        proc.terminate()
        proc.wait(timeout=5)


def assert_intent(
    session: str,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
) -> None:
    """意图测试主入口。

    Args:
        session: 会话文本（! 命令 → 预期输出）
        cwd: 工作目录
        env: 额外环境变量
    """
    lines = session.split("\n")

    # 计算缩进基线（以第一个 ! 行为准）
    indent = 0
    for line in lines:
        s = line.lstrip()
        if s.startswith("!"):
            indent = len(line) - len(s)
            break

    dedented: list[str] = []
    for line in lines:
        if len(line) >= indent and line[:indent].strip() == "":
            dedented.append(line[indent:])
        else:
            dedented.append(line)

    blocks: list[tuple[str, list[str]]] = []
    i = 0
    while i < len(dedented):
        line = dedented[i]
        i += 1
        if not line.startswith("!"):
            continue
        cmd = line[1:]
        expected: list[str] = []
        while i < len(dedented) and not dedented[i].startswith("!"):
            expected.append(dedented[i])
            i += 1
        blocks.append((cmd, expected))

    if blocks:
        _run_blocks(blocks, cwd=cwd, env=env)
