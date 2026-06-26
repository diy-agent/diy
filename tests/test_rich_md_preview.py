"""Rich Markdown → QTextEdit monospace 渲染测试。

独立运行：uv run python tests/test_rich_md_preview.py
退出：关闭窗口
"""

from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QApplication,
    QMainWindow,
    QPlainTextEdit,
    QSplitter,
    QTextEdit,
)
from rich.console import Console
from rich.markdown import Markdown


def md_to_terminal_text(md_text: str, width: int = 88) -> str:
    """用 Rich 渲染 Markdown，export 为纯文本（保留 Unicode 框线字符）。"""
    console = Console(record=True, force_terminal=False, width=width)
    console.print(Markdown(md_text))
    return console.export_text()


TEST_MD = (
    Path.home() / ".diy" / "task" / "local" / "task" / "1" / "AGENTS.md"
).read_text(encoding="utf-8")

# 去掉 frontmatter（---...--- 之间的 YAML 头）
import re  # noqa: E402  # frontmatter 截断后 import，非标准文件顶

TEST_MD = re.sub(
    r"^---\n.*?^---\n", "", TEST_MD, count=1, flags=re.DOTALL | re.MULTILINE
)


class RichMdPreview(QMainWindow):
    """测试窗口：对比 Rich 文本渲染 vs 原始 Markdown。"""

    def __init__(self):
        super().__init__()
        self.setWindowTitle("Rich Markdown 渲染测试")
        self.resize(900, 500)

        splitter = QSplitter(Qt.Orientation.Horizontal)

        # 左侧：原始 MD
        raw = QPlainTextEdit()
        raw.setPlainText(TEST_MD)
        raw.setFont(QFont("monospace", 11))
        raw.setReadOnly(True)
        splitter.addWidget(raw)

        # 右侧：Rich 渲染输出
        rendered = QTextEdit()
        rendered.setReadOnly(True)
        rendered.setFont(QFont("Menlo", 12))
        rich_text = md_to_terminal_text(TEST_MD)
        rendered.setPlainText(rich_text)
        splitter.addWidget(rendered)

        self.setCentralWidget(splitter)


if __name__ == "__main__":
    app = QApplication(sys.argv)
    w = RichMdPreview()
    w.show()
    sys.exit(app.exec())
