---
module: ts-xxui
type: task-list
status: open
author: chen56 + ai
last_updated: 2026-05-12
---

# ts-xxui 多会话实施任务清单

本文档组织多次会话的任务，每完成一个标记 ✅。新会话按序号执行。
每个任务都是**独立可验收**的最小单元，会话间保持上下文文件引用即可。

---

## 会话 1：搭建项目骨架 + pi-tui 接口检查工具

### 任务 1.1 创建项目结构

```
xxui/ts-xxui/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts            # 空占位，导出空对象
├── tools/
│   └── check-pitui.ts      # pi-tui 接口检查工具（见任务 1.2）
├── examples/
│   └── (空)
└── tests/
    └── (空)
```

- 依赖: `@mariozechner/pi-tui`, `@vue/reactivity`（reference: `xxui/ts-xxui/docs/ts-xxui-design-v0.2.md` 第 12 节）
- ESM, NodeNext 模块解析
- 执行 `npm run check` 通过

### 任务 1.2 实现 tools/check-pitui.ts

参考 `xxui/py-xxui/tools/check_panel_params.py` 的设计：
- 从 `@mariozechner/pi-tui` 导入所有公开组件类
- 对每个类输出三个信息：
  1. **构造函数签名** — 参数名、类型、默认值
  2. **公开方法签名** — 排除 `_` 开头的方法、排除基类通用方法
  3. **是否实现 Component 接口** — 检查 `render`/`handleInput`/`wantsKeyRelease`/`invalidate`
- 输出为 TypeScript 类型定义风格，便于直接复制到 wrapper 代码
- 命令行参数: `--class Text` 过滤单个类, `--list` 列出所有类, `--methods Text` 查看方法签名

#### pi-tui 默认组件清单（以 `@mariozechner/pi-tui` exports 为准）

| 类名 | 类型 | 母的 |
|------|------|------|
| `Text` | Component | 多行文本，含 word wrap、padding、cache |
| `TruncatedText` | Component | 单行截断文本 |
| `Box` | Component + Container | 带 padding/bg 的容器 |
| `Input` | Component + Focusable | 单行文本输入 |
| `Editor` | Component + Focusable | 多行编辑器 |
| `SelectList` | Component | 选择列表 |
| `SettingsList` | Component | 设置列表 |
| `Spacer` | Component | 空白填充 |
| `Loader` | extends Text | 加载动画 |
| `CancellableLoader` | extends Loader | 可取消加载动画 |
| `Markdown` | Component | Markdown 渲染 |
| `Image` | Component | 终端图片 |
| `TUI` | extends Container | 主 TUI 循环、渲染 |
| `Container` | Component | 基础容器 |

### 任务 1.3 生成 pi-tui 接口参考文件

运行 `check-pitui.ts --all`，将输出保存为:
```
xxui/ts-xxui/docs/ref-pitui-interfaces.md
```

这份文件是**只读参考**，后续会话编写 wrapper 时引用。

---

## 会话 2：实现 Signal + ScopeNode + Context 栈

### 任务 2.1 实现 Signal<T>

参考 `xxui/ts-xxui/docs/ts-xxui-design-v0.2.md` 第 3 节。

- `src/signal.ts`：`Signal<T>` 类，包装 `@vue/reactivity` 的 `ref`
- `get value()` / `set value()` — `Object.is` 等值跳过
- 不暴露 `Ref` 类型
- 单元测试：`tests/signal.test.ts`

### 任务 2.2 实现 ScopeNode + ScopeConfig

参考设计文档第 6 节。

- `src/scope.ts`：`ScopeNode` 基类、`ScopeConfig`
- `parent`、`children`、`config` 属性
- `getEffectiveScheduler()`、`getEffectiveMode()` 向上查找
- `clearChildren()`、`replaceChildren()`、`registerSignal()`
- 单元测试：`tests/scope.test.ts`

### 任务 2.3 实现 Context 栈

参考设计文档第 4 节。

- 在 ScopeNode（或单独模块）实现 `contextStack` 管理
- `pushContext` / `popContext` / `currentContext`
- 单元测试：`tests/context.test.ts`

---

## 会话 3：实现 UIComponent + App + Basic Components

### 任务 3.1 实现 UIComponent 基类

参考设计文档第 7.1 节。

- `src/components.ts`：`UIComponent extends ScopeNode implements Component`
- `abstract render(width: number): string[]`
- `handleInput?`、`wantsKeyRelease?`、`invalidate()`
- 区分 `ContainerComponent`（可挂载子 UI）和 `LeafComponent`（不可）

### 任务 3.2 实现 App 根节点

参考设计文档第 7.3 节。

- 持有 pi-tui `TUI` 实例
- 组件工厂方法：`text()`, `label()`, `column()`, `row()`, `button()`, `spacer()`
- `signal<T>(initial): Signal<T>`
- `mount()`, `run()`, `stop()`
- 参考 `ref-pitui-interfaces.md` 中 pi-tui 组件的构造参数

### 任务 3.3 实现基础组件

- `Text` — 包装 pi-tui `Text`
- `Label` — 便捷字符串版本
- `Column` — 竖向容器，自定义 `render` (顺序排列 children)
- `Row` — 横向容器，自定义 `render` (平均分配宽度)
- `Box` — 包装 pi-tui `Box`
- `Button` — 基于 `Text` 的按钮样式（v0.1 只做样式，不做 onClick 事件分发）
- `Spacer` — 包装 pi-tui `Spacer`

---

## 会话 4：实现 Cell + Scheduler

### 任务 4.1 实现 CellHost

参考设计文档第 5 节。

- `src/cell.ts`：`CellHost<T extends ScopeNode>`
- `.cell(fn)` — 标记 ScopeNode 为 rerun 块
- staging rerun：清空 children → 执行 fn → 失败恢复旧 children
- 首次定义时立即执行

### 任务 4.2 实现 Scheduler

参考设计文档第 9 节。

- `src/scheduler.ts`：`Scheduler` 接口
- `ImmediateScheduler` — dev 默认，立即执行
- signal 写入 → scheduler.schedule(cell) → cell.rerun()

### 任务 4.3 集成 vue effect

参考设计文档第 10.3 节。

- `App.mount()` 内用 `effect()` 包裹 rerun 逻辑
- cell 读取 signal.value → vue 自动注册依赖 → signal 变化触发 effect → scheduler → rerun
- `app.run()` 启动 pi-tui event loop

---

## 会话 5：验收示例 + 端到端验证

### 任务 5.1 写验收示例

参考设计文档第 11 节，对照 `packages/xx-tui/examples/`：

| ts-xxui 示例 | 对应 xx-tui 范例 | 验证目标 |
|-------------|-----------------|---------|
| `examples/counter.ts` | — | 最小验证：signal + cell + rerun |
| `examples/reactive_demo.ts` | `reactive_example.ts` | 计数器 + 定时器 + 输入联动 |
| `examples/chat_demo.ts` | `example.ts` | chat 面板 + 消息列表 cell + button 互动 |

### 任务 5.2 写单元测试

- `tests/signal.test.ts` — 等值跳过、依赖追踪
- `tests/scope.test.ts` — config 继承、scope violation
- `tests/cell.test.ts` — rerun、错误保留、原子组件子 UI 报错
- `tests/scheduler.test.ts` — 去重、深度排序

---

## 附录 A：每会话需要的上下文文件（只读引用）

新会话开始时，读取以下文件即可获知全部设计：

```
xxui/ts-xxui/docs/ts-xxui-design-v0.2.md          # 主设计文档
xxui/ts-xxui/docs/ts-xxui-sessions.md              # 本任务清单
xxui/ts-xxui/docs/ref-pitui-interfaces.md          # pi-tui 接口参考（会话 1 生成）
xxui/py-xxui/docs/py-xxui-init-design/2026-05-05_ai_codex_development_spec_v0.1.md  # py 版开发规格
```

加上项目代码本身即可，不需要加载 py-xxui 源码。

## 附录 B：参考设计文档的关键节号速查

| 内容 | 设计文档节号 |
|------|------------|
| API 面貌与最小示例 | §1 |
| Signal API 与实现 | §3 |
| Context 栈与构树 | §4 |
| Cell 机制 | §5 |
| ScopeNode 配置树 | §6 |
| UIComponent 与 App 工厂 | §7 |
| 组件清单 | §8 |
| Scheduler | §9 |
| App 生命周期 | §10 |
| 验收示例 | §11 |
| 实施步骤 | §12 |
| pi-tui 接口参考 | `docs/ref-pitui-interfaces.md` |
