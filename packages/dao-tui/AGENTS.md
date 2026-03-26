# dao-tui - Declarative Terminal UI Framework for Node.js

## Overview

`dao-tui` is a declarative TUI framework built on top of [`@mariozechner/pi-tui`](https://github.com/mariozechner/pi-tui). It provides a component-based, reusable approach to building terminal interfaces with **iterable composition**.

## Core Architecture

### Base Class: `App` (src/index.ts)

The abstract `App` class extends `PiContainer` and provides:

- Automatic mounting via `compose()` iterator method
- `refresh()` method to rebuild UI from state changes
- Default keyboard handling (q/Ctrl+C to quit)
- **Automatic VSCode IME detection**: disables raw mode in VSCode terminal to allow Chinese/English IME input

Methods:
- `abstract compose(): Iterable<PiComponent>` - yield components to build UI
- `refresh()` - remount and request render
- `run()` - start the TUI
- `stop()` - cleanup and exit

Properties:
- `protected tui: PiTUI` - underlying pi-tui instance
- `protected terminal: PiProcessTerminal` - terminal instance
- `protected isVSCodeTerminal: boolean` - detected if running in VSCode

## Components Provided

### Layout Components
- `Horizontal(gen: () => Iterable<PiComponent>, gap?: number)` - horizontal layout with equal width distribution
- `Vertical(gen: () => Iterable<PiComponent>, gap?: number)` - vertical layout with gaps

### Basic Components
- `Header(title)` - blue bold header bar spanning full width
- `Label(content)` - simple text
- `Rule(label?)` - horizontal divider line, can have centered label
- `Pill(value, color)` - colored pill tag (colors: blue/cyan/green/yellow/red/magenta)
- `Panel(title, body, footer?)` - panel with header, content, optional footer

### Interactive Components
- `Input(value, placeholder?, cursorVisible?)` - text input with blinking cursor
  - Renders `> prompt` with cursor
  - Blinking effect done via interval toggling `cursorVisible`
- `ChatBubble(message: ChatMessage)` - styled chat message
  - Blue tag for user, magenta tag for Claude/assistant
  - Auto-wraps text to fit width
- `SlashCommandSuggestion(command, description, selected)` - selectable suggestion item
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
- `LogLine(prefix, content, accent)` - styled log line with colored prefix

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
  yield new Header("My App");
  yield new Horizontal(() => [
    new Panel("Left", () => [
      new Label("Hello world"),
    ]),
    new Panel("Right", () => [
      new Input(this.value, "Type..."),
    ]),
  ], 1);
}
```

When state changes, just call `this.refresh()` - it calls `compose()` again and rebuilds everything automatically. This is perfect for:
- Mock agents
- Demos
- Simple interactive applications
- State-driven UIs where full rebuilds are acceptable

## Example: Claude Code TUI (examples/example.ts)

A complete demo mimicking the Claude Code interface:

Features:
- Full chat history with bubbles (user blue, Claude magenta)
- Interactive input box with blinking cursor
- Slash command suggestions with up/down arrow or Tab selection
- "Thinking..." animation with dots when simulating LLM response
- Simulated delayed LLM responses
- Automatic VSCode IME workaround

Slash commands in demo: `/commit`, `/review-pr`, `/help`, `/clear`, `/compact`, `/model`

## Key Bindings

In normal terminal (raw mode enabled):
- `↑`/`↓` - navigate slash command suggestions
- `Tab` - cycle suggestions
- `Enter` - submit message / accept selected suggestion
- `Backspace` - delete character
- `Ctrl+C` or `q` - quit

In VSCode terminal (raw mode disabled):
- Type normally (IME works for Chinese/English)
- `Enter` - submit
- `Ctrl+C` or `q` - quit

## Usage

```ts
import { App, Header, Panel, Input, Vertical } from "@whonb/dao-tui";

class MyApp extends App {
  override *compose() {
    yield new Header("My App");
    yield new Panel("Input", () => [
      new Vertical(() => [
        new Input("", "Type here...", true),
      ]),
    ]);
  }

  override run() {
    super.run();
    // Add your input listeners here
  }
}

const app = new MyApp();
app.run();
```

## Project Notes

### Imports

In this monorepo:
- Examples use relative imports: `import ... from "../src/index.js";`
- When published, the package is imported as: `import ... from "@whonb/dao-tui";`

### Dependencies

- `@mariozechner/pi-tui` - underlying TUI primitives
- `chalk` - terminal styling

## Development

When adding new components:
- Export all components from `src/index.ts`
- Follow the existing pattern: extend `PiText` or `PiContainer`
- Override the `render(width: number): string[]` method for custom rendering
- Use the existing `truncateToWidth` and `visibleWidth` utilities from pi-tui
