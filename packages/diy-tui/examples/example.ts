import { reactive } from "@vue/reactivity";
import { 
  Text, Header, Horizontal, Vertical, Panel, Input, 
  ChatBubble, SlashCommandSuggestion, type ChatMessage, 
  Rule, createApp 
} from "../src/index.js";
import chalk from "chalk";

type SlashCommand = {
  command: string;
  description: string;
};

const availableCommands: SlashCommand[] = [
  { command: "/commit", description: "Commit staged changes" },
  { command: "/review-pr", description: "Review a pull request" },
  { command: "/help", description: "Show available commands" },
  { command: "/clear", description: "Clear chat history" },
  { command: "/compact", description: "Compact conversation context" },
  { command: "/model", description: "Change the current model" },
];

const mockResponses: Record<string, string> = {
  "/help": `Available slash commands:
- /commit - Commit staged changes
- /review-pr - Review a pull request
- /help - Show this help message
- /clear - Clear chat history
- /compact - Compact conversation context
- /model - Change the current model

You can also just type any question or request and I'll respond!`,
  "/clear": "Chat history cleared. Starting fresh conversation.",
  "/model": "Current model: claude-opus-4.6\nAvailable models: claude-opus-4.6, claude-sonnet-4.6, claude-haiku-4.5",
  "/commit": "Let me help you create a commit. I'll analyze your changes and draft a descriptive commit message for you.",
  default: "I'm Claude, an AI assistant built by Anthropic. I can help you with coding, answering questions, debugging, and more. What would you like to work on today!",
};

function runClaudeTUI() {
  // 1. Reactive State
  const state = reactive({
    inputValue: "",
    messages: [{
      role: "assistant" as const,
      content: "Welcome to Claude Code! Type a message or use a slash command to get started.",
      timestamp: new Date(),
    }] as ChatMessage[],
    showSuggestions: false,
    selectedSuggestion: 0,
    cursorBlink: true,
    isThinking: false,
    thinkingDots: 0,
  });

  // 2. Logic Helpers (Closures)
  const getFilteredCommands = (): SlashCommand[] => {
    if (!state.inputValue.startsWith("/")) return [];
    return availableCommands.filter(c => c.command.startsWith(state.inputValue));
  };

  const updateSuggestions = () => {
    const filtered = getFilteredCommands();
    state.showSuggestions = filtered.length > 0;
    if (state.selectedSuggestion >= filtered.length) {
      state.selectedSuggestion = 0;
    }
  };

  const handleSubmit = () => {
    if (!state.inputValue.trim()) return;

    const userMsg = state.inputValue.trim();
    state.messages.push({ role: "user", content: userMsg, timestamp: new Date() });
    state.inputValue = "";
    state.showSuggestions = false;
    state.isThinking = true;
    state.thinkingDots = 0;

    const thinkingInterval = setInterval(() => {
      state.thinkingDots = (state.thinkingDots + 1) % 4;
    }, 300);

    setTimeout(() => {
      clearInterval(thinkingInterval);
      state.isThinking = false;
      const response = mockResponses[userMsg] || mockResponses.default;
      state.messages.push({ role: "assistant", content: response, timestamp: new Date() });
    }, 1500);
  };

  // 3. Create Functional App
  const app = createApp(function*() {
    const isVSCode = app.isVSCodeTerminal;

    yield new Header({ title: "  Claude Code (Reactive)  " });

    yield new Horizontal({}, function*() {
      yield new Panel({ title: "Chat" }, function*() {
        yield new Vertical({}, function*() {
          for (const msg of state.messages) {
            yield new ChatBubble({ message: msg });
          }
          if (state.isThinking) {
            yield new Text({ content: chalk.cyan.dim(`  Thinking${".".repeat(state.thinkingDots)}`) });
          } else {
            yield new Text({ content: "" });
          }
          yield new Text({ content: "" });
        });

        // "Footer" section directly in children
        yield new Rule({});
        yield new Vertical({}, function*() {
          // Render Input
          yield new Input({ 
            value: state.inputValue, 
            placeholder: "Type your message...", 
            cursorVisible: state.cursorBlink 
          });

          // Render Suggestions
          const filtered = getFilteredCommands();
          if (state.showSuggestions && !isVSCode && filtered.length > 0) {
            yield new Panel({ title: "Suggestions" }, function*() {
              for (const [idx, cmd] of filtered.entries()) {
                yield new SlashCommandSuggestion({ 
                  command: cmd.command, 
                  description: cmd.description, 
                  selected: idx === state.selectedSuggestion 
                });
              }
            });
          }

          yield new Text({ content: chalk.gray.dim(isVSCode
            ? "  VSCode Terminal • Enter to send • Ctrl+C to exit"
            : "  ↑/↓ or Tab to select • Enter to send • Ctrl+C to exit"
          )});
        });
      });
    });
  });

  // 4. Input handling
  app.tui.addInputListener((data: string) => {
    if (data === "\u0003") {
      app.stop();
      return { consume: true };
    }

    const isVSCode = app.isVSCodeTerminal;

    if (isVSCode) {
      if (data.includes("\n") || data.includes("\r")) {
        const lines = data.split(/[\r\n]+/);
        state.inputValue += lines[0];
        handleSubmit();
        if (lines.length > 1) state.inputValue = lines.slice(1).join("");
        return { consume: true };
      } else if (data === "\b" || data === "\u007F") {
        if (state.inputValue.length > 0) {
          state.inputValue = state.inputValue.slice(0, -1);
          updateSuggestions();
        }
        return { consume: true };
      } else {
        state.inputValue += data;
        updateSuggestions();
        return { consume: true };
      }
    } else {
      // Arrow keys and Tabs for suggestions
      if (data === "\x1b[A" || data === "\u001B[A") {
        if (state.showSuggestions) {
          const filtered = getFilteredCommands();
          state.selectedSuggestion = (state.selectedSuggestion - 1 + filtered.length) % filtered.length;
        }
        return { consume: true };
      }
      if (data === "\x1b[B" || data === "\u001B[B") {
        if (state.showSuggestions) {
          const filtered = getFilteredCommands();
          state.selectedSuggestion = (state.selectedSuggestion + 1) % filtered.length;
        }
        return { consume: true };
      }
      if (data === "\r" || data === "\n") {
        if (state.showSuggestions) {
          const filtered = getFilteredCommands();
          if (filtered.length > 0 && state.selectedSuggestion < filtered.length) {
            state.inputValue = filtered[state.selectedSuggestion].command;
            state.showSuggestions = false;
            return { consume: true };
          }
        }
        handleSubmit();
        return { consume: true };
      }
      if (data === "\u007F" || data === "\b") {
        if (state.inputValue.length > 0) {
          state.inputValue = state.inputValue.slice(0, -1);
          updateSuggestions();
        }
        return { consume: true };
      }
      if (data === "\t") {
        if (state.showSuggestions) {
          const filtered = getFilteredCommands();
          state.selectedSuggestion = (state.selectedSuggestion + 1) % filtered.length;
        }
        return { consume: true };
      }
      
      const code = data.charCodeAt(0);
      if (data.length >= 1 && code >= 32) {
        state.inputValue += data;
        updateSuggestions();
        return { consume: true };
      }
    }
    return undefined;
  });

  // 5. Intervals
  const blinkInterval = setInterval(() => {
    state.cursorBlink = !state.cursorBlink;
  }, 500);

  // Auto-cleanup would be nice, but for an example this is fine
  // or we could wrap app.stop()

  app.run();
}

if (process.argv[1] === import.meta.filename) {
  runClaudeTUI();
}
