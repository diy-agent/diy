/**
 * 意图测试 —— pi-tui provider 的用户可感知行为（可无头构造，不需要真终端）。
 *
 * 覆盖的「特性」：
 *   1. app.box() 只渲染一次（子内容不重复出现）
 *   2. 横向排布用中文时，每行**显示宽度**正好等于给定宽度（列对齐）
 *   3. 多个 App 实例下，column.cell() 注册到自己所属的 App
 *   4. run() 不叠加 SIGINT 监听；stop() 摘掉监听、幂等、不退出进程
 */

import { describe, it, expect, vi } from "vitest";
import { visibleWidth } from "@mariozechner/pi-tui";
import { App } from "../src/providers/pi-tui.js";
import { ScopeConfig } from "../src/scope.js";

/** 构造 App（顺手吞掉 ProcessTerminal 初始化时写出的转义序列，保持测试输出干净）。 */
const makeApp = (): App => {
  const out = process.stdout as unknown as { write: (c: string) => boolean };
  const orig = out.write.bind(process.stdout);
  out.write = () => true;
  try {
    return silent(new App(new ScopeConfig({ mode: "dev" })));
  } finally {
    out.write = orig;
  }
};

/** 静音终端（测试里不需要真的进 raw mode / 写转义序列）。 */
function silent(app: App): App {
  const tui = app.tui as unknown as { start(): void; stop(): void };
  tui.start = () => {};
  tui.stop = () => {};
  app.terminal.stop = () => {};
  return app;
}

describe("特性：box 只渲染一次", () => {
  it("box 里的内容在整棵渲染结果里只出现一次", () => {
    const app = makeApp();
    app.box({}, () => {
      app.text("in-box");
    });

    const hits = app.render(30).filter((line) => line.includes("in-box"));
    expect(hits.length).toBe(1);
  });
});

describe("特性：横向排布在中文下仍对齐", () => {
  it("每行的显示宽度正好等于给定宽度", () => {
    const app = makeApp();
    const row = app.row(() => {
      app.text("中文");
      app.text("ab");
    });

    const lines = row.render(20);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(20);
    }
  });
});

describe("特性：cell 注册到自己的 App", () => {
  it("第二个 App 存在时，第一个 App 的 column.cell() 不会跑到别人身上", () => {
    const a = makeApp();
    const b = makeApp(); // 旧实现用模块级 currentApp，这里会被顶成 b
    const col = a.column();
    const spyA = vi.spyOn(a, "markCell");
    const spyB = vi.spyOn(b, "markCell");

    col.cell(() => {});
    expect(spyA).toHaveBeenCalledTimes(1);
    expect(spyB).not.toHaveBeenCalled();
  });
});

describe("特性：退出监听不泄漏、不替宿主杀进程", () => {
  it("run() 两次只加一个 SIGINT 监听；stop() 摘掉且幂等", () => {
    const app = makeApp();
    const base = process.listenerCount("SIGINT");

    app.run();
    app.run();
    expect(process.listenerCount("SIGINT")).toBe(base + 1);

    app.stop();
    expect(process.listenerCount("SIGINT")).toBe(base);

    app.stop(); // 幂等
    expect(process.listenerCount("SIGINT")).toBe(base);
  });
});
