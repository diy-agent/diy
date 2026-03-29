import {
  Text as PiText,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import { t, applyStyles, type TStyle } from "./styles.js";

export type StyleSet = TStyle | TStyle[];

/**
 * Basic text label component with style support.
 */
export class Text extends PiText {
  private _content: string;
  private _style?: StyleSet;

  constructor(props: { content: string; style?: StyleSet }) {
    super("");
    this._content = props.content;
    this._style = props.style;
  }

  render(width: number): string[] {
    const text = truncateToWidth(this._content, width, "…");
    return [this._style ? applyStyles(text, this._style) : text];
  }
}

/**
 * Header component with blue background styling by default.
 */
export class Header extends Text {
  constructor(props: { title: string; style?: StyleSet }) {
    super({
      content: props.title,
      style: props.style ?? t.bg_blue_300.text_black.font_bold,
    });
  }

  render(width: number): string[] {
    // Fill the background for the entire width
    const title = ` ${this["_content"]} `.padEnd(width);
    const style = this["_style"] ?? t.bg_blue_300.text_black.font_bold;
    return [applyStyles(title, style)];
  }
}

/**
 * Colored pill badge component.
 */
export class Pill extends Text {
  constructor(props: { value: string; style?: StyleSet }) {
    super({
      content: ` ${props.value} `,
      style: props.style ?? t.bg_cyan_300.text_black.font_bold,
    });
  }

  render(width: number): string[] {
    const text = truncateToWidth(this["_content"], width, "", true);
    return [this["_style"] ? applyStyles(text, this["_style"]) : text];
  }
}

/**
 * Horizontal rule divider with optional label.
 */
export class Rule extends PiText {
  private label: string;
  private style?: StyleSet;

  constructor(props: { label?: string; style?: StyleSet } = {}) {
    super("");
    this.label = props.label ?? "";
    this.style = props.style;
  }

  render(width: number): string[] {
    const lineStyle = this.style ?? t.font_dim;

    if (!this.label) {
      return [applyStyles("─".repeat(width), lineStyle)];
    }

    const text = ` ${this.label} `;
    const remaining = Math.max(0, width - visibleWidth(text));
    const left = Math.floor(remaining / 2);
    const right = remaining - left;

    const line = `${"─".repeat(left)}${text}${"─".repeat(right)}`;
    return [applyStyles(line, lineStyle)];
  }
}

/**
 * Log line with styled prefix.
 */
export class LogLine extends Text {
  private prefix: string;
  private prefixStyle: TStyle;

  constructor(props: {
    prefix: string;
    content: string;
    prefixStyle?: TStyle;
    style?: StyleSet;
  }) {
    super({ content: props.content, style: props.style });
    this.prefix = props.prefix;
    this.prefixStyle = props.prefixStyle ?? t.text_cyan_300.font_bold;
  }

  render(width: number): string[] {
    const prefixStr = this.prefixStyle.apply(this.prefix);
    const contentStr = this["_style"]
      ? applyStyles(this["_content"], this["_style"])
      : this["_content"];

    const rendered = `${prefixStr} ${contentStr}`;
    return [truncateToWidth(rendered, width, "", true)];
  }
}
