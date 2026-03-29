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
  private message: ChatMessage;

  constructor(props: { message: ChatMessage }) {
    super("");
    this.message = props.message;
  }

  private message: ChatMessage;

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
  private value: string;
  private placeholder: string;
  private cursorVisible: boolean;

  constructor(props: {
    value: string;
    placeholder?: string;
    cursorVisible?: boolean;
  }) {
    super("");
    this.value = props.value;
    this.placeholder = props.placeholder ?? "Type a message...";
    this.cursorVisible = props.cursorVisible ?? true;
  }

  private value: string;
  private placeholder: string;
  private cursorVisible: boolean;

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
  private command: string;
  private description: string;
  private selected: boolean;

  constructor(props: {
    command: string;
    description: string;
    selected: boolean;
  }) {
    super("");
    this.command = props.command;
    this.description = props.description;
    this.selected = props.selected;
  }

  private command: string;
  private description: string;
  private selected: boolean;

  render(width: number): string[] {
    const prefix = this.selected ? chalk.cyan('▶ ') : '  ';
    const cmd = chalk.bold.yellow(this.command.padEnd(12));
    const desc = chalk.dim.gray(this.description);
    const line = prefix + cmd + desc;
    return [truncateToWidth(line, width, "", true)];
  }
}
