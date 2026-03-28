import { App, Text, Header, Horizontal, Vertical, Panel, Input, ChatBubble, SlashCommandSuggestion, type ChatMessage, type Component } from "../src/index.js";
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

class ClaudeCodeTUI extends App {
  private inputValue = "";
  private messages: ChatMessage[] = [];
  private showSuggestions = false;
  private selectedSuggestion = 0;
  private cursorBlink = true;
  private isThinking = false;
  private thinkingDots = 0;
  private blinkInterval?: ReturnType<typeof setInterval>;
  private thinkingInterval?: ReturnType<typeof setInterval>;

  // Get isVSCode from base class
  private get isVSCode(): boolean {
    return this.isVSCodeTerminal;
  }

  override *compose(): Iterable<PiComponent> {
    yield new Header("  Claude Code  ");

    yield new Horizontal(function*(this: ClaudeCodeTUI) {
      yield new Panel(
        "Chat",
        function*(this: ClaudeCodeTUI) {
          yield new Vertical(function*(this: ClaudeCodeTUI) {
            for (const msg of this.messages) {
              yield new ChatBubble(msg);
            }
            if (this.isThinking) {
              yield new Text(chalk.cyan.dim(`  Thinking${".".repeat(this.thinkingDots)}`));
            } else {
              yield new Text("");
            }
            yield new Text("");
          }.bind(this), 0);
        }.bind(this),
        function*(this: ClaudeCodeTUI) {
          yield new Vertical(function*(this: ClaudeCodeTUI) {
            yield this.renderInput();
            const suggestions = this.renderSuggestions();
            if (suggestions) {
              yield suggestions;
            }
            yield new Text(chalk.gray.dim(this.isVSCode
              ? "  VSCode Terminal • Enter to send • Ctrl+C to exit"
              : "  ↑/↓ or Tab to select • Enter to send • Ctrl+C to exit"
            ));
          }.bind(this), 0);
        }.bind(this)
      );
    }.bind(this), 0);
  }

  private renderInput(): PiComponent {
    return new Input(this.inputValue, "Type your message...", this.cursorBlink);
  }

  private renderSuggestions(): PiComponent {
    if (!this.showSuggestions || this.isVSCode) {
      // In VSCode, disable real-time suggestions since arrow keys don't work well with IME
      return new Text("");
    }

    const filtered = this.getFilteredCommands();
    if (filtered.length === 0) {
      return new Text("");
    }

    return new Panel(
      "Suggestions",
      function*(this: ClaudeCodeTUI) {
        for (const [idx, cmd] of filtered.entries()) {
          yield new SlashCommandSuggestion(cmd.command, cmd.description, idx === this.selectedSuggestion);
        }
      }.bind(this),
    );
  }

  override run(): void {
    super.run();

    // Setup cursor blinking
    this.blinkInterval = setInterval(() => {
      this.cursorBlink = !this.cursorBlink;
      this.refresh();
    }, 500);

    // TODO: vscode ime can not work！can not input word
    if (this.isVSCode) {
      // VSCode + IME workaround: read entire line on enter
      // This allows IME to work properly at the cost of no real-time preview
      // But English/Chinese input will both work
      this.tui.addInputListener((data) => {
        if (data === "\u0003" || data === "q" || data === "Q") {
          this.stop();
          return { consume: true };
        }

        // In VSCode line mode, we accumulate until newline
        // data can have multiple characters at once
        if (data.includes("\n") || data.includes("\r")) {
          // Split and take the first line
          const lines = data.split(/[\r\n]+/);
          this.inputValue += lines[0];
          this.handleSubmit();
          // Any remaining characters (unlikely) get added
          if (lines.length > 1) {
            this.inputValue = lines.slice(1).join('');
          }
        } else {
          // Add the characters and handle backspace
          if (data === "\b" || data === "\u007F") {
            if (this.inputValue.length > 0) {
              this.inputValue = this.inputValue.slice(0, -1);
              this.refresh();
            }
          } else {
            this.inputValue += data;
            // Still update suggestions even in VSCode mode for matching
            if (this.inputValue.startsWith("/")) {
              this.showSuggestions = true;
              this.selectedSuggestion = 0;
            } else {
              this.showSuggestions = false;
            }
            this.refresh();
          }
        }
        return { consume: true };
      });
    } else {
      // Normal terminal - full interactive mode with arrow keys
      this.tui.addInputListener((char) => {
        if (char === "\u0003" || char === "q" || char === "Q") {
          this.stop();
          return { consume: true };
        }

        if (char === "\x1b[A" || char === "\u001B[A") {
          // Up arrow - previous suggestion
          if (this.showSuggestions) {
            const filtered = this.getFilteredCommands();
            this.selectedSuggestion = (this.selectedSuggestion - 1 + filtered.length) % filtered.length;
            this.refresh();
          }
          return { consume: true };
        }

        if (char === "\x1b[B" || char === "\u001B[B") {
          // Down arrow - next suggestion
          if (this.showSuggestions) {
            const filtered = this.getFilteredCommands();
            this.selectedSuggestion = (this.selectedSuggestion + 1) % filtered.length;
            this.refresh();
          }
          return { consume: true };
        }

        if (char === "\r" || char === "\n") {
          // Enter - accept selected suggestion if visible
          if (this.showSuggestions && !this.isVSCode) {
            const filtered = this.getFilteredCommands();
            if (filtered.length > 0 && this.selectedSuggestion < filtered.length) {
              this.inputValue = filtered[this.selectedSuggestion].command;
            }
          }
          this.handleSubmit();
          return { consume: true };
        }

        if (char === "\u007F" || char === "\b") {
          // Backspace
          if (this.inputValue.length > 0) {
            this.inputValue = this.inputValue.slice(0, -1);
            this.updateSuggestions();
            this.refresh();
          }
          return { consume: true };
        }

        if (char === "\t") {
          // Tab - cycle suggestions
          if (this.showSuggestions && !this.isVSCode) {
            const filtered = this.getFilteredCommands();
            this.selectedSuggestion = (this.selectedSuggestion + 1) % filtered.length;
            this.refresh();
          }
          return { consume: true };
        }

        // Check if it's a normal printable character (not an escape sequence)
        const code = char.charCodeAt(0);
        if (char.length >= 1 && code >= 32) {
          this.inputValue += char;
          this.updateSuggestions();
          this.refresh();
          return { consume: true };
        }

        return undefined;
      });
    }

    // Add welcome message
    this.messages.push({
      role: "assistant",
      content: "Welcome to Claude Code! Type a message or use a slash command to get started.",
      timestamp: new Date(),
    });
  }

  override stop(): void {
    if (this.blinkInterval) clearInterval(this.blinkInterval);
    if (this.thinkingInterval) clearInterval(this.thinkingInterval);
    super.stop();
  }

  private updateSuggestions(): void {
    if (this.inputValue.startsWith("/")) {
      this.showSuggestions = true;
      this.selectedSuggestion = 0;
    } else {
      this.showSuggestions = false;
    }
  }

  private getFilteredCommands(): SlashCommand[] {
    const input = this.inputValue.toLowerCase();
    return availableCommands.filter(cmd =>
      cmd.command.toLowerCase().startsWith(input)
    );
  }

  private handleSubmit(): void {
    const content = this.inputValue.trim();
    if (!content) return;

    // Add user message
    this.messages.push({
      role: "user",
      content,
      timestamp: new Date(),
    });

    this.inputValue = "";
    this.showSuggestions = false;
    this.isThinking = true;
    this.refresh();

    // Animate thinking
    this.thinkingDots = 0;
    this.thinkingInterval = setInterval(() => {
      this.thinkingDots = (this.thinkingDots + 1) % 4;
      this.refresh();
    }, 300);

    // Simulate LLM response delay
    setTimeout(() => {
      clearInterval(this.thinkingInterval!);
      this.isThinking = false;

      // Get mock response
      let response = mockResponses[content];
      if (!response) {
        if (content.startsWith("/")) {
          response = `Unknown command: ${content}. Type /help to see available commands.`;
        } else {
          response = `You asked: "${content}". This is a simulated response in the mock Claude Code TUI demo. In the real Claude Code, I would help you with your request!`;
        }
      }

      this.messages.push({
        role: "assistant",
        content: response,
        timestamp: new Date(),
      });

      this.refresh();
    }, 1500 + Math.random() * 1000);
  }
}

if (process.argv[1] === import.meta.filename) {
  const app = new ClaudeCodeTUI();
  app.run();
}
