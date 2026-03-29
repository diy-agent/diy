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

  constructor() {
    super();
    this.messages.push({
      role: "assistant",
      content: "Welcome to Claude Code! Type a message or use a slash command to get started.",
      timestamp: new Date(),
    });
  }

  private get isVSCode(): boolean {
    return this.isVSCodeTerminal;
  }

  override *compose(): Iterable<PiComponent> {
    yield new Header({ title: "  Claude Code  " });

    yield new Horizontal({}, function*(this: ClaudeCodeTUI) {
      yield new Panel({ title: "Chat", footer: function*(this: ClaudeCodeTUI) {
        yield new Vertical({}, function*(this: ClaudeCodeTUI) {
          yield this.renderInput();
          const suggestions = this.renderSuggestions();
          if (suggestions) yield suggestions;
          yield new Text({ content: chalk.gray.dim(this.isVSCode
            ? "  VSCode Terminal • Enter to send • Ctrl+C to exit"
            : "  ↑/↓ or Tab to select • Enter to send • Ctrl+C to exit"
          )});
        }.bind(this));
      }.bind(this) }, function*(this: ClaudeCodeTUI) {
        yield new Vertical({}, function*(this: ClaudeCodeTUI) {
          for (const msg of this.messages) {
            yield new ChatBubble({ message: msg });
          }
          if (this.isThinking) {
            yield new Text({ content: chalk.cyan.dim(`  Thinking${".".repeat(this.thinkingDots)}`) });
          } else {
            yield new Text({ content: "" });
          }
          yield new Text({ content: "" });
        }.bind(this));
      }.bind(this));
    }.bind(this));
  }

  private renderInput(): PiComponent {
    return new Input({ value: this.inputValue, placeholder: "Type your message...", cursorVisible: this.cursorBlink });
  }

  private renderSuggestions(): PiComponent {
    if (!this.showSuggestions || this.isVSCode) return new Text({ content: "" });
    const filtered = this.getFilteredCommands();
    if (filtered.length === 0) return new Text({ content: "" });

    return new Panel({ title: "Suggestions" }, function*(this: ClaudeCodeTUI) {
      for (const [idx, cmd] of filtered.entries()) {
        yield new SlashCommandSuggestion({ command: cmd.command, description: cmd.description, selected: idx === this.selectedSuggestion });
      }
    }.bind(this));
  }

  private getFilteredCommands(): SlashCommand[] {
    if (!this.inputValue.startsWith("/")) return [];
    return availableCommands.filter(c => c.command.startsWith(this.inputValue));
  }

  private updateSuggestions(): void {
    const filtered = this.getFilteredCommands();
    this.showSuggestions = filtered.length > 0;
    if (this.selectedSuggestion >= filtered.length) {
      this.selectedSuggestion = 0;
    }
  }

  private handleSubmit(): void {
    if (!this.inputValue.trim()) return;

    const userMsg = this.inputValue.trim();
    this.messages.push({ role: "user", content: userMsg, timestamp: new Date() });
    this.inputValue = "";
    this.showSuggestions = false;
    this.isThinking = true;
    this.thinkingDots = 0;

    this.thinkingInterval = setInterval(() => {
      this.thinkingDots = (this.thinkingDots + 1) % 4;
      this.refresh();
    }, 300);

    setTimeout(() => {
      if (this.thinkingInterval) clearInterval(this.thinkingInterval);
      this.isThinking = false;
      const response = mockResponses[userMsg] || mockResponses.default;
      this.messages.push({ role: "assistant", content: response, timestamp: new Date() });
      this.refresh();
    }, 1500);

    this.refresh();
  }

  override run(): void {
    super.run();

    this.blinkInterval = setInterval(() => {
      this.cursorBlink = !this.cursorBlink;
      this.refresh();
    }, 500);

    this.tui.addInputListener((data: string) => {
      if (data === "\u0003") {
        this.stop();
        return { consume: true };
      }

      if (this.isVSCode) {
        if (data.includes("\n") || data.includes("\r")) {
          const lines = data.split(/[\r\n]+/);
          this.inputValue += lines[0];
          this.handleSubmit();
          if (lines.length > 1) this.inputValue = lines.slice(1).join("");
          this.refresh();
          return { consume: true };
        } else if (data === "\b" || data === "\u007F") {
          if (this.inputValue.length > 0) {
            this.inputValue = this.inputValue.slice(0, -1);
            this.updateSuggestions();
            this.refresh();
          }
        } else {
          this.inputValue += data;
          this.updateSuggestions();
          this.refresh();
        }
      } else {
        if (data === "\x1b[A" || data === "\u001B[A") {
          if (this.showSuggestions) {
            const filtered = this.getFilteredCommands();
            this.selectedSuggestion = (this.selectedSuggestion - 1 + filtered.length) % filtered.length;
            this.refresh();
          }
          return { consume: true };
        }
        if (data === "\x1b[B" || data === "\u001B[B") {
          if (this.showSuggestions) {
            const filtered = this.getFilteredCommands();
            this.selectedSuggestion = (this.selectedSuggestion + 1) % filtered.length;
            this.refresh();
          }
          return { consume: true };
        }
        if (data === "\r" || data === "\n") {
          if (this.showSuggestions) {
            const filtered = this.getFilteredCommands();
            if (filtered.length > 0 && this.selectedSuggestion < filtered.length) {
              this.inputValue = filtered[this.selectedSuggestion].command;
            }
          }
          this.handleSubmit();
          return { consume: true };
        }
        if (data === "\u007F" || data === "\b") {
          if (this.inputValue.length > 0) {
            this.inputValue = this.inputValue.slice(0, -1);
            this.updateSuggestions();
            this.refresh();
          }
          return { consume: true };
        }
        if (data === "\t") {
          if (this.showSuggestions) {
            const filtered = this.getFilteredCommands();
            this.selectedSuggestion = (this.selectedSuggestion + 1) % filtered.length;
            this.refresh();
          }
          return { consume: true };
        }
        const code = data.charCodeAt(0);
        if (data.length >= 1 && code >= 32) {
          this.inputValue += data;
          this.updateSuggestions();
          this.refresh();
          return { consume: true };
        }
      }
      return undefined;
    });
  }

  override stop(): void {
    if (this.blinkInterval) clearInterval(this.blinkInterval);
    if (this.thinkingInterval) clearInterval(this.thinkingInterval);
    super.stop();
  }
}

const app = new ClaudeCodeTUI();
if (process.argv[1] === import.meta.filename) {
  app.run();
}
