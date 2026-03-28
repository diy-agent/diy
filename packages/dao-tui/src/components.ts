import {
  Text as PiText,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import chalk from "chalk";

/**
 * Basic text label component.
 */
export class Label extends PiText {
  constructor({ content }: { content: string }) {
    super(content);
  }
}

/**
 * Header component with blue background styling.
 */
export class Header extends PiText {
  constructor({ title }: { title: string }) {
    super("");
    this.title = title;
  }

  private title: string;

  render(width: number): string[] {
    return [chalk.bgBlueBright.black.bold(` ${this.title} `.padEnd(width))];
  }
}

/**
 * Horizontal rule divider with optional label.
 */
export class Rule extends PiText {
  constructor({ label = "" }: { label?: string }) {
    super("");
    this.label = label;
  }

  private label: string;

  render(width: number): string[] {
    if (!this.label) {
      return [chalk.dim("─".repeat(width))];
    }

    const text = ` ${this.label} `;
    const remaining = Math.max(0, width - visibleWidth(text));
    const left = Math.floor(remaining / 2);
    const right = remaining - left;
    return [chalk.dim(`${"─".repeat(left)}${text}${"─".repeat(right)}`)];
  }
}

/**
 * Colored pill badge component.
 */
export class Pill extends PiText {
  constructor({ 
    value, 
    color = "cyan" 
  }: { 
    value: string; 
    color?: "blue" | "cyan" | "green" | "yellow" | "red" | "magenta";
  }) {
    super("");
    this.value = value;
    this.color = color;
  }

  private value: string;
  private color: "blue" | "cyan" | "green" | "yellow" | "red" | "magenta";

  render(width: number): string[] {
    const styled = chalk[this.color].black.bold(` ${this.value} `);
    return [truncateToWidth(styled, width, "", true)];
  }
}

/**
 * Log line with colored prefix.
 */
export class LogLine extends PiText {
  constructor({ 
    prefix, 
    content, 
    accent = "cyan" 
  }: { 
    prefix: string; 
    content: string; 
    accent?: "cyan" | "green" | "yellow" | "red" | "magenta";
  }) {
    super("");
    this.prefix = prefix;
    this.content = content;
    this.accent = accent;
  }

  private prefix: string;
  private content: string;
  private accent: "cyan" | "green" | "yellow" | "red" | "magenta";

  render(width: number): string[] {
    const rendered = `${chalk[this.accent].bold(this.prefix)} ${this.content}`;
    return [truncateToWidth(rendered, width, "", true)];
  }
}
