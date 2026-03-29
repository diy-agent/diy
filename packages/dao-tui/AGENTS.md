# Dao TUI Agent Guide

This package provides a simple framework for building Terminal User Interfaces (TUI).

## UI Coding Standards

Follow these rules for TUI components and their usage to ensure a clean, HTML-like structure:

1.  **HTML-like Structure**: Components take two parts:
    -   **Props**: A single named arguments object (first argument). It SHOULD be kept on a single line, like HTML attributes.
    -   **Children**: A generator function (last positional argument) that yields child components. This is where you wrap and indent.
2.  **Compact Leaves**: Leaf components (like `Text`, `Pill`, `Input`) which only take props should always be instantiated on a single line.
3.  **Generator Context**: When using closures, use `function*(this: MyClass) { ... }.bind(this)` to maintain access to state.

## Reactive State Management

The TUI framework is integrated with `@vue/reactivity`. By using `reactive` or `ref` to define your state, the UI will automatically re-render whenever the state changes.

### ✅ Good (Reactive Style)
```typescript
import { reactive } from "@vue/reactivity";
import { createApp, Text } from "@whonb/dao-tui";

const state = reactive({ count: 0 });
setInterval(() => state.count++, 1000);

const app = createApp(function*() {
  yield new Text({ content: `Counter: ${state.count}` });
});
app.run(); // No manual refresh() needed!
```

## Available Components
```typescript
yield new Panel({ title: "Suggestions", footer: () => this.renderFooter() }, function*() {
  for (const cmd of filtered) {
    yield new SlashCommandSuggestion({ command: cmd.command, description: cmd.description, selected: true });
  }
});
```

### ❌ Bad (Overly verbose props or nested props children)
```typescript
yield new Panel(
  {
    title: "Suggestions"
  },
  function*() { ... }
); // Don't wrap props object if it fits on one line.
```

## Available Components

### Layout Components
- `Horizontal(props: { gap?: number }, children: ComponentGenerator)`
- `Vertical(props: { gap?: number }, children: ComponentGenerator)`
- `Panel(props: { title: string, footer?: ComponentGenerator }, children: ComponentGenerator)`

### Basic Components (Single Prop Argument)
- `Header({ title: string })`
- `Text({ content: string })`
- `Rule({ label?: string })`
- `Pill({ value: string, color?: string })`
- `LogLine({ prefix: string, content: string, accent?: string })`

### Interactive Components
- `Input({ value: string, placeholder?: string, cursorVisible?: boolean })`
- `ChatBubble({ message: ChatMessage })`
- `SlashCommandSuggestion({ command: string, description: string, selected: boolean })`
