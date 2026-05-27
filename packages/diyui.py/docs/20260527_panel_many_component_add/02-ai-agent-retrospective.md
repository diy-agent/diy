# AI Agent 辅助 Panel 组件封装 — 经验总结

> 编写日期：2026-05-27
> 会话跨度：约 6 小时，覆盖 wrapper 生成→调试→demo 验证→panel serve 全链路
> 涉及范围：106 个 wrapper 修复，11 个 demo 文件，9 个 wrapper 运行时错误修复

---

## 一、关键教训

核心要点：
最大教训：runpy 通过 ≠ panel serve 正常。Bokeh 渲染阶段的错误（类型校验、_get_model、_process_param_change）只能通过 panel serve 或直接调用 _get_model(doc) 发现。
三个最值得做的改进：
1. _get_model 渲染测试 — 不启动 HTTP server，直接调用 Panel 的完整渲染链路，比 panel serve 快得多
2. Generator 后验证 Hook — 生成 wrapper 后自动对比 Panel 源码，对齐参数类型和默认值
3. 错误模式库 — 将本次遇到的 5 种错误模式固化到工具中，AI 可以自动匹配修复
文档里还有对 diydev 的 5 个具体工具建议（Panel Runtime Inspector、渲染测试套件、后验证 Hook、错误分类库、SHA 集成），以及对项目结构和 AI 工作流的优化建议。

### 1. "Import 通过 ≠ 运行正常" 的鸿沟

这是本次会话最大的教训。`runpy.run_path()` 只执行 Python 代码，**不触发 Bokeh 模型创建**，大量错误只在 `panel serve` 的 Bokeh 渲染阶段出现：

| 错误类型 | 只在 panel serve 出现 | runpy 能捕获 |
|---------|----------------------|------------|
| 类型错误（`int` vs `str`） | ❌ 通过 | ✅ |
| Bokeh 参数校验失败 | ✅ | ❌ |
| Panel `_process_param_change` 异常 | ✅ | ❌ |
| `_get_data` / `_get_model` 运行时错误 | ✅ | ❌ |
| 缺少依赖（ECharts 等） | ✅ | ✅ 有 warning |

**结论**：必须有一个 `panel serve` 级别的集成测试，不能只靠 import 测试。

### 2. Panel 的 "隐式契约" 很脆弱

Panel 的很多组件对不同参数有隐式期望，文档不一定明确：

- **`tick_size`**：Panel 声明 `param.String(default="10")`，但 Bokeh 3.4+ 要求带单位的字体大小（如 `"10pt"`）—— 传 `"10"` 直接崩。实际安全默认是 `None`。
- **`Dial.height`**：Panel 默认 `250`，但如果 wrapper 显式传 `height=None`，会覆盖 Panel 默认，导致 `None/400` 崩溃。
- **`ColorMap.options`**：Panel 示例用 `{"Reds": ["white", "red"]}`（值是颜色列表），但 generator 生成的类型是 `dict[str, str]`，运行时传给 Bokeh 的 `PaletteSelect.items` 后校验失败。
- **`ArrayInput.value`**：`_process_param_change` 调用 `value.size`，期望 numpy 数组，传 `list` 会 AttributeError。
- **`GridSpec` / `GridStack`**：不继承 `ListLike`，没有 `append`/`remove`，但 generator 统一加了 `_PanelContainerMixin`。

### 3. Panel 的 "new" 工厂方法需要特殊处理

`pn.widgets.NumberInput` 和 `pn.widgets.ToggleGroup` 等组件有 `__new__`，会根据参数返回不同子类。我们的 wrapper 继承它们时：
- 如果 MRO 不正确，`__new__` 可能返回错误类型
- 需要避免使用 `super().__init__` 的常规 param 模式

### 4. 只读参数（read-only params）需要显式排除

Panel 的部分参数被标记为 `constant=True` 或 `readonly=True`：
- `Divider.width_policy`、`Divider.height_policy`
- `HSpacer.sizing_mode`、`VSpacer.sizing_mode`

Generator 没有识别这些，导致 wrapper 的 `__init__` 中显式传值引发错误。

---

## 二、当前 AI Agent 开发工作流的问题

### 1. 验证回路中断

当前流程：
```
wrapper 生成 → runpy import 验证 → panel serve 手动验证
                                                  ↑
                                          这里是最关键的验证环节，
                                          但完全依赖人工查看
```

需要的是：
```
wrapper 生成 → runpy import 验证 → panel serve 自动化渲染验证
                                        ↑
                                  (用 Playwright 或 Bokeh 协议)
```

### 2. 错误恢复成本高

每次发现一个新错误，AI agent 需要：
1. 理解错误栈（可能跨 Panel/Bokeh/Python 三层）
2. 定位到 wrapper 文件
3. 分析 Panel 源码确定正确 API
4. 修改 wrapper 或 demo
5. 重新验证

其中第 3 步成本最高 —— AI 无法直接"观察" Panel 的运行时行为，只能静态分析源代码。

**建议**：提供一个 Panel 运行时反射工具，让 AI 可以查询：
- 给定参数名的实际类型和默认值
- 某个类有哪些 read-only 参数
- 某个方法在渲染时会被调用

### 3. 缺少渐进式测试

我们的测试只有 `runpy` 的 "一把梭"。应该分层：
```
L0: param 类型检查 (当前 test_panel_param_coverage.py)
L1: init 不抛异常 (当前的 runpy)
L2: _get_model 不抛异常 (新增)
L3: panel serve 启动不报错 (新增)
L4: 页面渲染无 JS 错误 (用 Playwright, 新增)
```

### 4. demo 文件与 wrapper 文件的依赖关系不明确

- demo 使用 `app.widgets.dial(value=...)` 间接创建 wrapper
- 如果 factory method 有 `**kwargs`，类型错误只能运行时发现
- 没有一个地方明确记录 "wrapper A 的 demo 在 demo_B.py 中"

---

## 三、针对 `diydev` 的工具建议

### 3.1 Panel Runtime Inspector

一个 CLI 工具，能查询 Panel 组件在运行时的实际行为：

```bash
# 查询某个参数的实际 Bokeh 映射
diydev panel inspect pn.widgets.Dial tick_size
# → param.String(default=None), 映射到 Bokeh: major_label_text_font_size
# → 注意：Bokeh 3.4+ 要求带单位的字体值

# 列出所有 read-only 参数
diydev panel readonly pn.widgets.Divider
# → width_policy (constant=True), height_policy (constant=True)

# 对比 wrapper 与 Panel 的参数差异
diydev panel diff _dial.py
# → height: wrapper=Optional[int]=None, Panel=Optional[int]=250  ← 差异!
```

### 3.2 渲染测试套件

```bash
# 启动 panel serve，加载所有 demo，检查是否报错
diydev test render examples/demo_*.pn.py
# → 启动 Bokeh server → 对每个 app 调用 _get_model → 收集异常
```

实现思路：不启动真正的 HTTP server，而是直接调用 Panel 的 `_get_model(doc)` 并捕获异常。这样比 `panel serve` 快得多，且不需要网络端口。

```python
from bokeh.document import Document
doc = Document()
try:
    app.get_root(doc)  # 触发完整渲染链路
except Exception as e:
    # 收集错误
```

### 3.3 Generator 后验证 Hook

在 `_generate_wrappers.py` 生成 wrapper 后，自动插入一组验证脚本：

```bash
# 验证所有 wrapper 的 init 参数
diydev test init src/diyui/providers/panel/widgets/
# → 对每个 wrapper 调用 __init__，检查默认值是否能通过 Panel 的 param 校验

# 验证所有 wrapper 的 _get_model
diydev test model src/diyui/providers/panel/widgets/
# → 创建实例，调用 _get_model(doc)，捕获 Bokeh 校验错误
```

### 3.4 错误分类与修复模式库

从本次会话中总结的错误模式，可以建立库：

| 错误模式 | 检测方式 | 修复方式 |
|---------|---------|---------|
| `ValueError: ... is not a valid font size value` | Bokeh 字体校验 | tick_size 等参数默认值设为 None |
| `'list' object has no attribute 'size'` | runpy 或 model | 传 numpy 数组或用 `.tolist()` |
| `unsupported operand type(s) for /: 'NoneType' and 'int'` | render 时 | height 默认值匹配 Panel 默认 |
| `expected an element of Seq(Tuple(String, Seq(Color)))` | Bokeh items 校验 | options 值的类型改为 `list[str]` |
| `failed to validate ... items` | Bokeh 校验 | 同上 |

### 3.5 SHA 脚本集成

`sha.sh` 是一个好起点，但可以更智能：

```bash
# 简化命令
diydev demo serve          # → panel serve --dev examples/demo_*.pn.py
diydev demo test           # → 先 runpy 再 _get_model 渲染验证
diydev demo add <name>     # → 创建新的 demo 文件骨架
diydev demo check <file>   # → 对单个 demo 做全链路验证
```

---

## 四、项目层面的建议

### 4.1 为 AI Agent 优化项目结构

- **`AGENTS.md`**：已有，很好。但应该加入具体的测试命令、常见错误模式等。
- **`CLAUDE.md` / `QWEN.md` / `GEMINI.md`**：每个 AI 的工具和技术栈不同，分别配置是好的实践。
- 但这些文件目前只是位置标记，内容可能是空的或有待完善。

### 4.2 明确 "什么该提交" 的边界

本次会话中，`git status` 显示大量变更（22 modified + 90+ untracked），很多是之前的未完成工作。AI agent 经常难以判断哪些变更属于本次任务。

- 建议将 "未完成的中间工作" 用 `.gitignore` 或 本地分支隔离
- 或者在工作流中引入 "clean checkpoint" 概念 —— 开始新任务前确保工作区干净

### 4.3 Panel 版本锁定

本次遇到的 `tick_size` 问题和 Bokeh 字体校验是在 Panel 1.9 / Bokeh 3.4+ 引入的。如果项目有锁定的 Panel 版本：
- `pyproject.toml` 应明确版本约束
- Generator 应知道目标 Panel 版本的 API 差异
- 测试应针对锁定版本运行

### 4.4 文档与工具的统一入口

当前：
```
docs/              ← 设计文档
tools/             ← 生成/诊断脚本
sha.sh             ← 快捷命令
diydev/            ← 辅助工具包
```

建议明确分层：
- `docs/`：只放不可执行的文档
- `tools/`：可执行的开发脚本（生成、测试、诊断）
- `diydev/`：通用开发辅助 CLI（项目无关，可复用）
- `AGENTS.md`：AI agent 的入口指南，告诉 AI 有哪些工具可用

---

## 五、本次会话中验证有效的实践

1. **`tools/doctor_panel.py` 的 `_PARAM_TEST_VALUE_OVERRIDES`**：这个机制很有效 —— 对特殊参数提供测试值，避免默认值引起的问题。
2. **直接调用 `pn.widgets.Xxx` 做对比测试**：当 wrapper 行为异常时，创建原生 Panel 对象对比，快速定位问题。
3. **渐进式修复**：先让 runpy 通过，再修 panel serve 错误 —— 每一步都有可验证的 checkpoint。
4. **`_get_model` 测试**：虽然不是完全自动化的，但手动调用 `_get_model(doc)` 能快速验证渲染错误，比启动 `panel serve` 快得多。

---

## 六、总结

本次会话覆盖了从 wrapper 生成到 demo 验证的完整链路，最大的收获是认识到 "import 通过 ≠ 运行正常"。

**最优先需要解决的问题**：
1. 添加 `_get_model` 级别的渲染测试（不需要启动 HTTP server）
2. 在 generator 中添加 read-only 参数的检测和排除
3. 在 generator 中添加参数类型与 Panel 源码的自动对齐

chen56: 可能需要回顾构造器传递的问题，我们是否真的能够保证参数定义和传递的有效性？因为Panel所有参数均由param定义，而param的定义有时比较松散，比如只在文档中说明了部分参数类型[],其实又在文档中说明了更细致的类型比如[{"":[...]}] ， 如果只是强化参数静态类型，是否别的方案（类型描述）就可以？
另外param这种声明型和pydandic的类型定义很像，缺省值可能（未调查）会携带一个工厂函数？那利用pydandic是否ok？

**中等优先级**：
1. 错误模式库，加速 AI 的修复流程
2. 分层测试体系（L0-L4）

**长期方向**：
6. `diydev` 统一 CLI，整合所有工具
7. Playwright 端到端渲染测试
