import {
  Text as PiText,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import chalk from "chalk";

/**
 * Basic text label component.
 */
export class Text extends PiText {
  constructor(props: { content: string }) {
    super(props.content);
  }
}

/**
 * Header component with blue background styling.
 */
export class Header extends PiText {
  private title: string;

  constructor(props: { title: string }) {
    super("");
    this.title = props.title;
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
  private label: string;

  constructor(props: { label?: string } = {}) {
    super("");
    this.label = props.label ?? "";
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
  private value: string;
  private color: "blue" | "cyan" | "green" | "yellow" | "red" | "magenta";

  constructor(props: {
    value: string;
    color?: "blue" | "cyan" | "green" | "yellow" | "red" | "magenta";
  }) {
    super("");
    this.value = props.value;
    this.color = props.color ?? "cyan";
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
  private prefix: string;
  private content: string;
  private accent: "cyan" | "green" | "yellow" | "red" | "magenta";

  constructor(props: {
    prefix: string;
    content: string;
    accent?: "cyan" | "green" | "yellow" | "red" | "magenta";
  }) {
    super("");
    this.prefix = props.prefix;
    this.content = props.content;
    this.accent = props.accent ?? "cyan";
  }

  private prefix: string;
  private content: string;
  private accent: "cyan" | "green" | "yellow" | "red" | "magenta";

  render(width: number): string[] {
    const rendered = `${chalk[this.accent].bold(this.prefix)} ${this.content}`;
    return [truncateToWidth(rendered, width, "", true)];
  }
}
