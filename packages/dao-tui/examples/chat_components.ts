import {
  Text as PiText,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import { t } from "./styles.js";

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

  render(width: number): string[] {
    const roleTag = this.message.role === 'user'
      ? t.bg_blue_500.text_black.font_bold.apply(' You ')
      : t.bg_magenta_500.text_black.font_bold.apply(' Claude ');

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
        lines.push(t.text_white.apply('  ' + currentLine));
        currentLine = word;
      }
    }
    if (currentLine) {
      lines.push(t.text_white.apply('  ' + currentLine));
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

  render(width: number): string[] {
    const prompt = t.text_blue_500.font_bold.apply("> ");
    let display = this.value;

    if (!display && !this.cursorVisible) {
      display = t.text_gray_500.font_dim.apply(this.placeholder);
    } else if (this.cursorVisible) {
      const cursor = t.bg_white.text_black.apply(" ");
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

  render(width: number): string[] {
    const prefix = this.selected ? t.text_cyan_300.apply('▶ ') : '  ';
    const cmd = t.font_bold.text_yellow_500.apply(this.command.padEnd(12));
    const desc = t.font_dim.text_gray_500.apply(this.description);
    const line = prefix + cmd + desc;
    return [truncateToWidth(line, width, "", true)];
  }
}
