import {
  TUI as PiTUI,
  ProcessTerminal as PiProcessTerminal,
  Container as PiContainer,
  Text as PiText,
  truncateToWidth,
  type Component as PiComponent,
} from "@mariozechner/pi-tui";
import chalk from "chalk";

/**
 * 声明式容器基类
 * 子类通过实现 compose 生成器方法来定义 UI 结构
 */
export abstract class App extends PiContainer {
  protected tui: PiTUI;
  protected terminal: PiProcessTerminal;

  constructor() {
    super();
    this.terminal = new PiProcessTerminal();
    this.tui = new PiTUI(this.terminal, true);
    this.tui.addChild(this);
  }

  /**
   * 挂载组件：遍历 compose() 返回的迭代器并添加为子组件
   */
  public mount(): void {
    this.clear();
    for (const child of this.compose()) {
      this.addChild(child);
    }
  }

  /**
   * 子类需实现此方法，通过 yield 返回组件序列
   */
  abstract compose(): Iterable<PiComponent>;

  /**
   * 启动应用
   */
  public run(): void {
    this.mount();
    this.tui.start();
    this.tui.requestRender();

    // 默认退出逻辑
    this.tui.addInputListener((data) => {
      if (data.toLowerCase() === "q" || data === "\u0003") {
        this.stop();
        return { consume: true };
      }
      return undefined;
    });
  }

  public stop(): void {
    this.tui.stop();
    this.terminal.stop();
    process.exit(0);
  }
}

/**
 * 基础组件封装
 */

export class Label extends PiText {
  constructor(content: string) {
    super(content);
  }
}

export class Header extends PiText {
  constructor(private title: string) {
    super("");
  }

  render(width: number): string[] {
    return [chalk.bgBlue.white.bold(` ${this.title} `.padEnd(width))];
  }
}

/**
 * 布局容器
 */

export class Horizontal extends PiContainer {
  constructor(private gen: () => Iterable<PiComponent>) {
    super();
    for (const child of this.gen()) {
      this.addChild(child);
    }
  }

  render(width: number): string[] {
    if (this.children.length === 0) return [];
    
    const childWidth = Math.floor(width / this.children.length);
    const allChildLines = this.children.map((c) => c.render(childWidth));
    const maxLines = Math.max(...allChildLines.map((l) => l.length));
    
    const result: string[] = [];
    for (let i = 0; i < maxLines; i++) {
      let line = "";
      for (let j = 0; j < allChildLines.length; j++) {
        const content = allChildLines[j][i] || "";
        line += truncateToWidth(content, childWidth, "", true);
      }
      result.push(line);
    }
    return result;
  }
}

export class Vertical extends PiContainer {
    constructor(private gen: () => Iterable<PiComponent>) {
      super();
      for (const child of this.gen()) {
        this.addChild(child);
      }
    }
}
