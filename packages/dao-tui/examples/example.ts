import { createApp, FunctionalApp, Header, Horizontal, Vertical, Panel, Input, ChatBubble, SlashCommandSuggestion, type ChatMessage, type Component } from "../src/index.js";
import { Text as PiText } from "@mariozechner/pi-tui";
import chalk from "chalk";

type PiComponent = Component;

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

// Simulated LLM responses for demo
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
  default: "I'm Claude, an AI assistant built by Anthropic. I can help you with coding, answering questions, debugging, and more. What would you like to work on today?",
};

// Get isVSCode directly from environment - matches what App does
// This avoids the circular dependency issue
const isVSCode = process.env.TERM_PROGRAM === 'vscode';

// State variables moved outside compose for proper closure capture
let inputValue = "";
const messages: ChatMessage[] = [];
let showSuggestions = false;
let selectedSuggestion = 0;
let cursorBlink = true;
let isThinking = false;
let thinkingDots = 0;
let thinkingInterval: ReturnType<typeof setInterval> | undefined;

// Render input component
function renderInput(): PiComponent {
  return new Input({ value: inputValue, placeholder: "Type your message...", cursorVisible: cursorBlink });
}

// Get filtered commands based on input
function getFilteredCommands(): SlashCommand[] {
  const input = inputValue.toLowerCase();
  return availableCommands.filter(cmd =>
    cmd.command.toLowerCase().startsWith(input)
  );
}

// Update suggestion visibility based on input
function updateSuggestions(): void {
  if (inputValue.startsWith("/")) {
    showSuggestions = true;
    selectedSuggestion = 0;
  } else {
    showSuggestions = false;
  }
}

// Render suggestion panel
function renderSuggestions(): PiComponent {
  if (!showSuggestions || isVSCode) {
    // In VSCode, disable real-time suggestions since arrow keys don't work well with IME
    return new PiText("");
  }

  const filtered = getFilteredCommands();
  if (filtered.length === 0) {
    return new PiText("");
  }

  return new Panel(
    { title: "Suggestions" },
    function*() {
      for (const [idx, cmd] of filtered.entries()) {
        yield new SlashCommandSuggestion({ command: cmd.command, description: cmd.description, selected: idx === selectedSuggestion });
      }
    }
  );
}

// Handle message submission
function handleSubmit(): void {
  const content = inputValue.trim();
  if (!content) return;

  // Add user message
  messages.push({
    role: "user",
    content,
    timestamp: new Date(),
  });

  inputValue = "";
  showSuggestions = false;
  isThinking = true;
  app.refresh();

  // Animate thinking
  thinkingDots = 0;
  thinkingInterval = setInterval(() => {
    thinkingDots = (thinkingDots + 1) % 4;
    app.refresh();
  }, 300);

  // Simulate LLM response delay
  setTimeout(() => {
    clearInterval(thinkingInterval!);
    isThinking = false;

    // Get mock response
    let response = mockResponses[content];
    if (!response) {
      if (content.startsWith("/")) {
        response = `Unknown command: ${content}. Type /help to see available commands.`;
      } else {
        response = `You asked: "${content}". This is a simulated response in the mock Claude Code TUI demo. In the real Claude Code, I would help you with your request!`;
      }
    }

    messages.push({
      role: "assistant",
      content: response,
      timestamp: new Date(),
    });

    app.refresh();
  }, 1500 + Math.random() * 1000);
}

// Main UI composition
function* createAppComposition() {
  yield new Header({ title: "  Claude Code  " });

  yield new Horizontal(
    { gap: 0 },
    function*() {
      yield new Panel(
        { title: "Chat" },
        function*() {
          yield new Vertical(
            { gap: 0 },
            function*() {
              for (const msg of messages) {
                yield new ChatBubble({ message: msg });
              }
              if (isThinking) {
                yield new PiText(chalk.cyan.dim(`  Thinking${".".repeat(thinkingDots)}`));
              } else {
                yield new PiText("");
              }
              yield new PiText("");
            }
          );
        },
        function*() {
          yield new Vertical(
            { gap: 0 },
            function*() {
              yield renderInput();
              const suggestions = renderSuggestions();
              if (suggestions) {
                yield suggestions;
              }
              yield new PiText(chalk.gray.dim(isVSCode
                ? "  VSCode Terminal • Enter to send • Ctrl+C to exit"
                : "  ↑/↓ or Tab to select • Enter to send • Ctrl+C to exit"
              ));
            }
          );
        }
      );
    }
  );
}

const app = createApp(createAppComposition);

// Setup cursor blinking
const blinkInterval = setInterval(() => {
  cursorBlink = !cursorBlink;
  app.refresh();
}, 500);

// TODO: vscode ime can not work！can not input word
if (isVSCode) {
  // VSCode + IME workaround: read entire line on enter
  // This allows IME to work properly at the cost of no real-time preview
  // But English/Chinese input will both work
  app.tui.addInputListener((data: string) => {
    if (data === "\u0003" || data === "q" || data === "Q") {
      app.stop();
      return { consume: true };
    }

    // In VSCode line mode, we accumulate until newline
    // data can have multiple characters at once
    if (data.includes("\n") || data.includes("\r")) {
      // Split and take the first line
      const lines = data.split(/[\r\n]+/);
      inputValue += lines[0];
      handleSubmit();
      // Any remaining characters (unlikely) get added
      if (lines.length > 1) {
        inputValue = lines.slice(1).join('');
      }
      app.refresh();
      return { consume: true };
    } else {
      // Add the characters and handle backspace
      if (data === "\b" || data === "\u007F") {
        if (inputValue.length > 0) {
          inputValue = inputValue.slice(0, -1);
          updateSuggestions();
          app.refresh();
        }
      } else {
        inputValue += data;
        // Still update suggestions even in VSCode mode for matching
        updateSuggestions();
        app.refresh();
      }
    }
    return { consume: true };
  });
} else {
  // Normal terminal - full interactive mode with arrow keys
  app.tui.addInputListener((char: string) => {
    if (char === "\u0003" || char === "q" || char === "Q") {
      app.stop();
      return { consume: true };
    }

    if (char === "\x1b[A" || char === "\u001B[A") {
      // Up arrow - previous suggestion
      if (showSuggestions) {
        const filtered = getFilteredCommands();
        selectedSuggestion = (selectedSuggestion - 1 + filtered.length) % filtered.length;
        app.refresh();
      }
      return { consume: true };
    }

    if (char === "\x1b[B" || char === "\u001B[B") {
      // Down arrow - next suggestion
      if (showSuggestions) {
        const filtered = getFilteredCommands();
        selectedSuggestion = (selectedSuggestion + 1) % filtered.length;
        app.refresh();
      }
      return { consume: true };
    }

    if (char === "\r" || char === "\n") {
      // Enter - accept selected suggestion if visible
      if (showSuggestions && !isVSCode) {
        const filtered = getFilteredCommands();
        if (filtered.length > 0 && selectedSuggestion < filtered.length) {
          inputValue = filtered[selectedSuggestion].command;
        }
      }
      handleSubmit();
      return { consume: true };
    }

    if (char === "\u007F" || char === "\b") {
      // Backspace
      if (inputValue.length > 0) {
        inputValue = inputValue.slice(0, -1);
        updateSuggestions();
        app.refresh();
      }
      return { consume: true };
    }

    if (char === "\t") {
      // Tab - cycle suggestions
      if (showSuggestions && !isVSCode) {
        const filtered = getFilteredCommands();
        selectedSuggestion = (selectedSuggestion + 1) % filtered.length;
        app.refresh();
      }
      return { consume: true };
    }

    // Check if it's a normal printable character (not an escape sequence)
    const code = char.charCodeAt(0);
    if (char.length >= 1 && code >= 32) {
      inputValue += char;
      updateSuggestions();
      app.refresh();
      return { consume: true };
    }

    return undefined;
  });
}

// Cleanup intervals on stop
const originalStop = app.stop.bind(app);
app.stop = () => {
  if (blinkInterval) clearInterval(blinkInterval);
  if (thinkingInterval) clearInterval(thinkingInterval);
  originalStop();
};

// Add welcome message
messages.push({
  role: "assistant",
  content: "Welcome to Claude Code! Type a message or use a slash command to get started.",
  timestamp: new Date(),
});

if (process.argv[1] === import.meta.filename) {
  app.run();
}
