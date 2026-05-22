"""Playwright 浏览器集成测试 — 验证真实 UI 渲染与交互。

定位策略：优先 `get_by_role()` / `get_by_text()`，基于可访问性树，
不依赖 HTML 标签/class 结构变化。

运行: uv run pytest tests/test_browser.py -v --browser chromium
跳过: uv run pytest tests/test_browser.py --no-browser
"""

from __future__ import annotations

import pytest
from playwright.sync_api import Page, expect

pytestmark = pytest.mark.browser

# ═══════════════════════════════════════════════
# 页面渲染
# ═══════════════════════════════════════════════


class TestPageRender:
    """页面加载后核心元素可见。"""

    def test_title_visible(self, page: Page, panel_server: str) -> None:
        page.goto(panel_server)
        expect(page.get_by_role("heading", name="🧪 Browser Test App")).to_be_visible()

    def test_text_input_visible(self, page: Page, panel_server: str) -> None:
        page.goto(panel_server)
        inp = page.get_by_role("textbox", name="Name")
        expect(inp).to_be_visible()
        expect(inp).to_have_value("World")

    def test_radio_buttons_visible(self, page: Page, panel_server: str) -> None:
        page.goto(panel_server)
        expect(page.get_by_role("button", name="x1")).to_be_visible()
        expect(page.get_by_role("button", name="x2")).to_be_visible()
        expect(page.get_by_role("button", name="x5")).to_be_visible()

    def test_counter_buttons_visible(self, page: Page, panel_server: str) -> None:
        page.goto(panel_server)
        expect(page.get_by_role("button", name="-1")).to_be_visible()
        expect(page.get_by_role("button", name="+1")).to_be_visible()

    def test_greeting_rendered(self, page: Page, panel_server: str) -> None:
        """cell 初始渲染：Hello World × 1"""
        page.goto(panel_server)
        expect(page.get_by_text("Hello World × 1")).to_be_visible()


# ═══════════════════════════════════════════════
# 输入联动 → Cell 重新渲染
# ═══════════════════════════════════════════════


class TestInputToCellRerun:
    """输入组件变化 → signal 更新 → cell DOM 更新。"""

    def test_name_input_changes_greeting(self, page: Page, panel_server: str) -> None:
        """在 text input 中键入 → cell 自动 rerun → DOM 更新。"""
        page.goto(panel_server)

        inp = page.get_by_role("textbox", name="Name")
        inp.click()
        inp.fill("Alice")
        inp.press("Enter")

        expect(page.get_by_text("Hello Alice × 1")).to_be_visible()

    def test_multiplier_changes_repeated_emoji(
        self, page: Page, panel_server: str
    ) -> None:
        """切换 radio → signal 更新 → 🔥 次数变化。"""
        page.goto(panel_server)

        expect(page.get_by_text("🔥")).to_be_visible()

        page.get_by_role("button", name="x5").click()

        expect(page.get_by_text("🔥🔥🔥🔥🔥")).to_be_visible()

    def test_both_inputs_change_together(self, page: Page, panel_server: str) -> None:
        """同时改 name 和 multiplier，cell 正确渲染。"""
        page.goto(panel_server)

        inp = page.get_by_role("textbox", name="Name")
        inp.click()
        inp.fill("Bob")
        inp.press("Enter")

        page.get_by_role("button", name="x2").click()

        expect(page.get_by_text("Hello Bob × 2")).to_be_visible()
        expect(page.get_by_text("🔥🔥")).to_be_visible()


# ═══════════════════════════════════════════════
# 按钮点击 → Signal → Cell 联动（最易断链）
# ═══════════════════════════════════════════════


class TestButtonClickToCellRerun:
    """按钮 on_click → signal.value → cell rerun → DOM 更新。"""

    def test_increment_button_updates_counter(
        self, page: Page, panel_server: str
    ) -> None:
        page.goto(panel_server)

        expect(page.get_by_text("Counter: 0")).to_be_visible()

        page.get_by_role("button", name="+1").click()

        expect(page.get_by_text("Counter: 1")).to_be_visible()

    def test_decrement_button_updates_counter(
        self, page: Page, panel_server: str
    ) -> None:
        page.goto(panel_server)

        plus = page.get_by_role("button", name="+1")
        minus = page.get_by_role("button", name="-1")

        plus.click()
        plus.click()
        expect(page.get_by_text("Counter: 2")).to_be_visible()

        minus.click()
        expect(page.get_by_text("Counter: 1")).to_be_visible()

    def test_multiple_clicks_work(self, page: Page, panel_server: str) -> None:
        """连续多次点击，counter 累积正确。"""
        page.goto(panel_server)

        plus = page.get_by_role("button", name="+1")
        for _ in range(5):
            plus.click()

        expect(page.get_by_text("Counter: 5")).to_be_visible()


# ═══════════════════════════════════════════════
# Markdown 渲染
# ═══════════════════════════════════════════════


class TestMarkdownRendering:
    """验证 Panel Markdown 组件在浏览器中正确渲染 HTML。"""

    def test_markdown_h1_rendered(self, page: Page, panel_server: str) -> None:
        page.goto(panel_server)
        heading = page.get_by_role("heading", name="🧪 Browser Test App")
        expect(heading).to_be_visible()

    def test_cell_markdown_updates_on_signal_change(
        self, page: Page, panel_server: str
    ) -> None:
        """信号变化后 cell 的 markdown 内容更新到 DOM。"""
        page.goto(panel_server)
        page.get_by_role("button", name="x5").click()

        expect(page.get_by_text("× 5")).to_be_visible()


# ═══════════════════════════════════════════════
# 完整场景：用户操作全链路
# ═══════════════════════════════════════════════


class TestFullScenario:
    """模拟真实用户操作流程。"""

    def test_user_flow(self, page: Page, panel_server: str) -> None:
        """用户：改 name → 改 multiplier → 点 counter 按钮 → 所有渲染正确。"""
        page.goto(panel_server)

        # Step 1: 改名
        inp = page.get_by_role("textbox", name="Name")
        inp.click()
        inp.fill("Alice")
        inp.press("Enter")
        expect(page.get_by_text("Hello Alice × 1")).to_be_visible()

        # Step 2: 改 multiplier
        page.get_by_role("button", name="x5").click()
        expect(page.get_by_text("Hello Alice × 5")).to_be_visible()
        expect(page.get_by_text("🔥🔥🔥🔥🔥")).to_be_visible()

        # Step 3: counter
        plus = page.get_by_role("button", name="+1")
        plus.click()
        plus.click()
        expect(page.get_by_text("Counter: 2")).to_be_visible()

        # Step 4: 再改 name，counter 不受影响
        inp.click()
        inp.fill("Bob")
        inp.press("Enter")
        expect(page.get_by_text("Hello Bob × 5")).to_be_visible()
        expect(page.get_by_text("Counter: 2")).to_be_visible()
