---
module: ts-xxui
version: v0.2
status: draft
based_on: v0.1 + chen56 review
author: chen56 + ai
last_updated: 2026-05-12
---

# ts-xxui 设计文档 v0.2

## 0. 目标与定位

在 pi-tui 之上封装一层薄薄的 UI 框架，借鉴 py-xxui 的核心思维：
- **声明即注册**：`app.button("-1")` 创建即挂载到当前上下文
- **Signal 响应式状态**：基于 `@vue/reactivity`，不直接暴露 vue 原语
- **树形 ScopeNode**：组件树同时也是运行时配置树（scheduler、debug、notification scope）
- **Cell rerun**：以函数/闭包为 rerun 单位，signal 变化自动重执行

**定位**：浅包装 + 新风格 + ScopeNode。可集成多种不同风格框架，不是最大公约数封装。
**不是**：重做 pi-tui、做 Virtual DOM、统一所有 TUI 框架。

**验收目标**：实现 `packages/xx-tui/examples/` 的同等范例：
- `reactive_example.ts` — 计数器 + 输入联动
- `example.ts` — chat bubble + slash command 面板
- `styling_example.ts` — 样式组件

> ts-xxui 是独立项目，**不在 `packages/xx-tui/` 里改**，而是新建 `xxui/ts-xxui/` 包。

---

## 1. 核心 API 面貌

### 1.1 App 是框架特定的

不同于 py-xxui 统一的 `App(provider=...)` 模式，TS 版 **App 是特定于某一框架的类**，直接从对应路径 import：

```typescript
// pi-tui 框架
import { App } from "xxui/providers/pi-tui";

const app = new App({
  mode: "dev",
  scheduler: new ImmediateScheduler(),
});
```

不暴露独立的 Provider 对象，App 本身就是 pi-tui 的封装入口。

### 1.2 最小完整示例

```typescript
import { App, ScopeConfig, ImmediateScheduler } from "xxui/providers/pi-tui";

const app = new App({
  mode: "dev",
  scheduler: new ImmediateScheduler(),
});

// ── 布局 ──
app.column(() => {
  app.text("# 🧪 ts-xxui Demo");

  // 输入组件：wrapper.value 即 signal 值，事件自动桥接
  const nameInput = app.textInput({ name: "Name", value: "World" });
  const multiplierInput = app.radioButtonGroup({
    name: "Multiplier",
    options: { x1: 1, x2: 2, x5: 5 },
    value: 1,
  });

  // 响应式 cell：读 wrapper.value → 自动追踪依赖，变化时 rerun
  app.column().cell((node) => {
    app.text(`## Hello **${nameInput.value}** × ${multiplierInput.value} !`);
    app.text(`Repeated: ${"🔥".repeat(multiplierInput.value)}`);
  });

  // 计数器：手动绑按钮事件
  const counter = app.signal(0);

  app.row(() => {
    app.button({ name: "-1" }).onClick(() => {
      counter.value = counter.value - 1;
    });
    app.button({ name: "+1" }).onClick(() => {
      counter.value = counter.value + 1;
    });
  });

  app.column().cell((node) => {
    app.text(`Counter: **${counter.value}**`);
  });
});

app.mount();
app.run();
```

### 1.3 对比 py-xxui 的语法差异

| 特性 | py-xxui | ts-xxui |
|------|---------|---------|
| 入口 | `PanelApp(config=...)` | `new App({ mode, scheduler })` |
| with 构树 | `with app.column():` | `app.column(() => { ... })`  — 回调函数替代 with |
| 容器 as 返回值 | `with app.column() as col:` | 容器方法返回自身，或回调参数 `app.box(props, (ctx) => ...)` |
| cell 装饰器 | `@app.column().cell()` | `app.column().cell((node) => { ... })` |
| signal 创建 | `app.signal(0)` | `app.signal(0)` |
| signal 读写 | `count.value` | `counter.value` — 通过 getter/setter 实现 |
| 按钮点击 | `button.on_click(lambda e: ...)` | `button.onClick(() => { ... })` |
| 暴露原生 | `button.target` | **不暴露 target**，直接集成 pi-tui |

### 1.4 三种构树形式

```typescript
// 1. 普通组件（立即挂载，非 rerun 块）
app.label("hello");
app.button({ name: "OK" });

// 2. 回调构建容器（TS 替代 with 的方案）
app.column(() => {
  app.text("child1");
  app.row(() => {
    app.button({ name: "A" });
    app.button({ name: "B" });
  });
});

// 2b. 回调参数形式（需要引用容器时）
app.box({ x: 1, y: 2 }, (ctx) => {
  // ctx 就是当前 box 的 ScopeNode wrapper
  app.label("hello");
  app.column((ui) => {
    app.button({ name: "Save" });
  });
});

// 3. Cell（rerun 块）
app.column().cell((node) => {
  // node 参数可选，无需引用时可省略
  app.text(`count = ${counter.value}`);
});
```

### 1.5 组件参数

TS 没有 Python 命名参数，统一用对象字面量。因为对 pi-tui 做浅封装，参数**按 pi-tui 原生组件规则确定**，不做抽象翻译：

```typescript
// 对象参数
app.text({ content: "hello" });           // 对标 PiText 参数
app.button({ name: "OK" });               // pi-tui 无原生 Button，自定义实现
app.textInput({ value: "", placeholder: "..." }); // 对标 PiInput 参数
```

pi-tui 原生组件的参数不同时，ts-xxui wrapper 按各自原生参数设计，不做跨组件统一。

---

## 2. 架构概览

```
┌─────────────┐    ┌──────────────────┐
│  Signal     │    │  ScopeNode 树     │
│  (@vue/     │◄───│  (runtime 配置)   │
│  reactivity)│    └────────┬─────────┘
└──────┬──────┘             │
       │                    ▼ dependency
       │           ┌──────────────────┐
       │           │  Context 栈       │
       │           │  (回调管理父节点)   │
       │           └────────┬─────────┘
       │                    │
       ▼                    ▼
┌─────────────┐    ┌──────────────────┐
│  Scheduler  │    │  UIComponent     │
│  (策略化调度) │    │  (pi-tui Component│
│  scope-aware│    │  直接集成, 无target)│
└──────┬──────┘    └────────┬─────────┘
       │                    │
       └────────┬───────────┘
                ▼
       ┌──────────────────┐
       │  PiTuiApp        │
       │  (App extends    │
       │   pi-tui logic)  │
       └──────────────────┘
```

### 2.1 核心抽象

| 层 | 职责 | 对应源码 |
|----|------|---------|
| **Signal** | 响应式状态容器，基于 `@vue/reactivity` `ref` | `signal.ts` |
| **ScopeNode** | 树节点，ownership、signal scope、scheduler lookup、debug boundary | `scope.ts` |
| **UIComponent** | 继承 ScopeNode，pi-tui Component 的直接子类 | `components.ts` |
| **Context** | 回调函数内的 `currentContext` 栈 | `scope.ts` |
| **Cell** | ScopeNode 上标记 rerun 能力的函数包装 | `cell.ts` |
| **App** | 根 ScopeNode + pi-tui TUI 生命周期 + 组件工厂 | `app.ts` |

### 2.2 UIComponent 不再持有 target

与 py-xxui 不同，ts-xxui 的 UIComponent **直接继承/实现 pi-tui 的 Component 接口**，不通过 `target` 代理：

```typescript
// py-xxui 风格（不采用）：
// class Button {
//   target: pn.widgets.Button;  // ❌ 代理人模式
// }

// ts-xxui 风格（采用）：
class Button extends ScopeNode implements Component {
  // 直接就是 pi-tui Component, render/handleInput 等直接实现
  render(width: number): string[] { ... }
  handleInput?(data: string): void { ... }
}
```

---

## 3. Signal 设计

### 3.1 基本 API

```typescript
const count = app.signal(0);          // scope 内创建
const name = app.signal("world");     // 字符串
const flag = app.signal(false);       // 布尔
const state = app.signal({            // 对象引用（浅对比）
  count: 0,
  inputValue: "",
});

// 读取（cell 内自动注册依赖）
console.log(count.value);

// 写入（触发 scheduler → rerun）
count.value = 1;
count.value += 1;

// 对象引用需整体替换（v0.1 不做 deep reactive）
state.value = { ...state.value, count: state.value.count + 1 };
```

### 3.2 实现：基于 `@vue/reactivity`

```typescript
// signal.ts
import { ref, type Ref } from "@vue/reactivity";

export class Signal<T> {
  private _ref: Ref<T>;

  constructor(initial: T) {
    this._ref = ref(initial) as Ref<T>;
  }

  get value(): T {
    return this._ref.value;
  }

  set value(v: T) {
    if (Object.is(v, this._ref.value)) return; // NaN 安全
    this._ref.value = v;
  }
}
```

对外不暴露 `Ref` 类型。`app.signal(0)` 返回 `Signal<number>`。

### 3.3 依赖追踪规则

- cell 执行期间读取 `.value` → 通过 vue `effect` 自动注册依赖
- cell rerun 前 vue effect 自动清空旧依赖并重新收集（动态依赖）
- 新旧值 `Object.is` 相等不触发 rerun
- 嵌套 rerun 中写 signal 只 enqueue，不递归
- v0.1 只支持整体替换，不做 deep reactive

### 3.4 Signal 作用域

```typescript
// signal 在 scope 内创建，隶属于当前 ScopeNode
app.column(() => {
  const secret = app.signal("left-only");
  // secret 的作用域是当前 column 及子树
});

// 子树外访问：dev 模式报错，prod 模式 warning（v0.1 暂记日志，不抛异常）
```

---

## 4. Context 栈与构树

### 4.1 回调函数式构树

```typescript
// TS 没有 with 语句，用回调函数建立父子上下文
app.column(() => {
  app.label("hello");           // 挂载到 column
  app.row(() => {
    app.button({ name: "A" });  // 挂载到 row
  });
});
```

Context 栈实现：

```typescript
class App extends ScopeNode {
  private contextStack: ScopeNode[] = [this];

  get currentContext(): ScopeNode {
    return this.contextStack[this.contextStack.length - 1];
  }

  /** 创建容器并推入 context 栈 */
  column(children: (ctx: Column) => void, config?: ScopeConfig): Column {
    const col = new Column(config, this.currentContext);
    this.contextStack.push(col);
    try {
      children(col); // 回调参数 ctx 就是当前 Column
    } finally {
      this.contextStack.pop();
    }
    return col;
  }
}
```

### 4.2 回调参数 ctx

容器回调接收当前 ScopeNode 作为参数，便于在闭包内引用：

```typescript
app.box({ x: 1, y: 2 }, (ctx) => {
  // ctx 就是当前的 Box ScopeNode
  ctx.config.scheduler; // 访问当前 scope 配置
  app.label("inside box");
});

// 不需要 ctx 时可省略参数：
app.column(() => {
  app.label("simple");
});
```

### 4.3 组件创建立即挂载

```typescript
// app.label("hello") 内部：
// 1. 创建 Label（extends ScopeNode implements Component）
// 2. 将 Label 加入 currentContext.children（ScopeNode 树）
// 3. 将 Label 加入 currentContext 的 pi-tui children（Component 树）
//    → piContainer.addChild(label)

// 不做延迟 render pipeline，不做 Virtual DOM。
```

---

## 5. Cell（rerun block）

### 5.1 Cell API

```typescript
// 容器 cell —— 可挂载子 UI
app.column().cell((node) => {
  app.text(`count = ${count.value}`);
});

// 原子组件 cell —— 只能更新自身属性
app.button({ name: "Run" }).cell((node) => {
  node.disabled = disableAll.value;
});

// 无参 cell —— 便捷形式
app.column().cell(() => {
  app.text("hello");
});
```

Cell 是 ScopeNode 上的一个标记 + 回调函数。定义时立即执行首次挂载。signal 变化时通过 scheduler 触发 rerun。

### 5.2 Cell Rerun 机制

```typescript
class CellHost<T extends ScopeNode> {
  fn: (node: T) => void;
  cellNode: T; // 被 .cell() 标记的 ScopeNode

  rerun(): void {
    // 备份旧 children
    const oldChildren = [...this.cellNode.children];

    // 推入 context 栈，staging
    this.app.contextStack.push(this.cellNode);
    try {
      // 清空当前 children（函数内重新创建）
      this.cellNode.clearChildren();
      this.fn(this.cellNode as T);
    } catch (e) {
      // 失败：恢复旧 children
      this.cellNode.replaceChildren(oldChildren);
      throw e;
    } finally {
      this.app.contextStack.pop();
    }
  }
}
```

### 5.3 Cell 限制

- 原子组件 cell 内调用 `app.xxx()` 挂载子 UI → dev 模式报错
- Cell 是同步执行，不做 async body
- 同一 flush 内同一 cell 去重

---

## 6. ScopeNode 配置树

### 6.1 ScopeConfig

```typescript
class ScopeConfig {
  mode?: "dev" | "prod";       // dev 开启 scope violation 检查
  scheduler?: Scheduler;        // rerun 调度策略
  maxRerunDepth?: number;       // 默认 100

  constructor(opts: Partial<ScopeConfig>) {
    Object.assign(this, opts);
  }
}

const app = new App({
  mode: "dev",
  scheduler: new ImmediateScheduler(),
});

// 子树覆盖
app.column((ctx) => {
  // 使用 immediate scheduler
}, { scheduler: new PeriodicScheduler(16) });
```

### 6.2 配置查找

从当前节点向上查找第一个有该配置的节点：

```typescript
class ScopeNode {
  config?: ScopeConfig;
  parent?: ScopeNode;

  getEffectiveScheduler(): Scheduler {
    if (this.config?.scheduler) return this.config.scheduler;
    return this.parent?.getEffectiveScheduler() ?? new ImmediateScheduler();
  }

  getEffectiveMode(): "dev" | "prod" {
    if (this.config?.mode) return this.config.mode;
    return this.parent?.getEffectiveMode() ?? "dev";
  }
}
```

### 6.3 ScopeNode 继承与职责

```
ScopeNode
├── 属性: parent, children, config, signal
├── 方法: getEffectiveScheduler(), getEffectiveMode(), clearChildren(), replaceChildren()
└── 子类:
    ├── App (根节点, 持有 TUI, contextStack, 组件工厂方法)
    └── UIComponent (implements pi-tui Component)
        ├── ContainerComponent (可挂载子 UI)
        │   ├── Column
        │   ├── Row
        │   ├── Box
        │   └── CellHost (标记为 rerun)
        └── LeafComponent (不可挂载子 UI)
            ├── Label / Text
            ├── Button
            ├── TextInput
            └── Spacer
```

---

## 7. UIComponent — pi-tui 直接集成

### 7.1 继承模式

UIComponent 同时继承 ScopeNode 和实现 pi-tui `Component` 接口：

```typescript
import { type Component } from "@mariozechner/pi-tui";

abstract class UIComponent extends ScopeNode implements Component {
  abstract render(width: number): string[];
  handleInput?(data: string): void; // pi-tui 可选接口
  wantsKeyRelease?: boolean;
  invalidate(): void {} // 子类可覆盖
}
```

### 7.2 容器组件示例

```typescript
class Column extends UIComponent {
  constructor(config: ScopeConfig | undefined, parent: ScopeNode) {
    super(config, parent);
    // 创建时立即挂载到父节点的 pi-tui children
    this.mountToParentProvider();
  }

  render(width: number): string[] {
    // 竖向排列 children
    const lines: string[] = [];
    for (const child of this.children) {
      const uiChild = child as UIComponent;
      lines.push(...uiChild.render(width));
    }
    return lines;
  }

  /** 推入 context 栈 + 执行回调 */
  static create(
    app: App,
    children: (ctx: Column) => void,
    config?: ScopeConfig
  ): Column {
    const col = new Column(config, app.currentContext);
    app.contextStack.push(col);
    try {
      children(col);
    } finally {
      app.contextStack.pop();
    }
    return col;
  }
}
```

### 7.3 App 组件工厂

```typescript
class App extends ScopeNode implements Component {
  // pi-tui 集成
  tui: TUI;
  contextStack: ScopeNode[] = [this];
  children: ScopeNode[] = [];

  // 组件工厂方法（声明即注册）
  text(opts: { content: string }): Text {
    const t = new Text(opts, this.currentContext);
    return t;
  }

  label(content: string): Label {
    const l = new Label(content, this.currentContext);
    return l;
  }

  button(opts: { name: string }): Button {
    const b = new Button(opts, this.currentContext);
    return b;
  }

  column(children: (ctx: Column) => void, config?: ScopeConfig): Column {
    return Column.create(this, children, config);
  }

  row(children: (ctx: Row) => void, config?: ScopeConfig): Row {
    return Row.create(this, children, config);
  }

  box(props: { x?: number; y?: number }, children: (ctx: Box) => void): Box {
    return Box.create(this, props, children);
  }

  signal<T>(initial: T): Signal<T> {
    const sig = new Signal(initial);
    // 挂载到当前 scope（用于 scope violation 检测）
    this.currentContext.registerSignal(sig);
    return sig;
  }
}
```

---

## 8. 组件清单（v0.1）

| ts-xxui 方法 | 对应 pi-tui 组件 | 类型 | 说明 |
|-------------|-----------------|------|------|
| `app.text({ content })` | `PiText` | Leaf | 文本显示 |
| `app.label(content)` | `PiText` | Leaf | 便捷文本，字符串参数 |
| `app.column(fn, config?)` | Container (竖向) | Container | 垂直布局 |
| `app.row(fn, config?)` | Container (横向) | Container | 水平布局，自定义 render |
| `app.box({ x, y }, fn)` | `PiBox` | Container | 带 padding/bg 的容器 |
| `app.button({ name })` | 自定义 | Leaf | pi-tui 无原生 Button，自定义实现 |
| `app.textInput({ value, placeholder? })` | `PiInput` | Leaf | 文本输入 |
| `app.spacer()` | `PiSpacer` | Leaf | 空白填充 |
| `app.markdown(content)` | `PiMarkdown` | Leaf | 若 pi-tui 有，否则降级为 text |

### 8.1 Button 实现方向

pi-tui 没有原生 Button。方案：

1. 基于 pi-tui `Text` 组件包装，用样式区分（类似 opencode 的 opentui 鼠标点击按钮效果）
2. 通过 pi-tui `handleInput` 接口监听键盘事件映射按钮热键
3. 预留 `.onClick()` 回调，事件分发由 App 协调（如数字键 1-9 映射到按钮）

v0.1 先实现样式展示，键盘事件映射后续完善。

---

## 9. Scheduler

### 9.1 接口

```typescript
interface Scheduler {
  /** 标记 cell 为脏，等待 rerun */
  schedule(cell: CellHost): void;
  /** 立即处理所有挂起的 rerun */
  flush(): void;
}

class ImmediateScheduler implements Scheduler {
  schedule(cell: CellHost): void {
    cell.rerun();
  }
  flush(): void {}
}

class PeriodicScheduler implements Scheduler {
  private dirty = new Set<CellHost>();
  private timer?: NodeJS.Timeout;

  constructor(periodMs: number = 16) {
    this.timer = setInterval(() => this.flush(), periodMs);
  }

  schedule(cell: CellHost): void {
    this.dirty.add(cell);
  }

  flush(): void {
    const cells = [...this.dirty];
    this.dirty.clear();
    // 按树深度排序：浅层先执行
    cells.sort((a, b) => a.depth - b.depth);
    for (const cell of cells) {
      cell.rerun();
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
```

### 9.2 作用域化调度

每个 ScopeNode 可有独立 scheduler：

```typescript
app.column((ctx) => {
  // 此子树用 immediate scheduler（高频实时更新）
  // signal 写入立即触发 rerun
}, { scheduler: new ImmediateScheduler() });
```

---

## 10. App 生命周期

### 10.1 构造与配置

```typescript
import { App } from "xxui/providers/pi-tui";

const app = new App({
  mode: "dev",                              // 必填
  scheduler: new ImmediateScheduler(),       // 可选，默认 Immediate
  maxRerunDepth: 100,                        // 可选
});
```

App 内部创建 pi-tui `TUI` 实例，自己作为根 `Component` 挂入。

### 10.2 mount 与 run

```typescript
// 1. 构建 UI 树（声明式，回调内调用 app.xxx() ）
app.column(() => {
  app.label("hello");
  app.button({ name: "OK" });
});

// 2. 挂载：将 UI 树的根 children 安装到 pi-tui TUI
//    同时设置 vue effect 实现响应式自动 rerun
app.mount();

// 3. 启动事件循环
app.run();
```

### 10.3 响应式自动刷新

```typescript
// app.mount() 内部：
// 用 vue effect 包裹根 rerun，cell 内读取 signal 时自动建立依赖：
// effect(() => {
//   app.rerunAllCells();  // cell 变化时自动执行
//   app.tui.requestRender();
// });
```

---

## 11. 验收示例

### 11.1 计数器 + 输入联动（对应 `reactive_example.ts`）

```typescript
import { App, ImmediateScheduler } from "xxui/providers/pi-tui";

const app = new App({ mode: "dev", scheduler: new ImmediateScheduler() });

const count = app.signal(0);
const name = app.signal("World");

app.column(() => {
  app.label("# 🧪 ts-xxui Reactive Demo");

  app.row(() => {
    app.button({ name: "-1" }).onClick(() => { count.value--; });
    app.button({ name: "+1" }).onClick(() => { count.value++; });
  });

  app.column().cell(() => {
    app.label(`Count: ${count.value}`);
    app.label(`Hello, ${name.value}!`);
  });
});

app.mount();
app.run();
```

### 11.2 Chat 面板（对应 `example.ts` 的核心结构）

```typescript
const messages = app.signal([] as string[]);
const inputValue = app.signal("");

app.column(() => {
  // Chat history（响应式列表）
  app.column().cell(() => {
    for (const msg of messages.value) {
      app.label(`> ${msg}`);
    }
  });

  app.row(() => {
    app.textInput({ value: inputValue.value, placeholder: "Type..." });
    app.button({ name: "Send" }).onClick(() => {
      if (inputValue.value.trim()) {
        messages.value = [...messages.value, inputValue.value.trim()];
        inputValue.value = "";
      }
    });
  });
});
```

### 11.3 样式示例（对应 `styling_example.ts`）

```typescript
app.column(() => {
  app.label("## Colors & Decorations");
  // pi-tui Text 支持 chalk 样式字符串
  app.text({ content: `${chalk.bgBlue.white(" Header ")}` });
  app.text({ content: `${chalk.yellow("Warning text")}` });
});
```

---

## 12. v0.1 实施计划

### 12.1 项目结构

```
ts-xxui/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # 公共导出（Signal, ScopeConfig, Scheduler 等）
│   ├── signal.ts             # Signal<T>（包装 @vue/reactivity ref）
│   ├── scope.ts              # ScopeNode, ScopeConfig, Context 栈管理
│   ├── scheduler.ts          # Scheduler 接口, ImmediateScheduler
│   ├── cell.ts               # CellHost — cell 标记 + rerun 逻辑
│   ├── components.ts         # UIComponent 基类, Column, Row, Box, Text, Label, Button ...
│   └── providers/
│       └── pi-tui.ts         # PiTuiApp extends App, pi-tui TUI 集成, 组件注册
├── examples/
│   ├── counter.ts            # 最小计数器验证
│   ├── reactive_demo.ts      # 对应 reactive_example.ts
│   └── chat_demo.ts          # 对应 example.ts 简化版
└── tests/
    └── signal.test.ts        # Signal 单元测试
```

### 12.2 实施步骤

| 步骤 | 内容 | 产出 |
|------|------|------|
| 1 | 搭建项目骨架 | `package.json`, `tsconfig.json`, 安装 `@mariozechner/pi-tui` + `@vue/reactivity` |
| 2 | 实现 Signal | `Signal<T>` 封装 `ref`，含 `Object.is` 等值跳过，scope 注册 |
| 3 | 实现 ScopeNode + Context | 父节点引用、config 查找、children 管理、contextStack |
| 4 | 实现 UIComponent 基类 | `implements Component`，`render`/`invalidate` 骨架 |
| 5 | 实现 PiTuiApp | 扩展 App，持有 TUI，`mount()` + `run()` |
| 6 | 实现基础组件 | `text()`, `label()`, `column()`, `row()`, `button()` |
| 7 | 实现 Cell | `.cell(fn)` 标记，staging rerun，错误保留 |
| 8 | 实现 Scheduler | `ImmediateScheduler` |
| 9 | 写验收示例 | `counter.ts`, `reactive_demo.ts` |
| 10 | 写单元测试 | `signal.test.ts` 等 |

### 12.3 不做（v0.1）

- 不做 deep reactive（list/dict 元素级响应）
- 不做 async cell body
- 不做 tree diff / incremental update
- 不做跨进程 signal
- 不做 marimo/web provider（现阶段只针对 pi-tui）
- 不做 `contextvars.ContextVar`（单线程同步模型）
- 不做 `.target` 暴露原生对象

---

## 13. pi-tui 关键接口参考（只读）

> **来源**: `.xx/ref/github.com/badlogic/pi-mono/v0.61.0/packages/tui/src/`
> **工具**: 可用 `tools/check-pitui.ts` 自动生成完整参考文件 `docs/ref-pitui-interfaces.md`

### 13.1 Component 接口（所有组件必须实现）

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;
  invalidate(): void;
}
```

### 13.2 Container（pi-tui 基础容器）

```typescript
class Container implements Component {
  children: Component[];
  addChild(component: Component): void;
  removeChild(component: Component): void;
  clear(): void;
  invalidate(): void;  // 递归 invalidate children
  render(width: number): string[];  // 竖向拼接所有 children
}
```

### 13.3 TUI（主循环，extends Container）

```typescript
class TUI extends Container {
  terminal: Terminal;
  
  constructor(terminal: Terminal, showHardwareCursor?: boolean);
  
  // 生命周期
  start(): void;                              // 启动 stdin 监听 + 首次 render
  stop(): void;                               // 停止，恢复终端
  requestRender(force?: boolean): void;       // 请求渲染（process.nextTick 去重）
  
  // 焦点管理
  setFocus(component: Component | null): void;
  
  // 输入监听
  addInputListener(listener: InputListener): () => void;  // 返回取消订阅函数
  removeInputListener(listener: InputListener): void;
  
  // Overlay
  showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
  hideOverlay(): void;
  hasOverlay(): boolean;
  
  // Debug
  onDebug?: () => void;
  get fullRedraws(): number;
  
  // 光标配置
  getShowHardwareCursor(): boolean;
  setShowHardwareCursor(enabled: boolean): void;
  getClearOnShrink(): boolean;
  setClearOnShrink(enabled: boolean): void;
}

// InputListener 类型
type InputListener = (data: string) => { consume?: boolean; data?: string } | undefined;
```

### 13.4 Text

```typescript
class Text implements Component {
  constructor(
    text?: string,         // 默认 ""
    paddingX?: number,     // 默认 1，左右 padding
    paddingY?: number,     // 默认 1，上下 padding
    customBgFn?: (text: string) => string  // 背景色函数
  );
  
  setText(text: string): void;       // 更新文本（会自动 invalidate）
  setCustomBgFn(fn?: (text: string) => string): void;
  render(width: number): string[];    // 含缓存，setText 后失效
  invalidate(): void;
}
```

### 13.5 Box

```typescript
class Box implements Component {
  children: Component[];
  
  constructor(
    paddingX?: number,     // 默认 1
    paddingY?: number,     // 默认 1
    bgFn?: (text: string) => string  // 背景色函数
  );
  
  addChild(component: Component): void;
  removeChild(component: Component): void;
  clear(): void;
  setBgFn(bgFn?: (text: string) => string): void;
  render(width: number): string[];    // 含 padding + bg
  invalidate(): void;
}
```

### 13.6 Input（单行文本输入）

```typescript
class Input implements Component, Focusable {
  focused: boolean;          // Focusable 接口，TUI 自动设置
  
  constructor();             // 无参，初始空值
  
  // 值管理
  getValue(): string;
  setValue(value: string): void;
  
  // 回调
  onSubmit?: (value: string) => void;   // Enter 提交
  onEscape?: () => void;                // Escape 取消
  
  handleInput(data: string): void;      // 处理键盘输入（由 TUI 调用）
  render(width: number): string[];
  invalidate(): void;
}
```

> **注意**: Input 不对外暴露 value 作为属性，需通过 `getValue()`/`setValue()` 操作。

### 13.7 Spacer

```typescript
class Spacer implements Component {
  constructor(lines?: number);  // 默认 1
  setLines(lines: number): void;
  render(_width: number): string[];  // 忽略 width，渲染空行
  invalidate(): void;
}
```

### 13.8 Editor（多行编辑器）

```typescript
class Editor implements Component, Focusable {
  focused: boolean;
  
  constructor(options?: EditorOptions, theme?: EditorTheme);
  
  getValue(): string;
  setValue(value: string): void;
  
  onSubmit?: (value: string) => void;
  
  handleInput(data: string): void;
  render(width: number): string[];
  invalidate(): void;
}

interface EditorOptions {
  onSubmit?: (value: string) => void;
  value?: string;
  placeholder?: string;
  autocomplete?: AutocompleteProvider;
  multiline?: boolean;       // 默认 false
  readOnly?: boolean;
  maxLength?: number;
}

interface EditorTheme {
  // ... 颜色主题配置
  prompt?: (text: string) => string;
}
```

> **注意**: Editor 是 Input 的超集。TextInput wrapper 可根据需要选择 Input 或 Editor。

### 13.9 SelectList

```typescript
interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

class SelectList implements Component {
  constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, layout?: SelectListLayoutOptions);
  
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SelectItem) => void;
  
  setFilter(filter: string): void;
  setSelectedIndex(index: number): void;
  render(width: number): string[];
  invalidate(): void;
}
```

### 13.10 Markdown

```typescript
class Markdown implements Component {
  constructor(
    text?: string,
    customBgFn?: (text: string) => string,
    theme?: MarkdownTheme
  );
  setText(text: string): void;
  render(width: number): string[];
  invalidate(): void;
}
```

### 13.11 ProcessTerminal（stdio 终端实现）

```typescript
class ProcessTerminal implements Terminal {
  constructor();
  
  // Terminal 接口
  get columns(): number;
  get rows(): number;
  write(data: string): void;
  hideCursor(): void;
  showCursor(): void;
  
  start(
    onInput: (data: string) => void,
    onResize: () => void
  ): void;
  stop(): void;
}
```

### 13.12 pi-tui 完整导出清单

```typescript
// 从 @mariozechner/pi-tui 导出
// Components
export { Box } from "./components/box.js";
export { CancellableLoader } from "./components/cancellable-loader.js";
export { Editor, type EditorOptions, type EditorTheme } from "./components/editor.js";
export { Image, type ImageOptions, type ImageTheme } from "./components/image.js";
export { Input } from "./components/input.js";
export { Loader } from "./components/loader.js";
export { Markdown, type MarkdownTheme } from "./components/markdown.js";
export { SelectList, type SelectItem, type SelectListTheme, type SelectListLayoutOptions } from "./components/select-list.js";
export { SettingsList, type SettingItem, type SettingsListTheme } from "./components/settings-list.js";
export { Spacer } from "./components/spacer.js";
export { Text } from "./components/text.js";
export { TruncatedText } from "./components/truncated-text.js";

// Core
export { Component, Container, CURSOR_MARKER, Focusable, isFocusable, TUI } from "./tui.js";
export { ProcessTerminal, type Terminal } from "./terminal.js";

// Utilities
export { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./utils.js";
```

### 13.13 Component vs ScopeNode 集成要点

```typescript
// ts-xxui UIComponent 同时满足两个身份：
//   1. ScopeNode（父子关系、config、signal scope）
//   2. pi-tui Component（render/handleInput 由 TUI 调用）
//
// 关键集成点：
//   - UIComponent 构造时，将自己 addChild 到父 ScopeNode 的 pi-tui children
//   - App.mount() 将根 ScopeNode.children 全部 addChild 到 this（App 本身也是 Container）
//   - Cell rerun 时，ContainerComponent.clearChildren() 同时移除 pi-tui children
//   - 输入事件通过 TUI → focus chain → UIComponent.handleInput() 分发
```

---

## 附录 A：决策总结

| 问题 | 决策 |
|------|------|
| Signal 实现 | 直接采纳 `@vue/reactivity` 的 `ref`，包装为 `Signal<T>` |
| App 入口 | 框架特定：`import { App } from "xxui/providers/pi-tui"` |
| 有没有 Provider | 没有独立的 Provider 对象，App 直接集成 pi-tui |
| 有没有 `btn.target` | 没有，UIComponent 直接 implements pi-tui Component |
| 组件参数风格 | 对象 options，按 pi-tui 原生组件参数规则设计 |
| 容器回调参数 | 支持 `app.column((ctx) => { ... })`，ctx 可省略 |
| 组件是否是 Cell | `app.column().cell(fn)` — 链式标记，非内部区分 |
| v0.1 组件清单 | text, label, column, row, box, button, textInput, spacer |

## 附录 B：文档与代码索引

| 文件 | 用途 |
|------|------|
| `xxui/ts-xxui/docs/ts-xxui-design-v0.2.md` | **主设计文档**（本文） |
| `xxui/ts-xxui/docs/ts-xxui-sessions.md` | 多会话任务清单 |
| `xxui/ts-xxui/docs/ref-pitui-interfaces.md` | pi-tui 接口参考（由 `tools/check-pitui.ts` 生成） |
| `xxui/ts-xxui/tools/check-pitui.ts` | pi-tui 组件检查工具（类似 py-xxui 的 `check_panel_params.py`） |
| `xxui/py-xxui/docs/py-xxui-init-design/2026-05-05_ai_codex_development_spec_v0.1.md` | py-xxui v0.1 开发规格（参考用） |
| `xxui/py-xxui/docs/py-xxui-init-design/2026-05-05_user_original_ideas.md` | 原始思路（参考用） |
| `.xx/ref/github.com/badlogic/pi-mono/v0.61.0/packages/tui/src/` | pi-tui 源码（只读参考） |
| `packages/xx-tui/examples/` | xx-tui 范例（验收目标） |
