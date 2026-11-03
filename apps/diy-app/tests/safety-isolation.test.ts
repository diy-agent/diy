// tests/safety-isolation.test.ts
// ═══════════════════════════════════════════════════════════════
// 🛡️ 测试隔离安全 — 锁死「测试绝不触碰生产数据」
//
// 背景：只隔离 DIY_HOME 是半成品。src/main/core/project.ts 的 expandPath 用
// homedir() 展开 `~`，而 homedir() 在 POSIX 读 $HOME —— 若 HOME 未隔离，
// meta.yaml 里的 `path: ~/git/...`（生产数据正是这个形态）会解析到真实仓库，
// removeProject 便会在真实仓库里摘掉 diy.yaml 的 project 名片。
//
// 本文件断言隔离的完整性：任何一条失败都意味着"跑测试有写坏生产数据的风险"。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { diyHome, projectsRoot, norm } from "../src/main/core/state";

describe("测试隔离安全", () => {
  it("DIY_HOME 必须指向临时目录", () => {
    expect(diyHome().startsWith(tmpdir())).toBe(true);
    expect(projectsRoot().startsWith(tmpdir())).toBe(true);
  });

  it("HOME 必须隔离：homedir() 不得指向真实家目录", () => {
    const real = process.env["DIY_REAL_HOME"];
    expect(real, "setup.ts 应留档真实家目录到 DIY_REAL_HOME").toBeTruthy();
    expect(homedir()).not.toBe(real);
    expect(homedir().startsWith(tmpdir())).toBe(true);
  });

  it("`~` 展开必须落在隔离目录内（expandPath 不会写到真实仓库）", () => {
    // 复刻 project.ts expandPath 的展开方式
    const expanded = resolve("~/git/diy/diy".replace(/^~/, homedir()));
    expect(expanded.startsWith(diyHome())).toBe(true);
    // ⚠️ 不能拿「落在真实家目录之下」当危险判据：Windows 的 tmpdir 本身就是
    // `C:\\Users\\<user>\\AppData\\Local\\Temp`，隔离 HOME 天然是真实家目录的**子树**
    // （POSIX 的 /tmp 在家目录外，所以这个断言在 mac/Linux 上是巧合成立的）。
    // 真正的危险是「落回真实仓库路径」—— 直接比那个。
    const realRepo = [String(process.env["DIY_REAL_HOME"]), "git", "diy", "diy"].join("/");
    expect(resolve(expanded.replace(/\\/g, "/"))).not.toBe(resolve(realRepo));
    expect(expanded.startsWith(diyHome())).toBe(true);
  });

  it("norm() 不会把隔离目录外的绝对路径误判为 ~", () => {
    const real = process.env["DIY_REAL_HOME"]!;
    // 真实家目录下的路径在隔离环境里应保持绝对形式（不折叠成 ~）。
    // 比对时两边都过 `resolve()`：Windows 下 `${real}/git/diy/diy` 是混合分隔符，
    // 而 norm 返回的是 resolve 过的纯 `\` 形式 —— 不归一就是拿字串比“写法”而不是比路径。
    const realRepo = `${real}/git/diy/diy`;
    expect(norm(realRepo)).toBe(resolve(realRepo));
    // 隔离目录内的路径才折叠成 ~
    expect(norm(`${diyHome()}/repos/a`)).toBe("~/repos/a");
  });
});
