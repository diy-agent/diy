import {
  Container as PiContainer,
  truncateToWidth,
} from "@mariozechner/pi-tui";
import { Header } from "./components.js";
import { Rule } from "./components.js";
import type { ComponentGenerator } from "./types.js";

/**
 * Horizontal layout container.
 * Uses a generator function to yield child components horizontally.
 */
export class Horizontal extends PiContainer {
  constructor(
    { gap = 0 }: { gap?: number },
    generator: ComponentGenerator
  ) {
    super();
    this.gap = gap;
    for (const child of generator()) {
      this.addChild(child);
    }
  }

  private gap: number;

  render(width: number): string[] {
    if (this.children.length === 0) return [];

    const totalGap = Math.max(0, this.gap) * Math.max(0, this.children.length - 1);
    const childWidth = Math.max(1, Math.floor((width - totalGap) / this.children.length));
    const allChildLines = this.children.map((c) => c.render(childWidth));
    const maxLines = Math.max(...allChildLines.map((l) => l.length));

    const result: string[] = [];
    for (let i = 0; i < maxLines; i++) {
      let line = "";
      for (let j = 0; j < allChildLines.length; j++) {
        const content = allChildLines[j][i] || "";
        line += truncateToWidth(content, childWidth, "", true);
        if (j < allChildLines.length - 1 && this.gap > 0) line += " ".repeat(this.gap);
      }
      result.push(line);
    }
    return result;
  }
}

/**
 * Vertical layout container.
 * Uses a generator function to yield child components vertically.
 */
export class Vertical extends PiContainer {
  constructor(
    { gap = 0 }: { gap?: number },
    generator: ComponentGenerator
  ) {
    super();
    this.gap = gap;
    for (const child of generator()) {
      this.addChild(child);
    }
  }

  private gap: number;

  render(width: number): string[] {
    const lines: string[] = [];
    for (let i = 0; i < this.children.length; i++) {
      lines.push(...this.children[i].render(width));
      if (i < this.children.length - 1 && this.gap > 0) {
        lines.push(...new Array(this.gap).fill(""));
      }
    }
    return lines;
  }
}

/**
 * Panel container with a title, optional footer, and body content.
 * Uses generator functions for body and footer.
 */
export class Panel extends PiContainer {
  constructor(
    { title }: { title: string },
    body: ComponentGenerator,
    footer?: ComponentGenerator
  ) {
    super();
    this.addChild(new Header({ title }));
    this.addChild(new Rule({}));
    for (const child of body()) {
      this.addChild(child);
    }
    if (footer) {
      this.addChild(new Rule({}));
      for (const child of footer()) {
        this.addChild(child);
      }
    }
  }
}
