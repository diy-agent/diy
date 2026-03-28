# dao-tui - Declarative Terminal UI Framework for Node.js

## Overview

`dao-tui` is a declarative TUI framework built on top of [`@mariozechner/pi-tui`](https://github.com/mariozechner/pi-tui). It provides a component-based, reusable approach to building terminal interfaces with **iterable composition**.

## Core Architecture

### Base Class: `App` (src/app.ts)

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

## Functional App: `createApp` (added 2026-03-27)

New API that allows **closure-based state** without class inheritance:

```typescript
import { createApp, Panel, Input } from "@whonb/dao-tui';

const app = createApp(function*() {
  let inputValue = ""; // state in closure, NO `this` needed!
  yield new Panel("Chat", function*() {
    yield new Input(inputValue, "Type...");
    // No .bind(this) needed - closure captures automatically!
  });
});
app.run();
```

- `FunctionalApp` - concrete App class that accepts a generator from closure.
- `createApp(generator)` - factory function to create functional app.

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
// Class-based style (compatible):
class MyApp extends App {
  override *compose(): Iterable<PiComponent> {
    yield new Header("My App");
    yield new Horizontal(() => [
      new Panel("Left", function*() {
        yield new Label("Hello world");
      }),
    ], 1);
  }
}

// Functional style (new):
const app = createApp(function*() {
  let inputValue = "";
  yield new Header("My App");
  yield new Panel("Chat", function*() {
    yield new Input(inputValue, "Type...");
  });
});
```

When state changes, just call `app.refresh()` - it calls the generator again and rebuilds everything automatically. This is perfect for:
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

### Class-based style (existing, backward compatible):
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

### Functional style (new, recommended):
```ts
import { createApp, Header, Panel, Input, Vertical } from "@whonb/dao-tui";

const app = createApp(function*() {
  let inputValue = ""; // state in closure
  let messages: ChatMessage[] = [];

  yield new Header("My App");
  yield new Panel("Chat", function*() {
    for (const msg of messages) {
      yield new ChatBubble(msg);
    }
    yield new Input(inputValue, "Type here...", cursorVisible);
    // NO .bind(this) needed at all!
  });

  // You still access variables directly from closure in callbacks
  app.tui.addInputListener(data => {
    inputValue += data;
    app.refresh(); // full rebuild after change
  });
});
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

---

## Ongoing Refactor: Functional Component Support

### Goal

Refactor to support **factory function components** in addition to class-based components, eliminating the need for `.bind(this)`.

### Background

Current issue: In class-based `App`, when passing generator functions to containers (`Horizontal`, `Vertical`, `Panel`), you need to bind `this` to access instance state:

```ts
yield new Panel(
  "Chat",
  function*(this: MyApp) {
    yield new Input(this.inputValue, "...");
  }.bind(this)  // <-- this boilerplate is required, easy to forget
);
```

### Design Decision

After discussion, we're implementing **basic closure version**:

- ✅ Add `createApp()` factory function
- ✅ Allow functional style with closure state (no `this` needed)
- ✅ Keep full backward compatibility for existing code
- ✅ Full refresh on `app.refresh()` (same as before, no fine-grained reactivity for now)
- ✅ Only root app level is functional, containers keep existing API

Rejected for now: full signal-based reactivity with auto dependency collection (would require more extensive changes).

### New API

```ts
// Functional style - no this, no bind needed!
const app = createApp(function*() {
  let inputValue = ""; // state lives in closure

  yield new Panel("Chat", function*() {
    yield new Input(inputValue, "Type...");
    // No bind needed - closure automatically captures inputValue
  });
});
app.run();
```

### Current Status (2026-03-27)

| Task | Status |
|------|--------|
| Add `FunctionalApp` class to `src/app.ts` | ✅ Done |
| Add `createApp()` factory function | ✅ Done |
| Export `createApp` and `FunctionalApp` from `index.ts` | ✅ Done |
| Refactor `examples/example.ts` to functional style (remove 6 `.bind(this)` | ✅ Done |
| Verify containers work correctly with new API | ✅ Done |
| Test that everything still compiles/runs | ✅ Done |

### TODO

- [x] Add `FunctionalApp` and `createApp` core implementation
- [x] Export from `index.ts`
- [x] Refactor `examples/example.ts` from class-based to functional style
- [x] Remove all 6 occurrences of `.bind(this)`
- [x] Test compile and run
- [ ] Document API in README if needed

### Future Roadmap (Possible Future Enhancements

If functional style is adopted, could consider:

1. Full signal-based reactivity with automatic dependency tracking
2. Allow inline function components `yield () => Component` for granular refresh
3. Auto-invalidation of subtrees instead of full refresh

These would require more extensive changes and are not planned for now.
