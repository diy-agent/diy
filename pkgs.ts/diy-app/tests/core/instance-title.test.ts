// tests/core/instance-title.test.ts
// 窗口标题的组装规则（纯函数）—— 它是「这是哪个实例」的唯一标识，规则写死在这里，
// main 与 renderer 两侧共用同一份实现（见 src/shared/instance-title.ts）。
import { describe, it, expect } from "vitest";
import { abbrevHome, instanceTitle, APP_NAME } from "../../src/shared/instance-title";

describe("abbrevHome —— 数据根缩 `~`", () => {
  it("数据根就是家目录 → `~`", () => {
    expect(abbrevHome("/Users/ccc", "/Users/ccc")).toBe("~");
  });

  it("数据根在家目录之下 → `~/...`", () => {
    expect(abbrevHome("/Users/ccc/.diy", "/Users/ccc")).toBe("~/.diy");
    expect(abbrevHome("/Users/ccc/git/diy/diy/build/home", "/Users/ccc")).toBe(
      "~/git/diy/diy/build/home",
    );
  });

  it("家目录带尾斜杠也能缩（不同来源的 homeDir 末尾可能带 /）", () => {
    expect(abbrevHome("/Users/ccc/.diy", "/Users/ccc/")).toBe("~/.diy");
  });

  it("不在家目录下 → 原样返回（测试用的 /tmp 临时目录属于这种）", () => {
    expect(abbrevHome("/tmp/diy-desktop-test-abc", "/Users/ccc")).toBe("/tmp/diy-desktop-test-abc");
  });

  it("前缀相同但不是子路径 → 不误缩（/Users/ccc2 不在 /Users/ccc 之下）", () => {
    expect(abbrevHome("/Users/ccc2/.diy", "/Users/ccc")).toBe("/Users/ccc2/.diy");
  });

  it("空数据根 → 空串（由 instanceTitle 兜成 `?`）", () => {
    expect(abbrevHome("", "/Users/ccc")).toBe("");
  });
});

describe("instanceTitle —— `diy(<数据根>)` + 非生产后缀", () => {
  it("生产不带后缀：日常用的就是生产，多余文字只是噪音", () => {
    expect(instanceTitle("~/.diy", "production")).toBe("diy(~/.diy)");
  });

  it("dev / test 带后缀：界面与生产几乎一样，必须能看出来", () => {
    expect(instanceTitle("~/.diy", "development")).toBe("diy(~/.diy) [dev]");
    expect(instanceTitle("~/.diy", "test")).toBe("diy(~/.diy) [test]");
  });

  it("worktree 的隔离数据根照实显示（这才是区分实例的关键信息）", () => {
    expect(instanceTitle("~/git/diy/_diy.worktrees/nav-resize/build/home", "development")).toBe(
      "diy(~/git/diy/_diy.worktrees/nav-resize/build/home) [dev]",
    );
  });

  it("数据根缺失 → `diy(?)`（显眼的问号，不冒充生产默认值）", () => {
    expect(instanceTitle("", "production")).toBe("diy(?)");
  });

  it("未知 env 不加后缀（宁可当生产，也不猜一个标签出来）", () => {
    expect(instanceTitle("~/.diy", "staging")).toBe("diy(~/.diy)");
    expect(instanceTitle("~/.diy", "")).toBe("diy(~/.diy)");
  });

  it("应用名来自唯一常量（改前缀只改一处）", () => {
    expect(instanceTitle("~/.diy", "production").startsWith(APP_NAME)).toBe(true);
  });
});
