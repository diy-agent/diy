# Refactor: 支持工厂函数组件模式

## 需求描述

将 dao-tui 的 `Horizontal/Vertical/Panel` 等容器组件改造为支持 **类组件 + 工厂函数组件** 双模式，类似 React：
- 保持现有类组件方式不变
- 新增支持工厂函数方式，避免 `this` 绑定问题
- 函数组件通过容器包装获得普通组件的外观接口

## 当前架构分析

当前架构：
- 所有组件都继承自 `@mariozechner/pi-tui` 的基类（`PiContainer`, `PiText`）
- 容器类（`Horizontal`, `Vertical`）在构造函数中接收 `ComponentGenerator` 生成器函数
- 在用户代码（example.ts）中，由于需要访问实例属性，必须使用 `.bind(this)`，很麻烦

```ts
// 当前写法，需要 bind
export class ExampleApp extends App {
  private count = 0;
  
  *compose(): ComponentGenerator {
    yield new Horizontal(this.renderCounter.bind(this), 1);
  }
  
  *renderCounter(): ComponentGenerator {
    // ... access this.count
  }
}
```

## 设计方案

### 类型设计

```ts
// 两种组件类型
type AnyComponent = Component | (() => Iterable<Component>);

// 容器需要同时接受两种类型
constructor(input: AnyComponent | ComponentGenerator, gap?: number);
```

### 实现思路

1. **类型识别**：在容器构造函数中判断输入是函数还是组件实例
2. **自动包装**：如果是工厂函数，自动执行它获得子组件并添加
3. **保留原接口**：保持向后兼容，不需要修改现有代码

### 优点
- 不需要 `bind(this)`，函数组件自然闭包捕获变量
- 灵活，简单状态用函数，复杂生命周期用类
- 向后兼容，不破坏现有代码

## 修改范围

需要修改：
1. `packages/dao-tui/src/containers.ts` - `Horizontal`, `Vertical`, `Panel` 等容器
2. 类型定义更新
3. `examples/example.ts` - 示例迁移到新写法作为演示

## 任务

- [ ] 修改 `Horizontal` 支持双模式
- [ ] 修改 `Vertical` 支持双模式  
- [ ] 修改 `Panel` 支持双模式
- [ ] 更新 `example.ts` 示例
- [ ] 测试验证