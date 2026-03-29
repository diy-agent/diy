import chalk from "chalk";
import { visibleWidth } from "@mariozechner/pi-tui";

/**
 * TStyle: A Tailwind-inspired styling utility for TUI.
 */
export class TStyle {
  private readonly _styles: Array<(text: string, width: number) => string>;

  constructor(styles: Array<(text: string, width: number) => string> = []) {
    this._styles = styles;
  }

  apply(text: string, width: number = 0): string {
    return this._styles.reduce((acc, style) => style(acc, width), text);
  }

  concat(other: TStyle): TStyle {
    return new TStyle([...this._styles, ...other._styles]);
  }

  private _next(style: (text: string, width: number) => string): TStyle {
    return new TStyle([...this._styles, style]);
  }

  // --- PAINT STYLES (Colors/Decorations) ---
  get text_white() { return this._next((s) => chalk.white(s)); }
  get text_black() { return this._next((s) => chalk.black(s)); }
  get text_gray_500() { return this._next((s) => chalk.gray(s)); }
  get text_blue_500() { return this._next((s) => chalk.blue(s)); }
  get text_red_500() { return this._next((s) => chalk.red(s)); }
  get text_yellow_500() { return this._next((s) => chalk.yellow(s)); }
  
  get bg_blue_500() { return this._next((s) => chalk.bgBlue(s)); }
  get bg_blue_300() { return this._next((s) => chalk.bgBlueBright(s)); }
  get bg_red_500() { return this._next((s) => chalk.bgRed(s)); }
  get bg_yellow_500() { return this._next((s) => chalk.bgYellow(s)); }
  get bg_cyan_500() { return this._next((s) => chalk.bgCyan(s)); }
  get bg_magenta_500() { return this._next((s) => chalk.bgMagenta(s)); }
  get bg_white() { return this._next((s) => chalk.bgWhite(s)); }
  get bg_black() { return this._next((s) => chalk.bgBlack(s)); }

  get font_bold() { return this._next((s) => chalk.bold(s)); }
  get font_dim() { return this._next((s) => chalk.dim(s)); }
  get font_underline() { return this._next((s) => chalk.underline(s)); }

  // --- LAYOUT STYLES ---
  get px_1() { return this._next((s) => ` ${s} `); }
  get px_2() { return this._next((s) => `  ${s}  `); }
  get px_4() { return this._next((s) => `    ${s}    `); }

  get w_full() { 
    return this._next((s, w) => s + " ".repeat(Math.max(0, w - visibleWidth(s)))); 
  }
  
  get text_center() {
    return this._next((s, w) => {
      const vWidth = visibleWidth(s);
      const space = Math.max(0, w - vWidth);
      const left = Math.floor(space / 2);
      const right = space - left;
      return " ".repeat(left) + s + " ".repeat(right);
    });
  }

  get text_right() { 
    return this._next((s, w) => " ".repeat(Math.max(0, w - visibleWidth(s))) + s); 
  }

  get w_1_2() { return this._next((s, w) => s + " ".repeat(Math.max(0, Math.floor(w * 0.5) - visibleWidth(s)))); }
  get w_1_3() { return this._next((s, w) => s + " ".repeat(Math.max(0, Math.floor(w * 0.33) - visibleWidth(s)))); }
  get w_2_3() { return this._next((s, w) => s + " ".repeat(Math.max(0, Math.floor(w * 0.66) - visibleWidth(s)))); }
}

export const t = new TStyle();

export function applyStyles(text: string, styles: TStyle | TStyle[], width: number = 0): string {
  if (Array.isArray(styles)) {
    return styles.reduce((acc, s) => s.apply(acc, width), text);
  }
  return styles.apply(text, width);
}
