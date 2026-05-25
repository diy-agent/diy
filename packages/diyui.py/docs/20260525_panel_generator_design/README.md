# Panel wrapper 代码生成器设计讨论

日期：2026-05-25
状态：讨论 / 待数据充分后重新评估

## 背景

正在准备大规模实现 Panel 组件 wrapper，当前 7 个 wrapper（Button、TextInput、RadioButtonGroup、Column、Row、Card、Markdown）都是手写。
每次新增 wrapper 约 60 行模板代码，参数签名与 Panel 原生类保持同步是一个维护问题。

## 对 doctor_panel.py 的评价

### 优点
- 728 行，5 个子命令（list/doctor/verify/namespace/query），职责清晰
- `run_checks()` / `run_verify()` / `_run_namespace_checks()` 被 CLI 和测试复用，避免重复
- 排除/别名机制（`_COMMON_EXCLUDED`、`_WRAPPER_EXCLUDED`、`_WRAPPER_PARAM_MAP`）设计合理

### 可改进
1. 配置数据与代码混在一起（`_WRAPPER_SPECS`、排除、别名），wrapper 超过 15 个后会失控
2. `list` 命令（扫描 pn 下级目录）与 `doctor`/`verify`（硬编码 `_WRAPPER_SPECS`）的发现方式不一致
3. `_generate_test_value` 的 if-elif 链（~50 行）可改为表驱动
4. `doctor` 和 `verify` 有大量重复的基础设施（排除参数查找、别名映射）
5. 可以考虑合并 `doctor` + `verify` 为一个 `check` 命令

## 代码生成可行性分析

### wrapper 代码模式分类

| 类型 | 继承链 | 特性 | 可模板化率 |
|------|--------|------|------------|
| 容器（Column/Row/Card） | `_PanelContainerMixin, UIComponent, pn.Xxx` | `*children` + 全部透传 + `_panel_container=True` + `__enter__/__exit__` | ~90% |
| 非信号 widget（Button） | `UIComponent, pn.Xxx` | 全部透传 + 别名映射 | ~85% |
| 信号 widget（TextInput/RadioButtonGroup） | `UIComponent, pn.Xxx` | 全部透传 + signal + value getter/setter + event bridge | ~85% |
| 非交互 pane（Markdown） | `UIComponent, pn.Xxx` | 全部透传 + 可能的位置参数（`object`） | ~85% |

### 可模板化的部分（~85%）
- `__init__` 参数签名（从 `panel_cls.param` 提取）
- 参数类型注解与默认值
- `UIComponent.__init__(self)` 调用
- `pn.Xxx.__init__(self, ...)` 透传
- `css_classes or []` / `styles or {}` 等 list/dict 参数的 fallback
- 容器：`_panel_container = True` + `__enter__/__exit__`
- 信号 widget：`signal` 初始化 + `value` property + `_setup_event_bridge`

### 必须手写的部分（~15%）
- **默认值覆盖**：Card 的 `css_classes=["card"]`、Markdown 的 `extensions=["extra", ...]`、TextInput 的 `width=300`
- **别名映射的值回退逻辑**：`color if color != "default" else button_type`
- **Pane 的第一个位置参数**（如 `object`）

## 方案讨论

### 方案 A：生成完整子类文件
生成器输出完整的 `.py` 文件到 `src/`，覆盖写入。
默认值覆盖和别名映射集中在注册表中配置，不放在生成的 .py 里。

**优点**：和现有文件格式一致，零新概念。
**缺点**：重跑生成会覆盖手动修改；默认值覆盖需要提前预判。

### 方案 B：生成抽象父类
生成一个 `_PanelComponentBase` 父类，把可模板化的逻辑收进去。

**缺点**：失去静态类型签名（`**kwargs`），违背 doctor 工具"强类型化"的核心理念。
**结论**：不可行。

## 决策

**先由 AI 手工生成所有组件，积累数据后再评估是否需要工具生成。**

理由：
- 当前只有 7 个 wrapper，数据不够判断哪些默认值覆盖是"常见的"
- 大规模实现过程中会发现更多模式变化
- 数据充分后（30+ wrapper）再做工具生成，设计和投入更准确

---

## 参考
- `tools/doctor_panel.py` — 诊断工具
- `src/diyui/providers/panel/` — 现有 wrapper 实现
- `tests/test_panel_param_coverage.py` — 参数一致性 + 透传测试
