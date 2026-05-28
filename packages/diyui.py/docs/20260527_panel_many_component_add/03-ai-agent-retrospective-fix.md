# AI Agent 修复测试错误 — 体会与建议

> AI Agent: Claude (Anthropic) via pi coding agent
> 日期: 2026-05-28
> 任务: 修复 `./sha.sh test` 的 16 个测试失败
> 涉及: 28 个文件变更，3 大类问题

---

## 一、错误分类与修复路径

### 问题 1: `signal` 属性断链（12 个测试）

**现象**: `AttributeError: 'function' object has no attribute 'value'` / `'method' object has no attribute 'value'`

**根因**: 昨天 opencode 重构时把 widget 的 Signal 从 `self.signal` 移到 `self.diy.signal` 命名空间，但只改了写的地方，没暴露读的接口。`ScopeNode.signal()` 是一个**方法**（创建 scope signal），widget 子类覆盖这个属性后就丢了对外暴露的 property。

**修复**: 在 `UIComponent` 基类加 `signal` property，从 `self.diy.signal` 读取。这是所有 widget 共用的入口点。

**体会**: 重构时如果改变了属性的语义（method → storage），全量 grep 替换是不够的——需要建立**双向映射**：存储位置 + 访问接口都要更新。AI agent 应该被提示检查"谁在读这个属性"。

### 问题 2: `target` 属性消失（4 个测试）

**现象**: `AttributeError: 'Button' object has no attribute 'target'`

**根因**: 新模型中 wrapper 继承 Panel 原生类，本身就是实例，不再需要 `.target`。

**修复**: 测试改为直接断言 `isinstance(btn, pn.widgets.Button)`。

**体会**: 这是合理的 API 简化，但测试没同步更新。反映了**测试作为 API 合约**的价值：测试失败 == API 变化，应该引起关注。

### 问题 3: 参数覆盖缺口（3 个测试）

**现象**: 5 个 Panel 参数缺少显式定义，2 个透传验证失败。

**根因**: 
- **只读参数遗漏**: Divider 的 `width_policy`/`height_policy`、HSpacer/VSpacer 的 `sizing_mode`、DatetimeSlider 的 `value_throttled` 没有加入 `_WRAPPER_EXCLUDED`。昨天的文档已指出这个问题，但排除列表没更新。
- **Panel 内部行为误报**: `DataFrame.classes=[]` 被 Panel 追加 `['panel-df']`，`CodeEditor.disabled=True` 构造后状态变了。这些在 `_PARAM_TEST_VALUE_OVERRIDES` 中标记 `_NO_VALUE` 跳过即可。

**修复**: 排除和覆写列表增量更新。

**体会**: `doctor_panel.py` 工具很好用，但排除列表需要**回环验证**——新增 wrapper 后必须重跑 doctor/verify。当前缺乏自动触发机制。

### 额外问题: `_init_done` 引用陈旧（22 个文件）

**现象**: 手动 wrapper 的 value setter 中 `getattr(self, "_init_done", False)` 永远为 False，导致写入后 Panel param 不同步。

**根因**: 重构时 `init_done` 移到了 `self.diy.init_done`，但生成器模板更新了、手动 wrapper 没更新。

**修复**: 批量 `sed` 替换 22 个文件。

**体会**: **生成器 vs 手动代码的分歧**是 bug 制造机。22 个手动 wrapper 文件意味着 `_generate_wrappers.py` 没有覆盖所有 widget。应该考虑让生成器覆盖 100%，删除手动文件。

---

## 二、与昨天文档的对照

昨天 opencode 总结的教训，今天全部被验证：

| 昨天提出的问题 | 今天的实际表现 |
|--------------|--------------|
| 验证回路中断 | `sha.sh test` 之前没人跑，16 个失败累积 |
| 重构移动属性缺少检查 | `self.signal` → `self.diy.signal` 只改了 set 没改 get |
| 只读参数需要显式排除 | 文档写了但排除列表没更新，测试挂了 |
| 手动 wrapper vs 生成器的分歧 | `_init_done` 生成器对了、手动错了，22 个文件 |
| 错误模式库应该建立 | 今天的 3 类错误都是昨天模式的延伸 |

**结论**: 昨天的文档诊断完全正确，但诊断 ≠ 修复。今天的修复本质上是在执行昨天的建议，并验证了它们的正确性。

---

## 三、AI Agent 修复工作流的体验

### 3.1 做得好的

- **错误分组**: 一眼看出 16 个失败分属 3 种模式，不是 16 个独立问题
- **`doctor_panel.py` 诊断**: 在修改排除列表后用 `doctor` 命令快速验证，迭代很快
- **批量修复**: `sed` 改 22 个文件比手动改好得多（人为错误风险低）

### 3.2 做得不好的

- **没有先看文档**: 如果先读了昨天的 retrospective，就能立刻理解 `self.diy.signal` 的前因后果，减少调查时间
- **代码考古耗时**: `git show 414fe93:...` 查历史代码来理解"正确行为应该是什么"，这步应该在项目文档中留下记录
- **`_init_done` 问题发现较晚**: 是在 signal property 修复通过后的第二轮测试才暴露的。如果第一轮跑全部测试（而不是 `-x` 早停），能一并发现

### 3.3 建议改进

1. **上下文加载时自动包含相关 docs/ 目录**：`AGENTS.md` 应提示 agent 在任务开始前阅读 `docs/` 下的最新 retro。

2. **测试失败分类辅助工具**：如果有一个工具把 pytest 输出按错误类型自动分组（`AttributeError: signal` vs `AssertionError: missing params`），agent 能更快定位。

3. **"最后已知正常"快照**：`sha.sh test` 应该在一个 `pre-commit` hook 或 CI 中强制运行。16 个失败累积说明缺少门控。

4. **消除手动 wrapper**：`_generate_wrappers.py` 应该覆盖所有 widget。手动维护的 20+ 个文件是持续性问题源。

---

## 四、对 `diydev` / 工具的追加建议

### 4.1 `doctor_panel.py` + pre-commit hook

```bash
# 建议在 pre-commit 或 ./sha.sh test 中首先运行：
uv run python tools/doctor_panel.py doctor   # 参数覆盖率
uv run python tools/doctor_panel.py verify   # 透传验证
```

如果这两个命令失败，后续测试基本也是白跑。

### 4.2 生成器覆盖检查

```bash
diydev check wrappers --generated-vs-manual
# → 列出所有 wrapper 文件，标注生成 vs 手动
# → 高亮手动文件中与生成模板不一致的部分
```

### 4.3 属性迁移追踪

如果 `diy` 命名空间是长期方案，建议在 `_DiyData` 类中加一个迁移检查：

```python
class _DiyData:
    # ...
    signal: object = None
    # 可加一个 descriptor 在 __get__ 时打 warning 如果外部代码
    # 试图从错误路径访问（如仍然用 getattr(self, '_init_done', ...)）
```

---

## 五、总结

今天的修复工作验证了昨天诊断的正确性。三个模式（属性断链、API 简化测试同步、只读参数排除）都源于同一个根因：**重构的传播不完整**。

对 AI agent 而言，最大收获是：
- **先读最近的 retro/doc**，理解上下文，避免考古
- **跑全量测试**（不用 `-x` 早停），一次看到所有失败
- **批量修复优于逐个修复**，减少遗漏

对项目而言：
- 100% 生成器的覆盖可以消除手动 wrapper 的 bug 源
- `doctor_panel.py doctor` 应该成为 `test` 的前置条件
- `_init_done` 级别的属性位移应配套迁移脚本或 lint 规则
