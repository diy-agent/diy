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
  constructor(content: string) {
    super(content);
  }
}

/**
 * Header component with blue background styling.
 */
export class Header extends PiText {
  constructor(private title: string) {
    super("");
  }

  render(width: number): string[] {
    return [chalk.bgBlueBright.black.bold(` ${this.title} `.padEnd(width))];
  }
}

/**
 * Horizontal rule divider with optional label.
 */
export class Rule extends PiText {
  constructor(private label = "") {
    super("");
  }

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
  constructor(
    private value: string,
    private color: "blue" | "cyan" | "green" | "yellow" | "red" | "magenta" = "cyan"
  ) {
    super("");
  }

  render(width: number): string[] {
    const styled = chalk[this.color].black.bold(` ${this.value} `);
    return [truncateToWidth(styled, width, "", true)];
  }
}

/**
 * Log line with colored prefix.
 */
export class LogLine extends PiText {
  constructor(
    private prefix: string,
    private content: string,
    private accent: "cyan" | "green" | "yellow" | "red" | "magenta" = "cyan"
  ) {
    super("");
  }

  render(width: number): string[] {
    const rendered = `${chalk[this.accent].bold(this.prefix)} ${this.content}`;
    return [truncateToWidth(rendered, width, "", true)];
  }
}
