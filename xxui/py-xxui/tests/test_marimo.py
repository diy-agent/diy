"""Marimo provider 契约测试。

MarimoApp 是 marimo 专属的 xxui App。
组件参数与 marimo 原生保持一致。
"""
import marimo as mo
from xxui.providers.marimo import (
    MarimoApp,
    MarimoHStack, MarimoVStack,
    MarimoButton, MarimoText, MarimoRadio, MarimoMd,
)


# ═══════════════════════════════════════════════
# 构造
# ═══════════════════════════════════════════════

class TestMarimoAppConstruction:
    """MarimoApp 构造。"""

    def test_create_marimo_app(self):
        app = MarimoApp()
        assert app.provider == "marimo"

    def test_app_is_base_app(self):
        from xxui.base_app import BaseApp
        assert isinstance(MarimoApp(), BaseApp)


# ═══════════════════════════════════════════════
# 组件参数保持 marimo 风格
# ═══════════════════════════════════════════════

class TestComponentMarimoStyle:
    """组件参数与 marimo 原生一致。"""

    def test_button_label(self):
        app = MarimoApp()
        btn = app.button(label="Run")
        assert "Run" in btn.target._text

    def test_text_label(self):
        app = MarimoApp()
        inp = app.text(label="Name")
        assert "Name" in inp.target._inner_text

    def test_radio_options(self):
        app = MarimoApp()
        radio = app.radio(options=["a", "b"])
        assert radio.target.options == {"a": "a", "b": "b"}

    def test_md_content(self):
        app = MarimoApp()
        md = app.md("# Title")
        assert "Title" in md.target.text


# ═══════════════════════════════════════════════
# with context 构建 marimo 树
# ═══════════════════════════════════════════════

class TestWithContextMarimoTree:
    """with 语法在 marimo 容器中构建父子关系。"""

    def test_vstack_contains_button(self):
        app = MarimoApp()
        with app.vstack() as stack:
            btn = app.button(label="Go")
        assert btn.parent is stack
        assert btn in stack._children

    def test_nested_containers(self):
        app = MarimoApp()
        with app.vstack() as outer:
            md1 = app.md("outer")
            with app.hstack() as inner:
                btn = app.button(label="Go")
            md2 = app.md("after")
        assert outer._children == [md1, inner, md2]
        assert inner._children == [btn]


# ═══════════════════════════════════════════════
# 输入组件 value ↔ signal
# ═══════════════════════════════════════════════

class TestInputComponentSignal:
    """输入组件的 .value 代理到 signal.value。"""

    def test_text_value(self):
        app = MarimoApp()
        inp = app.text(label="Name")
        assert inp.value == ""
        inp.value = "Alice"
        assert inp.signal.value == "Alice"

    def test_radio_value(self):
        app = MarimoApp()
        radio = app.radio(options=["a", "b"], value="a")
        assert radio.value == "a"
        radio.value = "b"
        assert radio.signal.value == "b"


# ═══════════════════════════════════════════════
# wrapper 公开 target
# ═══════════════════════════════════════════════

class TestWrapperExposesTarget:
    """xxui 是薄层，用户可直接访问 .target。"""

    def test_button_target(self):
        app = MarimoApp()
        btn = app.button(label="X")
        assert isinstance(btn.target, mo.ui.button)

    def test_text_target(self):
        app = MarimoApp()
        inp = app.text(label="X")
        assert isinstance(inp.target, mo.ui.text)
