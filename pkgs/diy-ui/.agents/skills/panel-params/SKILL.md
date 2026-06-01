---
name: panel-params
description: Panel 组件诊断工具：适配状态 + 参数一致性 + 透传验证。当用户提到 Panel 参数、强类型化、wrapper 签名、**kwargs 消除、组件适配状态、参数透传时使用此 skill。
---

# Panel 诊断工具

## 工具位置

```
tools/doctor_panel.py               # 主工具
tests/test_panel_param_coverage.py  # pytest 测试（5 个用例）
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

# 参数透传运行时验证
./sha.sh panel verify               # 用非默认值实例化 wrapper，验证参数正确传递到 Panel 原生对象

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
3. 运行 `pytest tests/test_panel_param_coverage.py -v` 校验遗漏与透传
4. 补全 → 测试通过 → 提交

## 验证机制

- **doctor**：静态签名对比 —— Panel param 声明 vs wrapper `__init__` 显式参数
- **verify**：运行时透传验证 —— 为每个参数生成非默认测试值，实例化 wrapper 后检查 Panel 原生属性是否反映了该值
- **测试**：CI 中同时运行覆盖率和透传验证，覆盖率需 >= 60%

## 排除参数说明

`tools/doctor_panel.py` 中的 `_COMMON_EXCLUDED` 和 `_WRAPPER_EXCLUDED` 定义哪些 Panel 参数由 diyui 内部管理、不需要暴露在 wrapper 签名中：

- `objects`: 容器 children，由 `_PanelContainerMixin` sync 管理
- `value_input`, `enter_pressed`（TextInput）: 内部中间态/只读事件
- `clicks`（Button）: 只读计数器

## 参数别名映射

`_WRAPPER_PARAM_MAP` 定义 wrapper 参数名到 Panel 属性名的映射，用于语义重命名的情况：

- `button_type` → `color`（Button / RadioButtonGroup）
- `button_style` → `variant`

## 关键文件

- `src/diyui/providers/panel/` — 所有 wrapper 定义
- `tools/doctor_panel.py` — 诊断工具
- `tests/test_panel_param_coverage.py` — 参数一致性 + 透传测试
