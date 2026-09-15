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
    expect(expanded.startsWith(process.env["DIY_REAL_HOME"]!)).toBe(false);
  });

  it("norm() 不会把隔离目录外的绝对路径误判为 ~", () => {
    const real = process.env["DIY_REAL_HOME"]!;
    // 真实家目录下的路径在隔离环境里应保持绝对形式（不折叠成 ~）
    expect(norm(`${real}/git/diy/diy`)).toBe(`${real}/git/diy/diy`);
    // 隔离目录内的路径才折叠成 ~
    expect(norm(`${diyHome()}/repos/a`)).toBe("~/repos/a");
  });
});
