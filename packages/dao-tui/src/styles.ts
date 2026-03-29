import chalk, { type ChalkInstance } from "chalk";

/**
 * TStyle: A Tailwind-inspired styling utility for TUI.
 */
export class TStyle {
  // We store a list of chalk-like functions to apply in sequence
  private readonly _styles: Array<(text: string) => string>;

  constructor(styles: Array<(text: string) => string> = []) {
    this._styles = styles;
  }

  /**
   * Final application of styles to a string.
   */
  apply(text: string): string {
    return this._styles.reduce((acc, style) => style(acc), text);
  }

  /**
   * Merges another style into this one.
   */
  concat(other: TStyle): TStyle {
    return new TStyle([...this._styles, ...other._styles]);
  }

  /**
   * Internal helper to create a new TStyle with an additional chalk style.
   */
  private _next(style: (text: string) => string): TStyle {
    return new TStyle([...this._styles, style]);
  }

  // --- GETTERS FOR CHAINING ---
  
  // Text Colors
  get text_black() { return this._next(chalk.black); }
  get text_red_500() { return this._next(chalk.red); }
  get text_red_300() { return this._next(chalk.redBright); }
  get text_green_500() { return this._next(chalk.green); }
  get text_green_300() { return this._next(chalk.greenBright); }
  get text_yellow_500() { return this._next(chalk.yellow); }
  get text_yellow_300() { return this._next(chalk.yellowBright); }
  get text_blue_500() { return this._next(chalk.blue); }
  get text_blue_300() { return this._next(chalk.blueBright); }
  get text_magenta_500() { return this._next(chalk.magenta); }
  get text_magenta_300() { return this._next(chalk.magentaBright); }
  get text_cyan_500() { return this._next(chalk.cyan); }
  get text_cyan_300() { return this._next(chalk.cyanBright); }
  get text_white() { return this._next(chalk.white); }
  get text_gray_500() { return this._next(chalk.gray); }

  // Background Colors
  get bg_black() { return this._next(chalk.bgBlack); }
  get bg_red_500() { return this._next(chalk.bgRed); }
  get bg_red_300() { return this._next(chalk.bgRedBright); }
  get bg_green_500() { return this._next(chalk.bgGreen); }
  get bg_green_300() { return this._next(chalk.bgGreenBright); }
  get bg_yellow_500() { return this._next(chalk.bgYellow); }
  get bg_yellow_300() { return this._next(chalk.bgYellowBright); }
  get bg_blue_500() { return this._next(chalk.bgBlue); }
  get bg_blue_300() { return this._next(chalk.bgBlueBright); }
  get bg_magenta_500() { return this._next(chalk.bgMagenta); }
  get bg_magenta_300() { return this._next(chalk.bgMagentaBright); }
  get bg_cyan_500() { return this._next(chalk.bgCyan); }
  get bg_cyan_300() { return this._next(chalk.bgCyanBright); }
  get bg_white() { return this._next(chalk.bgWhite); }

  // Fonts
  get font_bold() { return this._next(chalk.bold); }
  get font_italic() { return this._next(chalk.italic); }
  get font_underline() { return this._next(chalk.underline); }
  get font_dim() { return this._next(chalk.dim); }
}

export const t = new TStyle();

/**
 * Combines an array of styles and applies them to the text.
 */
export function applyStyles(text: string, styles: TStyle | TStyle[]): string {
  if (Array.isArray(styles)) {
    return styles.reduce((acc, s) => s.apply(acc), text);
  }
  return styles.apply(text);
}
