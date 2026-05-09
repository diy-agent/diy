"""测试 xxui Panel wrapper 与原生 Panel 参数一致性。

强类型化完成后，应去掉 wrapper 的 **kwargs。
此测试将断言所有 Panel 参数都有显式定义或已声明排除。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# tools/ 不在 installed package 中，手动加到 path
_tools_dir = Path(__file__).resolve().parent.parent / "tools"
sys.path.insert(0, str(_tools_dir))

from check_panel_params import _COMMON_EXCLUDED, _WRAPPER_EXCLUDED, run_checks


def _count_missing() -> int:
    """统计所有 wrapper 中缺少显式参数且无 **kwargs 兜底的参数数。"""
    checks = run_checks()
    total = 0
    for c in checks:
        excluded = _COMMON_EXCLUDED | _WRAPPER_EXCLUDED.get(
            _get_wrapper_cls(c.wrapper_name), set()
        )
        for pp in c.panel_params:
            if pp.name in excluded:
                continue
            if pp.name not in c.wrapper_params and not c.has_kwargs:
                total += 1
    return total


def _get_wrapper_cls(name: str) -> type | None:
    from check_panel_params import _WRAPPER_MAP

    for cls in _WRAPPER_MAP:
        if cls.__name__ == name:
            return cls
    return None


class TestPanelParamCoverage:
    """验证每个 Panel wrapper 的参数覆盖率。

    当 wrapper 去掉 **kwargs 并显式声明所有参数后，
    此测试确保没有遗漏。
    """

    def test_no_missing_params(self) -> None:
        """所有 Panel 参数要么显式定义，要么在排除列表中，要么由 **kwargs 兜底。"""
        missing = _count_missing()
        assert missing == 0, (
            f"{missing} 个 Panel 参数缺少显式定义且无 **kwargs 兜底。\n"
            "运行 `uv run python tools/check_panel_params.py` 查看详情。"
        )

    def test_each_wrapper_reports_zero_missing(self) -> None:
        """逐个检查每个 wrapper 是否有缺失参数。"""
        checks = run_checks()
        failures: list[str] = []
        for c in checks:
            excluded = _COMMON_EXCLUDED | _WRAPPER_EXCLUDED.get(
                _get_wrapper_cls(c.wrapper_name), set()
            )
            local_missing = [
                pp.name
                for pp in c.panel_params
                if pp.name not in excluded
                and pp.name not in c.wrapper_params
                and not c.has_kwargs
            ]
            if local_missing:
                failures.append(f"{c.wrapper_name}: {local_missing}")
        assert not failures, (
            "以下 wrapper 缺少 Panel 参数显式定义:\n" + "\n".join(failures)
        )

    def test_excluded_params_not_in_wrapper_signatures(self) -> None:
        """确保被排除的参数确实不在 wrapper 的显式签名中（避免死代码）。"""
        checks = run_checks()
        warnings: list[str] = []
        for c in checks:
            excluded = _COMMON_EXCLUDED | _WRAPPER_EXCLUDED.get(
                _get_wrapper_cls(c.wrapper_name), set()
            )
            for name in excluded:
                if name in c.wrapper_params:
                    warnings.append(
                        f"{c.wrapper_name}.{name}: 在排除列表但签名中有显式定义"
                    )
        # 这是 warning 级别，不阻塞 CI
        if warnings:
            pytest.fail(
                "排除参数不应出现在 wrapper 签名中:\n" + "\n".join(warnings)
            )
