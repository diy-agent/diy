# Dao TUI Agent Guide

This package provides a simple framework for building Terminal User Interfaces (TUI) using a declarative, React-like composition model.

## Core Concepts

### The App Class
To create a TUI, extend the `App` class and implement the `compose()` generator method.
State is managed directly on your class. Call `this.refresh()` whenever state changes to re-render the UI.

### Component Composition
The `compose()` method is a generator that yields components. Containers like `Horizontal`, `Vertical`, and `Panel` also take generators as their last positional argument, allowing for nested, declarative UI structures.

## Available Components

All components take a single `props` object as their first constructor argument. Containers take a `generator` as the final positional argument.

### Layout Components
- `Horizontal({ gap?: number }, generator: () => Iterable<PiComponent>)` - horizontal layout with equal width distribution
- `Vertical({ gap?: number }, generator: () => Iterable<PiComponent>)` - vertical layout with gaps

### Basic Components
- `Header({ title: string })` - blue bold header bar spanning full width
- `Text({ content: string })` - simple text
- `Rule({ label?: string })` - horizontal divider line, can have centered label
- `Pill({ value: string, color?: string })` - colored pill tag (colors: blue/cyan/green/yellow/red/magenta)
- `Panel({ title: string, footer?: () => Iterable<PiComponent> }, body: () => Iterable<PiComponent>)` - panel with header, content, optional footer

### Interactive Components
- `Input({ value: string, placeholder?: string, cursorVisible?: boolean })` - text input with blinking cursor
  - Renders `> prompt` with cursor
  - Blinking effect done via interval toggling `cursorVisible`
- `ChatBubble({ message: ChatMessage })` - styled chat message
  - Blue tag for user, magenta tag for Claude/assistant
  - Auto-wraps text to fit width
- `SlashCommandSuggestion({ command: string, description: string, selected: boolean })` - selectable suggestion item
  - Highlights selected item with triangle indicator

### Types
```ts
type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
};
```

### Logging
- `LogLine({ prefix: string, content: string, accent?: string })` - styled log line with colored prefix

## Features

### IME / VSCode Handling

The framework automatically handles the VSCode terminal IME issue:
- Detects `process.env.TERM_PROGRAM === 'vscode'`
- Disables raw mode for VSCode to allow IME composition
- Normal terminals keep raw mode for full arrow key interactivity

### Declarative Composition

Instead of manually constructing component trees, you yield components from a generator:

```ts
override *compose(): Iterable<PiComponent> {
  yield new Header({ title: "My App" });
  yield new Horizontal({ gap: 1 }, function*() {
    yield new Panel(
      { title: "Left" },
      function*() {
        yield new Text({ content: "Hello world" });
      }
    );
    yield new Panel(
      { title: "Right" },
      function*() {
        yield new Input({ value: this.value, placeholder: "Type..." });
      }
    );
  });
}
```

When state changes, just call `app.refresh()` - it calls the generator again and rebuilds everything automatically. This is perfect for:
- Mock agents
- Demos
- Simple interactive applications
- State-driven UIs where full rebuilds are acceptable

## Example: Claude Code TUI (examples/example.ts)

A complete demo mimicking the Claude Code interface:

1. Run it: `npx tsx examples/example.ts`
2. Features:
   - Command history (simulated)
   - Slash command suggestions
   - IME support for VSCode
   - Thinking animations
   - Responsive layout
