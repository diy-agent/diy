import {
  Text as PiText,
  truncateToWidth,
} from "@mariozechner/pi-tui";
import { applyStyles, type TStyle } from "./styles.js";

export type StyleSet = TStyle | TStyle[];

export interface TextProps {
  content: string;
  style?: StyleSet;
}

/**
 * The fundamental primitive for rendering text in TUI.
 * Purely functional: Takes content and applies Tailwind-like styles.
 */
export class Text extends PiText {
  private _content: string;
  private _style?: StyleSet;

  constructor(props: TextProps) {
    super("");
    this._content = props.content;
    this._style = props.style;
  }

  render(width: number): string[] {
    // 1. Apply styles (some styles like w_full or text_center will use the width)
    const rendered = this._style 
      ? applyStyles(this._content, this._style, width) 
      : this._content;

    // 2. Final truncation for safety
    return [truncateToWidth(rendered, width, "…")];
  }
}
