"""测试 diyui Panel wrapper 与原生 Panel 参数一致性与透传正确性。

强类型化完成后，应去掉 wrapper 的 **kwargs。
此测试断言所有 Panel 参数都有显式定义或已声明排除，
且每个显式参数都能正确透传到 Panel 原生对象。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# tools/ 不在 installed package 中，手动加到 path
_tools_dir = Path(__file__).resolve().parent.parent.parent / "tools"
sys.path.insert(0, str(_tools_dir))

from doctor_panel import (  # noqa: E402
    _COMMON_EXCLUDED,
    _SUBPACKAGE_WRAPPERS,
    _WRAPPER_EXCLUDED,
    _WRAPPER_MAP,
    _WRAPPER_SPECS,
    _run_namespace_checks,
    run_checks,
    run_verify,
)


def _get_wrapper_cls(name: str) -> type:
    """按 wrapper 名查找类，断言一定存在（测试数据来自 run_checks 内部）。"""
    for cls in _WRAPPER_MAP:
        if cls.__name__ == name:
            return cls
    raise KeyError(f"未注册的 wrapper: {name}")


# ═══════════════════════════════════════════════════════════════
# 参数覆盖率测试（强类型化完整性）
# ═══════════════════════════════════════════════════════════════


class TestPanelParamCoverage:
    """验证每个 Panel wrapper 的参数覆盖率。"""

    def test_no_missing_params(self) -> None:
        """所有 Panel 参数要么显式定义，要么在排除列表中。"""
        checks = run_checks()
        missing = 0
        for c in checks:
            excluded = _COMMON_EXCLUDED | _WRAPPER_EXCLUDED.get(
                _get_wrapper_cls(c.wrapper_name), set()
            )
            for pp in c.panel_params:
                if pp.name in excluded:
                    continue
                if pp.name not in c.wrapper_params:
                    missing += 1
        assert missing == 0, (
            f"{missing} 个 Panel 参数缺少显式定义。\n"
            "运行 `uv run python tools/doctor_panel.py doctor` 查看详情。"
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
                if pp.name not in excluded and pp.name not in c.wrapper_params
            ]
            if local_missing:
                failures.append(f"{c.wrapper_name}: {local_missing}")
        assert not failures, "以下 wrapper 缺少 Panel 参数显式定义:\n" + "\n".join(
            failures
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
        if warnings:
            pytest.fail("排除参数不应出现在 wrapper 签名中:\n" + "\n".join(warnings))


# ═══════════════════════════════════════════════════════════════
# 参数透传测试（运行时验证）
# ═══════════════════════════════════════════════════════════════


class TestPanelParamPassThrough:
    """验证每个 wrapper 显式声明的参数都能正确透传到 Panel 原生对象。"""

    def test_all_params_pass_through(self) -> None:
        """所有可验证的参数必须正确透传。"""
        results = run_verify()
        failures: list[str] = []
        for r in results:
            for c in r.failures:
                failures.append(
                    f"{r.wrapper_name}.{c.param_name} → {c.target_attr}: {c.error}"
                )
        assert not failures, (
            f"{len(failures)} 个参数透传失败:\n"
            + "\n".join(failures)
            + "\n运行 `uv run python tools/doctor_panel.py verify` 查看详情。"
        )

    def test_verify_coverage_ratio(self) -> None:
        """透传验证覆盖率应 >= 60%，避免大量参数被跳过导致验证形同虚设。"""


# ═══════════════════════════════════════════════════════════════
# 包命名空间一致性测试
# ═══════════════════════════════════════════════════════════════


class TestNamespaceConvention:
    """验证 diypn 子包命名空间与 Panel 原生路径一致。"""

    def test_each_wrapper_in_expected_subpkg(self) -> None:
        """每个 wrapper 类必须在其对应的 diypn 子包下可访问。"""
        import diyui.providers.panel as diypn

        failures: list[str] = []
        for sp_name, wrappers in _SUBPACKAGE_WRAPPERS.items():
            sp = getattr(diypn, sp_name, None)
            if sp is None:
                failures.append(f"diypn.{sp_name} 子包不存在")
                continue
            for w in wrappers:
                if getattr(sp, w.__name__, None) is None:
                    failures.append(f"diypn.{sp_name}.{w.__name__} 无法访问")
        assert not failures, "命名空间不一致:\n" + "\n".join(failures)

    def test_no_extra_exports_in_subpkgs(self) -> None:
        """diypn 子包不应有多余的公开类（不在 _WRAPPER_SPECS 中）。"""
        results = _run_namespace_checks()
        for r in results:
            assert not r.extra, (
                f"diypn.{r.subpkg} 有多余公开类: {r.extra}\n"
                "请确保 _WRAPPER_SPECS 覆盖所有导出类"
            )

    def test_class_names_match_panel_original(self) -> None:
        """wrapper 类名应与 Panel 原生类名一致（去掉 Panel 前缀）。"""

        failures: list[str] = []
        for wrapper_cls, panel_cls, _ in _WRAPPER_SPECS:
            if wrapper_cls.__name__ != panel_cls.__name__:
                failures.append(
                    f"{wrapper_cls.__name__} → Panel 原生类名为 {panel_cls.__name__}"
                )
        assert not failures, (
            "类名不一致，wrapper 类名应与 Panel 原生一致:\n" + "\n".join(failures)
        )

    def test_verify_coverage_ratio(self) -> None:
        results = run_verify()
        total_params = 0
        verified_params = 0
        for r in results:
            total_params += len(r.checks) + len(r.skipped)
            verified_params += len(r.checks)
        if total_params == 0:
            pytest.skip("无可验证的参数")
        ratio = verified_params / total_params
        assert ratio >= 0.6, (
            f"透传验证覆盖率仅 {ratio:.0%}（{verified_params}/{total_params}），"
            "大量参数被跳过，请改进 _generate_test_value。"
        )
