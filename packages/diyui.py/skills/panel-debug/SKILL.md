---
name: diyui-panel-debug
description: 'Debug diyUI Panel/Bokeh pages with Playwright. Use ONLY when the user explicitly asks to test/verify/debug a diyUI Panel example or app. Also use when you encounter: (1) blank page with no errors, (2) results that contradict expectations with no obvious cause, (3) same issue persists after 2+ fix attempts, or (4) the user asks "what do you see" / "does it look right". Do NOT use for general Playwright tasks, non-Panel pages, or when the user just wants to open a browser.'
allowed-tools: Bash(playwright-cli:*) Bash(npx:*) Bash(uv:*) Bash(panel:*) Bash(pkill:*) Bash(curl:*) Bash(cat:*) Bash(grep:*) Bash(sleep:*)
---

# diyUI Panel Debug

调试 diyUI Panel/Bokeh 页面的标准流程。Panel 页面走 BokehJS + WebSocket 渲染，Python 错误可能被完全隐藏。

## 核心规则

### 1. 始终 --dev

启动 Panel 服务**永远加 `--dev`**。不加的话 Python 初始化错误被 Bokeh 吞掉，页面空白，前端无任何错误。

```bash
uv run panel serve --dev <file>.py --port <port>
```

### 2. 默认不打扰人类

先用 playwright 默认模式（headless）自动诊断。按下面流程排查，大多数问题能在这一层解决。

### 3. 只有以下情况才请求人类参与 head 模式

- **连续 2 次修复尝试后问题依旧** — 说明可能有误解，需要人类肉眼确认
- **出现不合常理的结果** — 比如 snapshot 有内容但数值明显不对、你认为是 A 原因但修复无效
- **人类主动关注** — 用户说"帮我看看"、"你看到什么了"、"截图给我"、"打开浏览器让我看"
- **空白页且 stderr 无错误** — 你无法区分是渲染延迟还是真的有问题

此时才用 `--browser=chrome` 开 head 模式，操作节奏放慢（每步等 5s），让人类同步观察。

## 自动诊断流程（无需人类）

### Step 1: 检查服务端

```bash
# 查看 stderr 有无 Python 异常
# panel serve --dev 会直接打印 traceback
```

有异常 → 直接读 traceback，修复后重试。不需开浏览器。

### Step 2: 快速诊断（headless playwright）

```bash
playwright-cli open http://localhost:<port>/<app>
sleep 5
playwright-cli snapshot      # 查页面结构
playwright-cli console       # 查 JS 错误
```

分析 snapshot 和 console 结果，对照下面的速查表。

### Step 3: 深入 Bokeh model（当 snapshot 不够时）

```bash
# Bokeh 渲染状态
playwright-cli eval "
(() => {
  const doc = Bokeh.documents[0];
  return { roots: doc.roots().length, models: doc._all_models.size };
})()
"

# Markdown/HTML 实际文本内容
playwright-cli eval "
(() => {
  const doc = Bokeh.documents[0];
  const htmls = [];
  doc._all_models.forEach(m => {
    if (m.type === 'panel.models.markup.HTML') htmls.push(m.attributes.text?.substring(0,120));
  });
  return htmls;
})()
"
```

## 常见问题速查

| 现象 | snapshot | console | Bokeh roots | stderr | 根因 |
|------|----------|---------|-------------|--------|------|
| 空白页 | 空 | 无错误 | 0 | `NameError` / `ImportError` | 模块加载失败 |
| 空白页 | 空 | 无错误 | 0 | `ValueError: truth value of DataFrame` | `_signal.py` 的 `==` 比较 |
| 部分组件缺失 | 有但缺组件 | 无错误 | >0 | 可能无 | 组件 factory 缺 import |
| 数据不刷新 | 有但值不变 | 无错误 | >0 | 可能无 | tick signal / cell 依赖 |
| 数据追加不替换 | snapshot 增长 | 无错误 | >0 | 无 | while True 内多次 yield |
| 无错误但异常 | 正常 | 无错误 | >0 | 无 | Python 运行时异常被 `debug.record_error` 吃掉 |

## 人类参与流程（仅必要时）

只有满足上面触发条件时才走这一步。

### 请求人类

说清楚："我在排查 X 问题，已经试了 A 和 B 都没解决。需要你帮忙看一下浏览器实际渲染效果，我来操作，你只需要看。"

### 打开 head 模式

```bash
playwright-cli close 2>/dev/null; sleep 0.5
playwright-cli open --browser=chrome http://localhost:<port>/<app>
```

### 慢节奏操作

每步间隔 ≥ 5 秒，等人类确认后再继续：

```bash
sleep 5
playwright-cli snapshot
# 问：你看到的数据对吗？XX 组件在吗？
```

### 收尾

```bash
playwright-cli close
pkill -f "panel serve.*<keyword>"
```
