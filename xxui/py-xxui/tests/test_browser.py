"""Playwright 浏览器集成测试 — 验证真实 UI 渲染与交互。

这些测试启动真实的 Panel server + headless Chromium，验证：
- 组件渲染在 DOM 中可见
- 用户输入触发信号联动
- 按钮点击 → signal → cell rerun 完整链
- 普通 pytest 测试通过但实际 UI 可能不运转的场景

运行: uv run pytest tests/test_browser.py -v --browser chromium
跳过: uv run pytest tests/test_browser.py --no-browser
"""

from __future__ import annotations

import pytest
from playwright.sync_api import Page, expect

pytestmark = pytest.mark.browser


@pytest.fixture(autouse=True)
def _set_base_url(page: Page, panel_server: str) -> None:
    """将所有 page.goto("/") 的 base URL 设为 panel_server。"""
    # pytest-playwright 的 base_url fixture，在这里注入
    # 直接在测试中使用 panel_server fixture 拼接完整 URL


# ═══════════════════════════════════════════════
# 页面渲染
# ═══════════════════════════════════════════════


class TestPageRender:
    """页面加载后核心元素可见。"""

    def test_title_visible(self, page: Page, panel_server: str) -> None:
        page.goto(panel_server)
        expect(page.locator("h1")).to_contain_text("Browser Test App")

    def test_text_input_visible(self, page: Page, panel_server: str) -> None:
        page.goto(panel_server)
        inp = page.locator("input[type='text']")
        expect(inp).to_be_visible()
        expect(inp).to_have_value("World")

    def test_radio_buttons_visible(self, page: Page, panel_server: str) -> None:
        page.goto(panel_server)
        # Panel RadioButtonGroup 渲染为带 label 的 button group
        expect(page.locator("text=x1")).to_be_visible()
        expect(page.locator("text=x2")).to_be_visible()
        expect(page.locator("text=x5")).to_be_visible()

    def test_counter_buttons_visible(self, page: Page, panel_server: str) -> None:
        page.goto(panel_server)
        expect(page.locator("button", has_text="-1")).to_be_visible()
        expect(page.locator("button", has_text="+1")).to_be_visible()

    def test_greeting_rendered(self, page: Page, panel_server: str) -> None:
        """cell 初始渲染：Hello World × 1"""
        page.goto(panel_server)
        expect(page.locator("body")).to_contain_text("Hello World × 1")


# ═══════════════════════════════════════════════
# 输入联动 → Cell 重新渲染
# ═══════════════════════════════════════════════


class TestInputToCellRerun:
    """输入组件变化 → signal 更新 → cell DOM 更新。"""

    def test_name_input_changes_greeting(self, page: Page, panel_server: str) -> None:
        """在 text input 中键入 → cell 自动 rerun → DOM 更新。"""
        page.goto(panel_server)

        inp = page.locator("input[type='text']")
        inp.click()
        inp.fill("Alice")
        inp.press("Enter")

        # Cell rerun → DOM 中出现 Hello Alice
        expect(page.locator("body")).to_contain_text("Hello Alice × 1")

    def test_multiplier_changes_repeated_emoji(
        self, page: Page, panel_server: str
    ) -> None:
        """切换 radio → signal 更新 → 🔥 次数变化。"""
        page.goto(panel_server)

        # 初始 ×1 → 1 个 🔥
        expect(page.locator("body")).to_contain_text("🔥")

        # 点 x5
        page.locator("text=x5").click()

        # cell rerun → 5 个 🔥
        expect(page.locator("body")).to_contain_text("🔥🔥🔥🔥🔥")

    def test_both_inputs_change_together(self, page: Page, panel_server: str) -> None:
        """同时改 name 和 multiplier，cell 正确渲染。"""
        page.goto(panel_server)

        inp = page.locator("input[type='text']")
        inp.click()
        inp.fill("Bob")
        inp.press("Enter")

        page.locator("text=x2").click()

        expect(page.locator("body")).to_contain_text("Hello Bob × 2")
        expect(page.locator("body")).to_contain_text("🔥🔥")


# ═══════════════════════════════════════════════
# 按钮点击 → Signal → Cell 联动（最易断链）
# ═══════════════════════════════════════════════


class TestButtonClickToCellRerun:
    """按钮 on_click → signal.value → cell rerun → DOM 更新。

    这是「普通测试过但 UI 不运转」的重灾区：
    - on_click 回调设置 signal.value
    - signal 触发 cell rerun
    - cell 更新 Panel 原生 children
    - Panel 推送 WebSocket 更新到浏览器
    """

    def test_increment_button_updates_counter(
        self, page: Page, panel_server: str
    ) -> None:
        page.goto(panel_server)

        expect(page.locator("body")).to_contain_text("Counter: 0")

        page.locator("button", has_text="+1").click()

        # WebSocket 推送 → DOM 更新
        expect(page.locator("body")).to_contain_text("Counter: 1")

    def test_decrement_button_updates_counter(
        self, page: Page, panel_server: str
    ) -> None:
        page.goto(panel_server)

        page.locator("button", has_text="+1").click()
        page.locator("button", has_text="+1").click()
        expect(page.locator("body")).to_contain_text("Counter: 2")

        page.locator("button", has_text="-1").click()
        expect(page.locator("body")).to_contain_text("Counter: 1")

    def test_multiple_clicks_work(self, page: Page, panel_server: str) -> None:
        """连续多次点击，counter 累积正确。"""
        page.goto(panel_server)

        for _ in range(5):
            page.locator("button", has_text="+1").click()

        expect(page.locator("body")).to_contain_text("Counter: 5")


# ═══════════════════════════════════════════════
# Markdown 渲染
# ═══════════════════════════════════════════════


class TestMarkdownRendering:
    """验证 Panel Markdown 组件在浏览器中正确渲染 HTML。"""

    def test_markdown_h1_rendered(self, page: Page, panel_server: str) -> None:
        page.goto(panel_server)
        h1 = page.locator("h1")
        expect(h1).to_have_count(1)
        expect(h1).to_contain_text("Browser Test App")

    def test_markdown_bold_rendered(self, page: Page, panel_server: str) -> None:
        """**text** 渲染为 <strong>。"""
        page.goto(panel_server)
        expect(page.locator("strong")).to_contain_text("World")

    def test_cell_markdown_updates_on_signal_change(
        self, page: Page, panel_server: str
    ) -> None:
        """信号变化后 cell 的 markdown 内容更新到 DOM。"""
        page.goto(panel_server)
        page.locator("text=x5").click()

        # Counter cell 没变化，但 greeting cell 变了
        expect(page.locator("body")).to_contain_text("× 5")


# ═══════════════════════════════════════════════
# 完整场景：用户操作全链路
# ═══════════════════════════════════════════════


class TestFullScenario:
    """模拟真实用户操作流程。"""

    def test_user_flow(self, page: Page, panel_server: str) -> None:
        """用户：改 name → 改 multiplier → 点 counter 按钮 → 所有渲染正确。"""
        page.goto(panel_server)

        # Step 1: 改名
        inp = page.locator("input[type='text']")
        inp.click()
        inp.fill("Alice")
        inp.press("Enter")
        expect(page.locator("body")).to_contain_text("Hello Alice × 1")

        # Step 2: 改 multiplier
        page.locator("text=x5").click()
        expect(page.locator("body")).to_contain_text("Hello Alice × 5")
        expect(page.locator("body")).to_contain_text("🔥🔥🔥🔥🔥")

        # Step 3: counter
        page.locator("button", has_text="+1").click()
        page.locator("button", has_text="+1").click()
        expect(page.locator("body")).to_contain_text("Counter: 2")

        # Step 4: 再改 name，counter 不受影响
        inp.click()
        inp.fill("Bob")
        inp.press("Enter")
        expect(page.locator("body")).to_contain_text("Hello Bob × 5")
        expect(page.locator("body")).to_contain_text("Counter: 2")
