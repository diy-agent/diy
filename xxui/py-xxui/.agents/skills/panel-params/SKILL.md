---
name: panel-params
description: Panel 组件参数强类型化工具与流程。内省 Panel 原生类的 param 定义和方法签名，生成可复制的 __init__ 签名，驱动 xxui wrapper 从 **kwargs 迁移到显式强类型参数。当用户提到 Panel 参数、强类型化、wrapper 签名、**kwargs 消除、Panel 方法签名时使用此 skill。
---

# Panel 参数强类型化

## 工具位置

```
tools/check_panel_params.py          # 主工具
tests/test_panel_param_coverage.py   # pytest 测试（3 个用例）
```

## 三种查询模式

```bash
# 1. 查构造器参数 → 输出可复制的 __init__ 签名
uv run python tools/check_panel_params.py --query Button
uv run python tools/check_panel_params.py --query Column
uv run python tools/check_panel_params.py --query Card
uv run python tools/check_panel_params.py --query Markdown
uv run python tools/check_panel_params.py --query TextInput
uv run python tools/check_panel_params.py --query RadioButtonGroup
# 任意 Panel 类:
uv run python tools/check_panel_params.py --query widgets.IntSlider

# 2. 查方法签名 → 按 MRO 分组列出所有公开方法
uv run python tools/check_panel_params.py --methods Button
uv run python tools/check_panel_params.py --methods TextInput

# 3. 综合诊断/CI
uv run python tools/check_panel_params.py               # 全量 7×wrapper 对照表
uv run python tools/check_panel_params.py --ci           # CI 模式，缺失则 exit 1
uv run python tools/check_panel_params.py --list         # 已注册 wrapper 清单
```

## 强类型化流程

1. `--query <类名>` 拿到 Panel 原生 __init__ 签名
2. 复制到 wrapper 的 `__init__`，去掉 `**kwargs`，改为显式 keyword-only 参数
3. 运行 `pytest tests/test_panel_param_coverage.py -v` 校验遗漏
4. 补全 → 测试通过 → 提交

## 排除参数说明

`tools/check_panel_params.py` 中的 `_COMMON_EXCLUDED` 和 `_WRAPPER_EXCLUDED` 定义哪些 Panel 参数由 xxui 内部管理、不需要暴露在 wrapper 签名中：

- `name`: param 内部名
- `objects`: 容器 children，由 `_PanelContainerMixin` sync 管理
- `value`（TextInput/RadioButtonGroup）: signal 代理
- `value_input`, `enter_pressed`（TextInput）: 内部中间态/只读事件
- `clicks`（Button）: 只读计数器

## 当前状态

7 个 wrapper 共 184 个 Panel 参数全部经 `**kwargs` 透传。测试通过（有兜底）。去掉 `**kwargs` 后测试立即转为严格模式。

## 关键文件

- `src/xxui/providers/panel.py` — 所有 wrapper 定义
- `tools/check_panel_params.py` — 内省工具
- `tests/test_panel_param_coverage.py` — 参数一致性测试
