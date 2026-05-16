import {
  TUI as PiTUI,
  ProcessTerminal as PiProcessTerminal,
  Container as PiContainer,
  type Component,
} from "@earendil-works/pi-tui";
import { effect } from "@vue/reactivity";
import type { ComponentGenerator } from "./types.js";

/**
 * Abstract base class for xx-tui applications.
 * Subclasses implement the `compose` generator method to define the UI structure.
 */
export abstract class App extends PiContainer {
  public readonly tui: PiTUI;
  protected terminal: PiProcessTerminal;
  public readonly isVSCodeTerminal: boolean;

  constructor() {
    super();
    this.terminal = new PiProcessTerminal();
    // Detect VS Code terminal - IME issue workaround
    this.isVSCodeTerminal = process.env.TERM_PROGRAM === 'vscode';
    // Disable raw mode for VSCode to allow IME (Chinese/English) input
    // Raw mode required for interactive arrow keys but breaks IME in VSCode
    const useRawMode = !this.isVSCodeTerminal;
    this.tui = new PiTUI(this.terminal, useRawMode);
    this.tui.addChild(this);
  }

  /**
   * Mount components: iterate through the generator returned by compose()
   * and add each component as a child.
   */
  public mount(): void {
    this.clear();
    for (const child of this.compose()) {
      this.addChild(child);
    }
  }

  /**
   * Rebuild UI and request a render.
   * Suitable for state-driven scenarios like demos and mock agents.
   */
  public refresh(): void {
    this.mount();
    this.tui.requestRender();
  }

  /**
   * Subclasses must implement this method, yielding components to define the UI.
   */
  abstract compose(): Iterable<Component>;

  /**
   * Start the TUI application.
   */
  public run(): void {
    // VSCode 终端下 Ctrl+C 可能以 SIGINT 而非 \u0003 到达，
    // 注册 SIGINT handler 作为后备退出方式
    process.on("SIGINT", () => {
      this.stop();
    });

    // Initial mount and render, automatically tracking reactive dependencies
    // accessed during the compose() phase.
    effect(() => {
      this.mount();
      this.tui.requestRender();
    });

    this.tui.start();

    // Default exit logic
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
 * Concrete App implementation that uses a generator function from closure.
 * Allows functional style with closure-based state instead of class inheritance.
 */
export class FunctionalApp extends App {
  private readonly composeFn: () => Iterable<Component>;

  constructor(composeFn: () => Iterable<Component>) {
    super();
    this.composeFn = composeFn;
  }

  override compose(): Iterable<Component> {
    return this.composeFn();
  }
}

/**
 * Factory function to create a functional app with closure-based state.
 * 
 * Example:
 * ```ts
 * const app = createApp(function*() {
 *   let inputValue = ""; // state in closure, no `this` needed!
 *   yield new Panel("Chat", function*() {
 *     yield new Input(inputValue, "Type...");
 *   });
 * });
 * app.run();
 * ```
 */
export function createApp(composeFn: () => Iterable<Component>): FunctionalApp {
  return new FunctionalApp(composeFn);
}
