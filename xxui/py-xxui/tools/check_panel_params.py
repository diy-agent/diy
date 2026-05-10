"""检查 xxui Panel 包装器与原生 Panel 组件的参数一致性。

可作为独立诊断工具运行，也可被 pytest 导入用作 CI 断言。
首次运行会在强类型化前展示所有通过 **kwargs 透传的参数清单。

用法:
  uv run python tools/check_panel_params.py                   # 诊断模式，打印完整对比表
  uv run python tools/check_panel_params.py --ci              # CI 模式，缺失参数时报错退出
  uv run python tools/check_panel_params.py query Column      # 查询原生 Panel 类的参数签名
  uv run python tools/check_panel_params.py query Button      # 支持模糊匹配
  uv run python tools/check_panel_params.py query pn.widgets.TextInput  # 完整路径
  uv run python tools/check_panel_params.py list              # 列出所有可查询的 Panel 类名
  uv run python tools/check_panel_params.py methods Button    # 列出 Panel 类的公开方法签名
"""

from __future__ import annotations

import inspect
import sys
from dataclasses import dataclass, field
from typing import Annotated, Any, get_type_hints

import cyclopts
import panel as pn
import param

from xxui.providers.panel import (
    PanelButton,
    PanelCard,
    PanelColumn,
    PanelMarkdown,
    PanelRadioButtonGroup,
    PanelRow,
    PanelTextInput,
)

# ── param 类型 → Python 类型映射 ──────────────────────────────
_PARAM_TYPE_MAP: dict[type, type] = {
    param.String: str,
    param.Integer: int,
    param.Number: float,
    param.Boolean: bool,
    param.List: list,
    param.Dict: dict,
    param.Tuple: tuple,
    param.ClassSelector: type,
    param.Selector: object,
    param.Color: str,
    param.Date: str,
    param.Range: tuple,
    param.Path: str,
    param.Event: object,
}


# ── 数据类 ────────────────────────────────────────────────────


@dataclass
class PanelParam:
    """原生 Panel 参数描述。"""

    name: str
    default: Any
    py_type: str  # 推断的 Python 类型，如 "str | None"
    param_cls: str  # param 类的名字，如 "String"


@dataclass
class WrapperCheck:
    """单个 wrapper 的检查结果。"""

    wrapper_name: str
    panel_name: str
    panel_params: list[PanelParam] = field(default_factory=list)
    wrapper_params: dict[str, str] = field(default_factory=dict)
    has_kwargs: bool = False  # 是否有 **kwargs 兜底
    missing: list[str] = field(default_factory=list)  # 强类型化后缺失的参数


# ── Wrapper → Panel 映射 ──────────────────────────────────────

_WRAPPER_MAP: dict[type, type] = {
    PanelColumn: pn.Column,
    PanelRow: pn.Row,
    PanelCard: pn.Card,
    PanelMarkdown: pn.pane.Markdown,
    PanelButton: pn.widgets.Button,
    PanelTextInput: pn.widgets.TextInput,
    PanelRadioButtonGroup: pn.widgets.RadioButtonGroup,
}

# ── 排除参数 ──────────────────────────────────────────────────

# 所有 wrapper 公共排除（xxui 内部管理）
_COMMON_EXCLUDED: set[str] = {
    "objects",  # 容器 children，由 _PanelContainerMixin sync 管理
}

# 各 wrapper 特有排除
_WRAPPER_EXCLUDED: dict[type, set[str]] = {
    PanelTextInput: {
        # value 已改为显式参数，不再 pop
        "value_input",  # 内部中间态，不暴露
        "enter_pressed",  # 只读事件
    },
    PanelButton: {
        "clicks",  # 只读计数器
    },
}


# ── 核心函数 ──────────────────────────────────────────────────


def _infer_param_type(p: param.Parameter) -> str:
    """从 param.Parameter 推断 Python 类型字符串。"""
    # 遍历已知映射
    py_base = "Any"
    for param_cls, py_type in _PARAM_TYPE_MAP.items():
        if isinstance(p, param_cls):
            py_base = py_type.__name__
            break
    # 若有限定型（如 ClassSelector(class_=SomeClass)）
    cls_ = getattr(p, "class_", None)
    if cls_ is not None:
        if isinstance(cls_, tuple):
            names = [
                getattr(c, "__name__", str(c)) for c in cls_ if c is not type(None)
            ]
            py_base = " | ".join(names) if names else "Any"
        else:
            py_base = getattr(cls_, "__name__", str(cls_))

    if p.allow_None:
        return f"{py_base} | None"
    return py_base


def extract_panel_params(panel_cls: type) -> list[PanelParam]:
    """从 Panel 类提取所有参数定义。"""
    result: list[PanelParam] = []
    for name in panel_cls.param:
        if name == "name":
            continue
        p = panel_cls.param[name]
        result.append(
            PanelParam(
                name=name,
                default=p.default,
                py_type=_infer_param_type(p),
                param_cls=type(p).__name__,
            )
        )
    return result


def extract_wrapper_params(wrapper_cls: type) -> tuple[dict[str, str], bool]:
    """提取 wrapper __init__ 的显式参数和是否有 **kwargs。"""
    try:
        sig = inspect.signature(wrapper_cls.__init__)
    except (ValueError, TypeError):
        return {}, False

    has_kwargs = any(
        p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
    )

    try:
        hints = get_type_hints(wrapper_cls.__init__)
    except Exception:
        hints = {}

    explicit: dict[str, str] = {}
    for name, p in sig.parameters.items():
        if name in ("self", "args", "kwargs"):
            continue
        if p.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
            continue
        if name in hints:
            hint = hints[name]
            origin = getattr(hint, "__origin__", None)
            if origin is not None:
                # Union/Optional 等
                args = getattr(hint, "__args__", ())
                parts: list[str] = []
                for a in args:
                    if a is type(None):  # noqa: E721
                        parts.append("None")
                    else:
                        parts.append(getattr(a, "__name__", str(a)))
                explicit[name] = " | ".join(parts)
            else:
                explicit[name] = getattr(hint, "__name__", str(hint))
        else:
            explicit[name] = "Any"
    return explicit, has_kwargs


def check_wrapper(wrapper_cls: type, panel_cls: type) -> WrapperCheck:
    """对比 wrapper 与原生 Panel 的参数一致性。"""
    panel_params = extract_panel_params(panel_cls)
    wrapper_params, has_kwargs = extract_wrapper_params(wrapper_cls)
    excluded = _COMMON_EXCLUDED | _WRAPPER_EXCLUDED.get(wrapper_cls, set())

    missing: list[str] = []
    for pp in panel_params:
        if pp.name in excluded:
            continue
        if pp.name not in wrapper_params and not has_kwargs:
            missing.append(pp.name)

    return WrapperCheck(
        wrapper_name=wrapper_cls.__name__,
        panel_name=panel_cls.__name__,
        panel_params=panel_params,
        wrapper_params=wrapper_params,
        has_kwargs=has_kwargs,
        missing=missing,
    )


# ── 输出 ──────────────────────────────────────────────────────


def _print_report(checks: list[WrapperCheck]) -> int:
    """打印诊断报告。返回缺失参数总数（含 **kwargs 视为未强类型化的数量）。"""
    total_kwargs_params = 0
    total_strict_missing = 0

    for c in checks:
        excluded = _COMMON_EXCLUDED | _WRAPPER_EXCLUDED.get(
            _get_wrapper_cls(c.wrapper_name), set()
        )

        print(f"\n{'─' * 70}")
        print(f"  📦 {c.wrapper_name}  ←  panel {c.panel_name}")
        print(f"{'─' * 70}")

        if c.has_kwargs and not c.missing:
            print("  ⚠️  当前使用 **kwargs 透传，以下为强类型化目标清单:\n")

        # 表头
        print(f"  {'Param':<24} {'默认值':<22} {'Panel 类型':<18} 状态")
        print(f"  {'─' * 24} {'─' * 22} {'─' * 18} ─────")

        for pp in c.panel_params:
            default_str = repr(pp.default)
            if len(default_str) > 21:
                default_str = default_str[:18] + "…"

            if pp.name in excluded:
                status = "✓ 排除"
            elif pp.name in c.wrapper_params:
                status = f"✓ 已定义 :{c.wrapper_params[pp.name]}"
            elif c.has_kwargs:
                status = "⚠ **kwargs → 需强类型化"
                total_kwargs_params += 1
            else:
                status = "✗ 缺失!"
                total_strict_missing += 1

            print(f"  {pp.name:<24} {default_str:<22} {pp.py_type:<18} {status}")

        # 汇总
        panel_total = len(c.panel_params)
        excluded_count = sum(1 for pp in c.panel_params if pp.name in excluded)
        defined = sum(1 for pp in c.panel_params if pp.name in c.wrapper_params)
        kpass = (
            sum(
                1
                for pp in c.panel_params
                if pp.name not in excluded and pp.name not in c.wrapper_params
            )
            if c.has_kwargs
            else 0
        )
        print(
            f"\n  汇总: {panel_total} Panel 参数 → "
            f"{excluded_count} 排除, {defined} 已显式定义, "
            f"{kpass} 经 **kwargs 透传"
        )

    print(f"\n{'═' * 70}")
    print(
        f"  总计: {total_kwargs_params} 个参数待强类型化 "
        f"({total_strict_missing} 个缺失)"
    )
    print(f"{'═' * 70}")

    return total_strict_missing


def _get_wrapper_cls(name: str) -> type | None:
    for cls in _WRAPPER_MAP:
        if cls.__name__ == name:
            return cls
    return None


# ── 入口 ──────────────────────────────────────────────────────


def run_checks() -> list[WrapperCheck]:
    """运行所有检查，返回结果列表（供 pytest 调用）。"""
    return [
        check_wrapper(wrapper_cls, panel_cls)
        for wrapper_cls, panel_cls in _WRAPPER_MAP.items()
    ]


# ── query 模式 ────────────────────────────────────────────────


def _find_panel_class(name: str) -> type | None:
    """在 panel 模块中按名字模糊查找类。

    支持:
      - 类名: Column, Button
      - 模块.类名: widgets.Button, pane.Markdown
      - 完整限定: pn.widgets.Button
    """
    clean = name.removeprefix("pn.")

    # 精确匹配
    for cls in _WRAPPER_MAP.values():
        cls_full = f"{cls.__module__}.{cls.__qualname__}"
        cls_short = cls.__qualname__
        if clean in (cls_full, cls_short):
            return cls

    # 尝试在各子模块中查找
    candidates: dict[str, type] = {}
    for mod_name in ("", "widgets", "pane", "layout", "indicators"):
        mod = pn
        if mod_name:
            try:
                mod = getattr(pn, mod_name)
            except AttributeError:
                continue
        for attr in dir(mod):
            if attr.startswith("_"):
                continue
            obj = getattr(mod, attr)
            if not isinstance(obj, type):
                continue
            key_full = f"{obj.__module__}.{obj.__qualname__}"
            key_short = obj.__qualname__
            if mod_name:
                key_dotted = f"{mod_name}.{obj.__qualname__}"
                candidates[key_dotted] = obj
            candidates[key_short] = obj
            candidates[key_full] = obj

    return candidates.get(clean)


def _format_default(val: Any) -> str:
    """将默认值格式化为可复制粘贴的 Python 字面量。"""
    if val is None:
        return "None"
    if isinstance(val, bool):
        return str(val)
    if isinstance(val, str):
        return repr(val)
    if isinstance(val, (int, float)):
        return str(val)
    if isinstance(val, (list, tuple, dict, set)):
        return repr(val)
    if isinstance(val, type):
        return val.__name__
    # 兜底：repr 截断
    r = repr(val)
    if len(r) > 40:
        r = r[:37] + "…"
    return r


def _format_param_line(pp: PanelParam) -> str:
    """格式化为 `    name: type = default,`。"""
    default = _format_default(pp.default)
    return f"    {pp.name}: {pp.py_type} = {default},"


def _query_class(panel_cls: type, label: str) -> None:
    """查询 Panel 原生类的 __init__ 签名。"""
    params = extract_panel_params(panel_cls)

    # 判断是否有 *children 位置参数（容器类）
    try:
        sig = inspect.signature(panel_cls.__init__)
        has_vargs = any(
            p.kind == inspect.Parameter.VAR_POSITIONAL for p in sig.parameters.values()
        )
    except (ValueError, TypeError):
        has_vargs = False

    cls_path = f"{panel_cls.__module__}.{panel_cls.__qualname__}"
    print(f"\n# {cls_path}")
    print(f"# 共 {len(params)} 个 param 参数\n")
    print("def __init__(")
    print("    self,")
    if has_vargs:
        print("    *children: Any,")
    for pp in params:
        print(_format_param_line(pp))
    print(") -> None: ...")


def _query_mode(name: str) -> None:
    """--query 入口。"""
    cls = _find_panel_class(name)
    if cls is None:
        print(f"❌ 未找到 Panel 类: {name}")
        print("   可用 --list 列出所有可查询类")
        sys.exit(1)
    _query_class(cls, name)


def _list_mode() -> None:
    """--list 入口：列出所有可查询的 Panel 类名。"""
    print("\n已注册的 xxui wrapper → Panel 原生类:\n")
    for wrapper_cls, panel_cls in _WRAPPER_MAP.items():
        cls_path = f"{panel_cls.__module__}.{panel_cls.__qualname__}"
        print(f"  {wrapper_cls.__name__:<24} ←  {cls_path}")
    print("\n也可直接查询任意 panel 类名，如:")
    print("  uv run python tools/check_panel_params.py query -n Select")
    print("  uv run python tools/check_panel_params.py query -n widgets.IntSlider")


# ── methods 模式 ─────────────────────────────────────────────

# 要排除的方法名（param 内部、Python object 基类等）
_METHOD_EXCLUDE: set[str] = {
    # object 基类
    "__init__",
    "__new__",
    "__del__",
    "__repr__",
    "__str__",
    "__hash__",
    "__getattribute__",
    "__setattr__",
    "__delattr__",
    "__sizeof__",
    "__reduce__",
    "__reduce_ex__",
    "__getstate__",
    "__subclasshook__",
    "__init_subclass__",
    "__dir__",
    "__format__",
    "__eq__",
    "__ne__",
    "__lt__",
    "__le__",
    "__gt__",
    "__ge__",
    "__class__",
    "__doc__",
    "__module__",
    "__dict__",
    "__weakref__",
    "__slots__",
    "__abstractmethods__",
    # param 内部 (实例级)
    "_param_watchers",
    "_events",
    "_callbacks",
    "_link_deps",
    "_param_private",
}

# 方法名前缀排除
_METHOD_PREFIX_EXCLUDE: tuple[str, ...] = (
    "_",  # 所有私有方法
)


def _format_method_sig(method: Any, name: str) -> str | None:
    """格式化为可读的方法签名。返回 None 表示无法解析。"""
    try:
        sig = inspect.signature(method)
    except (ValueError, TypeError):
        return None

    try:
        hints = get_type_hints(method)
    except Exception:
        hints = {}

    parts: list[str] = []
    # 跳过 self/cls
    params = list(sig.parameters.items())
    if params and params[0][0] in ("self", "cls"):
        params = params[1:]

    for pname, p in params:
        annotation = ""
        if pname in hints:
            hint = hints[pname]
            origin = getattr(hint, "__origin__", None)
            if origin is not None:
                args = getattr(hint, "__args__", ())
                parts_types: list[str] = []
                for a in args:
                    if a is type(None):
                        parts_types.append("None")
                    else:
                        parts_types.append(getattr(a, "__name__", str(a)))
                annotation = " | ".join(parts_types)
            else:
                annotation = getattr(hint, "__name__", str(hint))
        elif p.annotation is not inspect.Parameter.empty:
            ann = p.annotation
            annotation = getattr(ann, "__name__", str(ann))

        param_str = f"{pname}: {annotation}" if annotation else pname

        if p.default is not inspect.Parameter.empty:
            param_str += f" = {_format_default(p.default)}"
        elif p.kind == inspect.Parameter.VAR_POSITIONAL:
            param_str = f"*{param_str}" if pname else "*"
        elif p.kind == inspect.Parameter.VAR_KEYWORD:
            param_str = f"**{param_str}" if pname else "**"
        parts.append(param_str)

    # 返回类型
    return_ann = ""
    if "return" in hints:
        hint = hints["return"]
        if hint is not type(None):
            return_ann = f" -> {getattr(hint, '__name__', str(hint))}"
    elif sig.return_annotation is not inspect.Signature.empty:
        ret = sig.return_annotation
        if ret is not type(None):
            return_ann = f" -> {getattr(ret, '__name__', str(ret))}"

    return f"def {name}({', '.join(parts)}){return_ann}: ..."


def _find_method_owner(panel_cls: type, name: str) -> str:
    """在 MRO 中找到方法真正定义的类名。"""
    for cls in panel_cls.__mro__:
        if cls is object:
            break
        # 检查类自己的 __dict__（不含继承），或 descriptor
        if name in cls.__dict__:
            return cls.__name__
    return "?"


def _query_methods(panel_cls: type, label: str) -> None:
    """列出 Panel 原生类的公开方法签名。"""
    cls_path = f"{panel_cls.__module__}.{panel_cls.__qualname__}"

    # 收集所有非排除的公开方法 → (name, owner, signature_line)
    methods_by_owner: dict[str, list[str]] = {}
    mro_order: dict[str, int] = {c.__name__: i for i, c in enumerate(panel_cls.__mro__)}

    for name in dir(panel_cls):
        if name in _METHOD_EXCLUDE:
            continue
        if name.startswith(_METHOD_PREFIX_EXCLUDE):
            continue
        owner = _find_method_owner(panel_cls, name)
        if owner == "?":
            continue
        try:
            attr = inspect.getattr_static(panel_cls, name)
        except AttributeError:
            continue
        if not callable(attr):
            continue
        line = _format_method_sig(attr, name)
        if line is None:
            line = f"{name}(...)"
        methods_by_owner.setdefault(owner, []).append(line)

    print(f"\n# {cls_path}")
    print(
        f"# MRO: {' → '.join(list(mro_order.keys())[:8])}{' …' if len(mro_order) > 8 else ''}\n"
    )

    # 按 MRO 顺序输出（父类先）
    for owner in sorted(
        methods_by_owner, key=lambda o: mro_order.get(o, 999), reverse=True
    ):
        print(f"  # ── 定义于 {owner} ──")
        for line in methods_by_owner[owner]:
            print(f"  {line}")


app = cyclopts.App(
    name="check_panel_params",
    help="检查 xxui Panel 包装器与原生 Panel 组件的参数一致性。",
    version="0.1.0",
)


@app.default
def check(
    *,
    ci: Annotated[
        bool,
        cyclopts.Parameter(
            name=("--ci",),
            help="CI 模式：有 **kwargs 兜底也视为通过",
        ),
    ] = False,
) -> None:
    """诊断模式：对比所有 xxui wrapper 与原生 Panel 的参数一致性。"""
    checks = run_checks()
    missing = _print_report(checks)

    if missing > 0:
        print(f"\n❌ {missing} 个参数缺失（无 **kwargs 兜底）")
        sys.exit(1)
    elif ci:
        print("\n✅ CI 检查通过（所有参数有 **kwargs 兜底）")
    else:
        _kwargs_pass_total(checks)
        print("\n✅ 诊断完成")


@app.command
def query(
    name: Annotated[
        str,
        cyclopts.Parameter(
            name=("--name", "-n"),
            help='Panel 类名，如 "Button"、"widgets.Button"',
        ),
    ],
) -> None:
    """查询原生 Panel 类的 __init__ 参数签名（支持模糊匹配）。"""
    _query_mode(name)


@app.command(name="list")
def list_classes() -> None:
    """列出所有已注册的 xxui wrapper 和可查询的 Panel 类名。"""
    _list_mode()


@app.command(name="methods")
def query_methods(
    name: Annotated[
        str,
        cyclopts.Parameter(
            name=("--name", "-n"),
            help='Panel 类名，如 "Button"、"widgets.IntSlider"',
        ),
    ],
) -> None:
    """列出 Panel 原生类的公开方法签名。"""
    cls = _find_panel_class(name)
    if cls is None:
        print(f"❌ 未找到 Panel 类: {name}")
        sys.exit(1)
    _query_methods(cls, name)


def _kwargs_pass_total(checks: list[WrapperCheck]) -> None:
    """打印通过 **kwargs 透传的参数统计。"""
    kpass_total = sum(
        sum(
            1
            for pp in c.panel_params
            if pp.name
            not in (
                _COMMON_EXCLUDED
                | _WRAPPER_EXCLUDED.get(_get_wrapper_cls(c.wrapper_name), set())
            )
            and pp.name not in c.wrapper_params
        )
        for c in checks
        if c.has_kwargs
    )
    if kpass_total > 0:
        print(f"\n⚠️  {kpass_total} 个参数通过 **kwargs 透传，建议强类型化")


if __name__ == "__main__":
    app()
