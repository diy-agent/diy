"""
DiyMeta — Panel 类型安全的 pydantic 风格 metaclass。

通过 UIComponent.__init_subclass__ 在子类定义时自动检测 Panel 父类，
exec 动态生成带有完整类型注解的 __init__，同时调用模板方法钩子。
"""

from __future__ import annotations as _annotations

from typing import Any

__all__ = ["DiyInitSub"]


# ── param descriptor → Python 类型字符串 ─────────────────────────────

_TYPE_MAP: dict[str, str] = {
    "Boolean": "bool",
    "String": "str",
    "Integer": "int",
    "Number": "float",
    "List": "list[Any]",
    "Dict": "dict[str, Any]",
    "Event": "bool",
    "Color": "str",
    "Margin": "tuple[int, int] | int | str",
    "Align": "str | tuple[str, str]",
    "Array": "numpy.ndarray",
    "Callable": "collections.abc.Callable",
    "DataFrame": "pandas.DataFrame",
    "Path": "pathlib.Path",
    "Dynamic": "Any",
    "OSSelector": "str",
    "ActionSelector": "str",
    "MultiFileSelector": "list[Path]",
    "Date": "datetime.date",
    "Datetime": "datetime.datetime",
    "Foldername": "str",
    "Filename": "str",
}


def _param_to_annotation(p) -> str:
    """Return a Python type-annotation string for a param descriptor."""
    cls_name = p.__class__.__name__

    if cls_name in ("Selector", "ObjectSelector"):
        objects = getattr(p, "objects", None)
        if objects and len(objects) < 20:
            vals = []
            for v in objects:
                if isinstance(v, type):
                    # Use qualified name for class objects
                    vals.append(f"{v.__module__}.{v.__qualname__}")
                else:
                    vals.append(repr(v))
            return " | ".join(vals)
        return "Any"

    if cls_name == "ClassSelector":
        cref = getattr(p, "class_", None)
        if isinstance(cref, tuple):
            parts = []
            for c in cref[:3]:
                if hasattr(c, "__qualname__"):
                    parts.append(c.__qualname__)
                else:
                    parts.append(str(c))
            return " | ".join(parts)
        if cref and hasattr(cref, "__qualname__"):
            return cref.__qualname__
        return "Any"

    base = _TYPE_MAP.get(cls_name, "Any")
    if p.allow_None and not base.endswith(" | None"):
        base += " | None"
    return base


def _repr_default(val: Any) -> str:
    """Safe repr for param default values — produces valid Python expression."""
    # Primitives that repr handles correctly
    if val is None or isinstance(val, (bool, int, float, str)):
        return repr(val)
    # Simple containers
    if isinstance(val, (list, dict, tuple, set)):
        inner = repr(val)
        try:
            compile(inner, '<string>', 'eval')
            return inner
        except SyntaxError:
            pass
    # Fallback for classes, enums, etc. → show as None with comment
    return "None"


def _build_init_source(class_name: str, param_list: list[tuple[str, str, Any]],
                       exclude: set[str], pre_kwargs: set[str]) -> str:
    """Build Python source for a typed __init__."""
    param_names = [p[0] for p in param_list]
    pre_filtered = pre_kwargs & set(param_names)

    lines = [
        "from __future__ import annotations",
        f"def __init__(self, *,",
    ]
    for pname, ann, dval in param_list:
        lines.append(f"    {pname}: {ann} = {_repr_default(dval)},")
    lines.extend([
        "    **kwargs: Any,",
        "):",
        "    _kw = dict(",
    ])
    for pname in param_names:
        lines.append(f"        {pname}={pname},")
    lines.extend([
        "        **kwargs,",
        "    )",
        "    # Base init — MRO 查找 UIComponent",
        "    for _b in type(self).__mro__:",
        "        if _b.__name__ == 'UIComponent':",
        "            _b.__init__(self)",
        "            break",
        "    # _diy_pre_init — 在 Panel.__init__ 之前",
        "    _pre = getattr(self, '_diy_pre_init', None)",
    ])
    if pre_filtered:
        filtered_str = ", ".join(repr(k) for k in sorted(pre_filtered))
        lines.append(f"    if _pre: _pre(**{{k: _kw[k] for k in {{{filtered_str}}} if k in _kw}})")
    lines.extend([
        "    # Panel.__init__ — 纯透传",
        "    pn_base.__init__(self, **_kw)",
        "    # _diy_post_init — 在 Panel.__init__ 之后",
        "    _post = getattr(self, '_diy_post_init', None)",
        "    if _post: _post()",
    ])
    return "\n".join(lines)


def _generate_init(cls, panel_base) -> None:
    """Generate and inject typed __init__ for cls based on Panel's params."""
    # Read Panel param descriptors
    try:
        params = panel_base.param.objects()
    except Exception:
        return

    exclude = {"name", "clicks"} | set(getattr(cls, "__exclude_params__", set()))
    pre_kwargs = getattr(cls, "__pre_kwargs__", {"value"})

    param_list: list[tuple[str, str, Any]] = []
    for pname, pdesc in sorted(params.items()):
        if pname in exclude:
            continue
        ann = _param_to_annotation(pdesc)
        param_list.append((pname, ann, pdesc.default))

    # Generate init via exec — inject panel for annotation resolution
    src = _build_init_source(cls.__name__, param_list, exclude, pre_kwargs)
    import panel as _pn_module
    ns: dict = {"pn_base": panel_base, "Any": object, "panel": _pn_module}
    exec(src, ns)
    cls.__init__ = ns["__init__"]
    cls.__diy_init_generated__ = True


# ── Mixin to be inherited by UIComponent ─────────────────────────────

class DiyInitSub:
    """Mixin that generates typed __init__ for Panel wrapper subclasses.

    Usage in UIComponent (multiple inheritance):
        class UIComponent(diy.ui.ScopeNode, DiyInitSub):
            ...

    DiyInitSub.__init_subclass__ detects whether the new class
    has a Panel base class and generates a typed init if so.
    """

    @classmethod
    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)

        # Only process final subclasses
        if cls.__name__ in ("UIComponent", "DiyInitSub"):
            return

        # Find Panel base (skip DiyInitSub and UIComponent themselves)
        panel_base = None
        for base in cls.__mro__:
            if base is cls:
                continue
            if base.__name__ in ("UIComponent", "DiyInitSub"):
                continue
            if hasattr(base, "param"):
                panel_base = base
                break

        if panel_base is None:
            return

        _generate_init(cls, panel_base)
