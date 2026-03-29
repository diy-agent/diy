import { reactive } from "@vue/reactivity";
import { App, Panel, Text, Vertical, Header, Input, Rule, createApp } from "../src/index.js";
import chalk from "chalk";

/**
 * A demonstration of reactive TUI using @vue/reactivity.
 * Notice how there are ZERO manual `refresh()` calls.
 */
function runReactiveDemo() {
  // 1. Define reactive state
  const state = reactive({
    count: 0,
    inputValue: "",
    messages: [] as string[],
    cursorVisible: true,
  });

  // 2. Business logic (timers, events) just update the state
  setInterval(() => {
    state.count++;
  }, 1000);

  setInterval(() => {
    state.cursorVisible = !state.cursorVisible;
  }, 500);

  // 3. Create the app using a generator function that accesses reactive state
  const app = createApp(function*() {
    yield new Header({ title: "  Reactive DAO-TUI Demo  " });

    if (state.messages.length > 0) {
      yield new Panel({ title: "History" }, function*() {
        for (const msg of state.messages.slice(-50)) {
          yield new Text({ content: `${chalk.blue("»")} ${msg}` });
        }
      });
    }
    yield new Panel({ title: "State" }, function*() {
      yield new Vertical({}, function*() {
        yield new Text({ content: `Counter: ${chalk.cyan(state.count)}` });
        yield new Text({ content: `Input:   ${chalk.yellow(state.inputValue || "(empty)")}` });
        yield new Text({ content: `Cursor:  ${state.cursorVisible ? chalk.green("Visible") : chalk.red("Hidden")}` });
      });
    });

    yield new Panel({ title: "Interactive Input" }, function*() {
      yield new Input({ 
        value: state.inputValue, 
        placeholder: "Type message...", 
        cursorVisible: state.cursorVisible 
      });
      yield new Rule({});
      yield new Text({ content: chalk.gray("  Type something and press Enter to add to list • 'q' to quit") });
    });
    
  });

  // 4. Input handling also just updates the state
  app.tui.addInputListener((data) => {
    if (data === "\r" || data === "\n") {
      if (state.inputValue.trim()) {
        state.messages.push(state.inputValue.trim());
        state.inputValue = "";
      }
      return { consume: true };
    }
    
    // Simple backspace handling
    if (data === "\u007F" || data === "\b") {
      state.inputValue = state.inputValue.slice(0, -1);
      return { consume: true };
    }

    // Append characters
    const code = data.charCodeAt(0);
    if (data.length === 1 && code >= 32) {
      state.inputValue += data;
      return { consume: true };
    }
    return undefined;
  });

  app.run();
}

runReactiveDemo();
