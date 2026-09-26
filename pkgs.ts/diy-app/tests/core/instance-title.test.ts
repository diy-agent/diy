// tests/core/instance-title.test.ts
// 窗口标题的组装规则（纯函数）—— 它是「这是哪个实例」的唯一标识，规则写死在这里，
// main 与 renderer 两侧共用同一份实现（见 src/shared/instance-title.ts）。
import { describe, it, expect } from "vitest";
import { abbrevHome, instanceTitle, APP_NAME } from "../../src/shared/instance-title";

describe("abbrevHome —— 数据根相对**真实家目录**缩 `~`", () => {
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

  it("隔离实例的临时数据根照实显示绝对路径（任务 177：曾经这里是 `~`）", () => {
    // 测试/隔离实例把 $HOME 指向 mkdtemp 后 DIY_HOME === $HOME。
    // 若缩写基准是 $HOME 就会产出 `~` —— 把 /tmp 临时根伪装成用户家目录，标题彻底失去信息。
    // 基准换成真实家目录（getpwuid）后，它就是个普通的外部路径。
    expect(abbrevHome("/tmp/diy-desktop-test-abc", "/Users/ccc")).toBe("/tmp/diy-desktop-test-abc");
  });

  it("前缀相同但不是子路径 → 不误缩（/Users/ccc2 不在 /Users/ccc 之下）", () => {
    expect(abbrevHome("/Users/ccc2/.diy", "/Users/ccc")).toBe("/Users/ccc2/.diy");
  });

  it("空数据根 → 空串（由 instanceTitle 兜成 `?`）", () => {
    expect(abbrevHome("", "/Users/ccc")).toBe("");
  });
});

describe("instanceTitle —— `diy(<数据根>) [环境] <分支> :<端口> pid <PID>`", () => {
  it("生产只给数据根：日常用的就是生产，多余文字只是噪音", () => {
    expect(instanceTitle({ homeDisplay: "~/.diy", env: "production" })).toBe("diy(~/.diy)");
  });

  it("dev / test 带后缀：界面与生产几乎一样，必须能看出来", () => {
    expect(instanceTitle({ homeDisplay: "~/.diy", env: "development" })).toBe("diy(~/.diy) [dev]");
    expect(instanceTitle({ homeDisplay: "~/.diy", env: "test" })).toBe("diy(~/.diy) [test]");
  });

  it("分支 / 端口 / PID 依次追加，顺序固定（阅读顺序 = 排查顺序）", () => {
    expect(
      instanceTitle({
        homeDisplay: "~/git/diy/_diy.worktrees/instance-title/build/home",
        env: "development",
        branch: "feat/instance-title",
        port: 18888,
        pid: 4242,
      }),
    ).toBe(
      "diy(~/git/diy/_diy.worktrees/instance-title/build/home) [dev] feat/instance-title :18888 pid 4242",
    );
  });

  it("测试实例：临时数据根 + 分支 + 端口 + PID 全在（/tmp 目录靠分支认出来源）", () => {
    expect(
      instanceTitle({
        homeDisplay: "/tmp/diy-app-test-abc123",
        env: "test",
        branch: "feat/instance-title",
        port: 52341,
        pid: 53087,
      }),
    ).toBe("diy(/tmp/diy-app-test-abc123) [test] feat/instance-title :52341 pid 53087");
  });

  it("缺分支/端口/PID 的段直接不出现（不留 `:0` / `pid 0` 这类占位）", () => {
    expect(
      instanceTitle({ homeDisplay: "~/.diy", env: "production", branch: null, port: null, pid: null }),
    ).toBe("diy(~/.diy)");
    expect(instanceTitle({ homeDisplay: "~/.diy", env: "test", branch: "" })).toBe(
      "diy(~/.diy) [test]",
    );
    // 窗口刚创建时端口还没绑定，此时标题里就只有数据根 + 环境 + 分支
    expect(
      instanceTitle({ homeDisplay: "/tmp/x", env: "test", branch: "main", port: null, pid: 7 }),
    ).toBe("diy(/tmp/x) [test] main pid 7");
  });

  it("数据根缺失 → `diy(?)`（显眼的问号，不冒充生产默认值）", () => {
    expect(instanceTitle({ homeDisplay: "", env: "production" })).toBe("diy(?)");
  });

  it("未知 env 不加后缀（宁可当生产，也不猜一个标签出来）", () => {
    expect(instanceTitle({ homeDisplay: "~/.diy", env: "staging" })).toBe("diy(~/.diy)");
    expect(instanceTitle({ homeDisplay: "~/.diy", env: "" })).toBe("diy(~/.diy)");
  });

  it("应用名来自唯一常量（改前缀只改一处）", () => {
    expect(instanceTitle({ homeDisplay: "~/.diy", env: "production" }).startsWith(APP_NAME)).toBe(
      true,
    );
  });
});
