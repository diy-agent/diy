import {
  Text as PiText,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import chalk from "chalk";

/**
 * Chat message structure for chat bubbles.
 */
export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
};

/**
 * Chat bubble component for displaying chat messages.
 */
export class ChatBubble extends PiText {
  constructor(private message: ChatMessage) {
    super("");
  }

  render(width: number): string[] {
    const roleTag = this.message.role === 'user'
      ? chalk.bgBlue.black.bold(' You ')
      : chalk.bgMagenta.black.bold(' Claude ');

    const lines: string[] = [];
    lines.push('');
    lines.push(roleTag);

    // Split content into lines that fit width
    const words = this.message.content.split(' ');
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (visibleWidth(testLine) <= width - 2) {
        currentLine = testLine;
      } else {
        lines.push(chalk.white('  ' + currentLine));
        currentLine = word;
      }
    }
    if (currentLine) {
      lines.push(chalk.white('  ' + currentLine));
    }

    lines.push('');
    return lines;
  }
}

/**
 * Text input component with prompt and cursor.
 */
export class Input extends PiText {
  constructor(
    private value: string,
    private placeholder: string = "Type a message...",
    private cursorVisible: boolean = true
  ) {
    super("");
  }

  render(width: number): string[] {
    const prompt = chalk.blue.bold("> ");
    let display = this.value;

    if (!display && !this.cursorVisible) {
      display = chalk.gray.dim(this.placeholder);
    } else if (this.cursorVisible) {
      const cursor = chalk.bgWhite.black(" ");
      if (display.length === 0) {
        display = cursor;
      } else {
        display = display + cursor;
      }
    }

    const fullLine = prompt + display;
    return [truncateToWidth(fullLine, width, "", true)];
  }
}

/**
 * Slash command suggestion item with selection state.
 */
export class SlashCommandSuggestion extends PiText {
  constructor(
    private command: string,
    private description: string,
    private selected: boolean
  ) {
    super("");
  }

  render(width: number): string[] {
    const prefix = this.selected ? chalk.cyan('▶ ') : '  ';
    const cmd = chalk.bold.yellow(this.command.padEnd(12));
    const desc = chalk.dim.gray(this.description);
    const line = prefix + cmd + desc;
    return [truncateToWidth(line, width, "", true)];
  }
}
