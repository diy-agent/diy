---
name: panel-params
description: Panel 组件诊断工具：适配状态 + 参数一致性 + 签名查询。当用户提到 Panel 参数、强类型化、wrapper 签名、**kwargs 消除、组件适配状态时使用此 skill。
---

# Panel 诊断工具

## 工具位置

```
tools/doctor_panel.py               # 主工具
tests/test_panel_param_coverage.py  # pytest 测试（3 个用例）
```

## 命令

```bash
# 组件适配列表
./sha.sh panel list                  # 全量列表
./sha.sh panel list -g widgets       # 仅 widgets
./sha.sh panel list -g pane          # 仅 pane
./sha.sh panel list -g layout        # 仅 layout

# 参数一致性诊断
./sha.sh panel doctor               # 参数一致性诊断

# 查构造器参数 → 输出可复制的 __init__ 签名
./sha.sh panel query -n Button
./sha.sh panel query -n Column
./sha.sh panel query -n Card
./sha.sh panel query -n Markdown
./sha.sh panel query -n TextInput
./sha.sh panel query -n RadioButtonGroup
./sha.sh panel query -n widgets.IntSlider   # 任意 Panel 类
```

## 强类型化流程

1. `query -n <类名>` 拿到 Panel 原生 __init__ 签名
2. 复制到 wrapper 的 `__init__`，去掉 `**kwargs`，改为显式 keyword-only 参数
3. 运行 `pytest tests/test_panel_param_coverage.py -v` 校验遗漏
4. 补全 → 测试通过 → 提交

## 排除参数说明

`tools/doctor_panel.py` 中的 `_COMMON_EXCLUDED` 和 `_WRAPPER_EXCLUDED` 定义哪些 Panel 参数由 diyui 内部管理、不需要暴露在 wrapper 签名中：

- `objects`: 容器 children，由 `_PanelContainerMixin` sync 管理
- `value_input`, `enter_pressed`（TextInput）: 内部中间态/只读事件
- `clicks`（Button）: 只读计数器

## 关键文件

- `src/diyui/providers/panel.py` — 所有 wrapper 定义
- `tools/doctor_panel.py` — 诊断工具
- `tests/test_panel_param_coverage.py` — 参数一致性测试
