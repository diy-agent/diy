"""三种 Markdown 表格渲染方案对比。

独立运行：uv run python tests/test_md_compare.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtGui import QFont, QTextCursor, QTextLength, QTextTableFormat
from PySide6.QtWidgets import (
    QApplication,
    QMainWindow,
    QTabWidget,
    QTextBrowser,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

# ── 测试数据 ──

SRC = (Path.home() / ".diy" / "task" / "local" / "task" / "1" / "AGENTS.md").read_text(
    encoding="utf-8"
)
BODY = re.sub(r"^---\n.*?^---\n", "", SRC, count=1, flags=re.DOTALL | re.MULTILINE)


# ═══════════════════════════════════════════════════════════
# 方案 A: Rich → QTextEdit(monospace)
# ═══════════════════════════════════════════════════════════


def render_a(md_text: str) -> str:
    from rich.console import Console
    from rich.markdown import Markdown

    console = Console(record=True, force_terminal=False, width=100)
    console.print(Markdown(md_text))
    return console.export_text()


# ═══════════════════════════════════════════════════════════
# 方案 B: markdown-it-py → QWebEngineView (完整 HTML)
# ═══════════════════════════════════════════════════════════


def render_b(md_text: str) -> str:
    from markdown_it import MarkdownIt

    md = MarkdownIt("gfm-like", {"breaks": True, "html": True})
    body_html = md.render(md_text)
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body {{ background: #1e1e2e; color: #cdd6f4; font-family: -apple-system, sans-serif; font-size: 14px; padding: 16px; line-height: 1.7; }}
  h1 {{ color: #fff; font-size: 20px; border-bottom: 1px solid #45475a; padding-bottom: 4px; }}
  h2 {{ color: #cdd6f4; font-size: 17px; }}
  h3 {{ color: #a6adc8; font-size: 15px; }}
  table {{ border-collapse: collapse; margin: 12px 0; width: 100%; }}
  th {{ background: #313244; color: #cdd6f4; padding: 8px 12px; text-align: left; font-weight: 600; border: 1px solid #45475a; }}
  td {{ padding: 6px 12px; border: 1px solid #313244; }}
  tr:nth-child(even) {{ background: #181825; }}
  code {{ background: #1e1e2e; color: #f5c2e7; padding: 1px 5px; border-radius: 3px; font-size: 13px; }}
  pre {{ background: #181825; padding: 10px 14px; border-radius: 6px; overflow-x: auto; }}
  blockquote {{ border-left: 3px solid #45475a; padding-left: 12px; color: #a6adc8; margin: 8px 0; }}
  a {{ color: #89b4fa; }}
  ul, ol {{ padding-left: 20px; }}
  hr {{ border: none; border-top: 1px solid #45475a; }}
</style></head><body>{body_html}</body></html>"""


# ═══════════════════════════════════════════════════════════
# 方案 C: mistune → QTextDocument + QTextTable (原生 Qt 表格)
# ═══════════════════════════════════════════════════════════


def render_c(md_text: str) -> str:
    """使用 mistune 解析 MD → 分段构建 QTextDocument 并 export 为 HTML。"""
    import mistune

    markdown = mistune.create_markdown(renderer="ast", plugins=["table"])
    tokens = markdown(md_text)  # AST

    from PySide6.QtGui import (
        QTextBlockFormat,
        QTextCharFormat,
        QTextDocument,
    )

    doc = QTextDocument()
    cursor = QTextCursor(doc)

    # 颜色
    h1_fmt = QTextBlockFormat()
    h1_fmt.setProperty(QTextBlockFormat.Property.LineHeight, 1.4)

    h1_cf = QTextCharFormat()
    h1_cf.setFontPointSize(20)
    h1_cf.setForeground(Qt.GlobalColor.white)

    h2_cf = QTextCharFormat()
    h2_cf.setFontPointSize(17)
    h2_cf.setForeground(Qt.GlobalColor.white)

    h3_cf = QTextCharFormat()
    h3_cf.setFontPointSize(15)
    h3_cf.setForeground(QColor("#cdd6f4"))

    body_cf = QTextCharFormat()
    body_cf.setFontPointSize(13)
    body_cf.setForeground(QColor("#bac2de"))

    code_cf = QTextCharFormat()
    code_cf.setFontFamilies(["Menlo", "monospace"])
    code_cf.setFontPointSize(12)
    code_cf.setBackground(QColor("#1e1e2e"))
    code_cf.setForeground(QColor("#f5c2e7"))

    def _cell_text(node: dict) -> str:
        """从 mistune AST cell 节点递归提取纯文本。"""
        raw = node.get("raw", "")
        if raw:
            return raw
        parts: list[str] = []
        for c in node.get("children", []):
            if isinstance(c, dict):
                parts.append(_cell_text(c))
        return "".join(parts)

    def _walk(toks):
        for tok in toks:
            t = tok.get("type", "")
            if t == "heading":
                level = tok.get("level", 1)
                cf = {1: h1_cf, 2: h2_cf, 3: h3_cf}.get(level, body_cf)
                bf = QTextBlockFormat()
                if level == 1:
                    bf.setBottomMargin(4)
                cursor.insertBlock(bf, cf)
                for c in tok.get("children", []):
                    _walk([c])
                # 下划线 (仅 h1)
                if level == 1:
                    cursor.insertBlock()

            elif t == "text":
                cursor.insertText(tok.get("raw", ""), body_cf)

            elif t == "codespan":
                cursor.insertText(tok.get("raw", ""), code_cf)

            elif t == "strong":
                cf = QTextCharFormat(body_cf)
                f = cf.font()
                f.setBold(True)
                cf.setFont(f)
                cursor.insertText(
                    "".join(c.get("raw", "") for c in tok.get("children", [])), cf
                )

            elif t == "emphasis":
                cf = QTextCharFormat(body_cf)
                f = cf.font()
                f.setItalic(True)
                cf.setFont(f)
                cursor.insertText(
                    "".join(c.get("raw", "") for c in tok.get("children", [])), cf
                )

            elif t == "paragraph":
                for c in tok.get("children", []):
                    _walk([c])
                cursor.insertBlock()

            elif t == "block_text":
                for c in tok.get("children", []):
                    _walk([c])

            elif t == "block_quote":
                bf = QTextBlockFormat()
                bf.setLeftMargin(20)
                bf.setProperty(QTextBlockFormat.Property.LineHeight, 1.3)
                cf = QTextCharFormat(body_cf)
                cf.setForeground(QColor("#a6adc8"))
                for c in tok.get("children", []):
                    cursor.insertBlock(bf, cf)
                    _walk([c])

            elif t == "list":
                for item in tok.get("children", []):
                    bf = QTextBlockFormat()
                    bf.setLeftMargin(20)
                    cf = QTextCharFormat(body_cf)
                    cursor.insertBlock(bf, cf)
                    cursor.insertText("• ", cf)
                    for c in item.get("children", []):
                        _walk([c])
                    cursor.insertBlock()

            elif t == "block_code":
                bf = QTextBlockFormat()
                bf.setBackground(QColor("#181825"))
                bf.setBottomMargin(6)
                cursor.insertBlock(bf, code_cf)
                cursor.insertText(tok.get("raw", ""), code_cf)
                cursor.insertBlock()

            elif t == "thematic_break":
                cursor.insertBlock()
                cursor.insertText("─" * 60, body_cf)
                cursor.insertBlock()

            elif t == "table":
                # mistune AST: table → table_head + table_body
                # table_head → table_cell[]
                # table_body → table_row[] → table_cell[]
                n_cols = 0
                header_cells = []
                body_rows_raw = []
                for child in tok.get("children", []):
                    ct = child.get("type", "")
                    if ct == "table_head":
                        header_cells = [
                            _cell_text(c) for c in child.get("children", [])
                        ]
                        n_cols = max(n_cols, len(header_cells))
                    elif ct == "table_body":
                        for row in child.get("children", []):
                            if row.get("type") == "table_row":
                                cells = [_cell_text(c) for c in row.get("children", [])]
                                body_rows_raw.append(cells)
                                n_cols = max(n_cols, len(cells))

                if n_cols == 0:
                    continue

                fmt = QTextTableFormat()
                fmt.setBorder(1)
                fmt.setBorderBrush(QColor("#45475a"))
                fmt.setCellPadding(6)
                fmt.setAlignment(Qt.AlignmentFlag.AlignLeft)
                fmt.setWidth(QTextLength(QTextLength.Type.PercentageLength, 100))

                total_rows = 1 + len(body_rows_raw)
                table = cursor.insertTable(total_rows, n_cols, fmt)

                # Header
                hdr_cf = QTextCharFormat()
                hdr_cf.setFontPointSize(13)
                hdr_cf.setForeground(QColor("#cdd6f4"))
                hdr_cf.setBackground(QColor("#313244"))
                f = hdr_cf.font()
                f.setBold(True)
                hdr_cf.setFont(f)

                for ci in range(n_cols):
                    c = table.cellAt(0, ci)
                    bc = c.firstCursorPosition()
                    bc.insertText(
                        header_cells[ci] if ci < len(header_cells) else "", hdr_cf
                    )

                # Body rows
                for ri, row_cells in enumerate(body_rows_raw):
                    for ci in range(n_cols):
                        cell_text = row_cells[ci] if ci < len(row_cells) else ""
                        c = table.cellAt(ri + 1, ci)
                        bc = c.firstCursorPosition()
                        bc.insertText(cell_text, body_cf)

                cursor.movePosition(QTextCursor.MoveOperation.End)
                cursor.insertBlock()

            else:
                # fallback: 输出 raw
                raw = tok.get("raw", "")
                if raw:
                    cursor.insertText(raw, body_cf)

    _walk(tokens)

    # 导出为 HTML (QTextDocument → HTML, 包含 QTextTable)
    return doc.toHtml()


# ═══════════════════════════════════════════════════════════
# GUI
# ═══════════════════════════════════════════════════════════

from PySide6.QtGui import (  # noqa: E402  # GUI 常量定义后 import，非标准文件顶顺序
    QColor,
)


def _make_tab(label: str, widget: QWidget) -> QWidget:
    wrapper = QWidget()
    layout = QVBoxLayout(wrapper)
    layout.setContentsMargins(0, 0, 0, 0)
    layout.addWidget(widget)
    return wrapper


class CompareWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("MD 表格渲染方案对比")
        self.resize(1100, 700)

        tabs = QTabWidget()

        # A: Rich 文本
        te = QTextEdit()
        te.setReadOnly(True)
        te.setFont(QFont("Menlo", 12))
        te.setPlainText(render_a(BODY))
        tabs.addTab(_make_tab("A: Rich 文本 (QTextEdit monospace)", te), "Rich文本")

        # B: HTML (QWebEngineView)
        from PySide6.QtWebEngineWidgets import QWebEngineView

        wv = QWebEngineView()
        wv.setHtml(render_b(BODY))
        tabs.addTab(
            _make_tab("B: QWebEngineView (HTML, 需 WebEngine)", wv), "WebEngine"
        )

        # C: QTextDocument + QTextTable (原生)
        tb = QTextBrowser()
        tb.setOpenExternalLinks(True)
        html = render_c(BODY)
        tb.setHtml(html)
        tabs.addTab(
            _make_tab("C: QTextDocument+QTextTable (原生)", tb), "原生QTextTable"
        )

        self.setCentralWidget(tabs)


if __name__ == "__main__":
    app = QApplication(sys.argv)
    w = CompareWindow()
    w.show()
    sys.exit(app.exec())
