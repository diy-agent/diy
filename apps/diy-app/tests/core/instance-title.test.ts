// 窗口标题格式：仓库路径🔹数据根🔹端口🔹PID。
import { describe, it, expect } from "vitest";
import { abbrevHome, instanceTitle } from "../../src/shared/instance-title";

describe("abbrevHome", () => {
  it("真实家目录下缩成 ~", () => {
    expect(abbrevHome("/Users/ccc/.diy", "/Users/ccc")).toBe("~/.diy");
  });
  it("测试临时根不误缩成 ~", () => {
    expect(abbrevHome("/tmp/diy-test", "/Users/ccc")).toBe("/tmp/diy-test");
  });
});

describe("instanceTitle", () => {
  it("严格使用仓库🔹数据根🔹port🔹pid 格式", () => {
    expect(
      instanceTitle({
        repoDisplay: "~/git/diy/diy",
        homeDisplay: "~/.diy",
        env: "production",
        port: 18888,
        pid: 5252,
      }),
    ).toBe("~/git/diy/diy🔹~/.diy🔹port:18888🔹pid:5252");
  });
  it("端口未绑定时显示 ?，绑定后由 main 重设", () => {
    expect(
      instanceTitle({ repoDisplay: "~/git/diy/diy", homeDisplay: "/tmp/test", env: "test", port: null, pid: 7 }),
    ).toBe("~/git/diy/diy🔹/tmp/test🔹port:?🔹pid:7");
  });
});
