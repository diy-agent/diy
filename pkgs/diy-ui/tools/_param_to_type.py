#!/usr/bin/env python3
"""Prototype: extract Python type annotations from Panel param descriptors."""

from __future__ import annotations

import panel as pn

_TYPE_MAP = {
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
}


def param_to_annotation(p, *, use_typing: bool = False) -> str:
    cls_name = p.__class__.__name__

    # Selector / ObjectSelector → Literal-like union or Any
    if cls_name in ("Selector", "ObjectSelector"):
        objects = getattr(p, "objects", None)
        if objects and len(objects) < 20:
            vals = []
            for v in objects:
                vals.append(repr(v))
            inner = " | ".join(vals)
            if len(inner) > 120:
                inner = "Any"
            return inner
        return "Any | None" if p.allow_None else "Any"

    # ClassSelector → reference to the base class
    if cls_name == "ClassSelector":
        class_ref = getattr(p, "class_", None) or getattr(p, "param_class", None)
        if class_ref:
            if isinstance(class_ref, tuple):
                return " | ".join(
                    c.__qualname__ if hasattr(c, "__qualname__") else str(c)
                    for c in class_ref[:3]
                )
            if hasattr(class_ref, "__qualname__"):
                return class_ref.__qualname__
        return "Any"

    # Known types
    if cls_name in _TYPE_MAP and _TYPE_MAP[cls_name] is not None:
        base = _TYPE_MAP[cls_name]
        if p.allow_None and not base.endswith("| None"):
            return f"{base} | None"
        return base

    return "Any"


def show_wrapper_types(cls, cls_name: str) -> None:
    params = cls.param.objects()
    print(f"# {cls_name} ({len(params)} params)")
    for name, p in sorted(params.items()):
        if name == "name":
            continue  # skip deprecated
        ann = param_to_annotation(p)
        default = repr(p.default)
        if len(default) > 50:
            default = "..."
        print(f"  {name}: {ann} = {default}")


if __name__ == "__main__":
    show_wrapper_types(pn.widgets.Button, "Button")
    print()
    show_wrapper_types(pn.widgets.TextInput, "TextInput")
