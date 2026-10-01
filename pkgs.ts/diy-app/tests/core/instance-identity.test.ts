// tests/core/instance-identity.test.ts
// main 侧的实例身份取值：真实家目录缩写 + git 分支探测（见 src/main/core/instance-identity.ts）。
//
// 为什么单测而不是只靠意图测试：这两条都要「$HOME 被隔离」或「一个仓库 / 一个非仓库目录」这类
// 前提，纯函数 + 临时目录能直接摆出来；意图测试（cli.intent.ui-title）只锁最终标题形态。
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentGitBranch,
  homeDisplayOf,
  realHomeDir,
  resetGitBranchCache,
} from "../../src/main/core/instance-identity";

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  resetGitBranchCache();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("realHomeDir / homeDisplayOf —— 缩写基准是真实家目录", () => {
  it("realHomeDir 不受 $HOME 改写影响（setup.ts 已把 $HOME 指到隔离目录）", () => {
    // 这条断言就是「测试时全是 ~」的根因防线：
    // 若它退化到读 $HOME，下面的 homeDisplayOf 断言会一起变红。
    expect(homedir()).not.toBe(realHomeDir());
    expect(realHomeDir().startsWith(tmpdir())).toBe(false); // 不落在 mkdtemp 的隔离根下
  });

  it("真实家目录之下的数据根缩 `~`", () => {
    expect(homeDisplayOf(join(realHomeDir(), ".diy"))).toBe("~/.diy");
    expect(homeDisplayOf(join(realHomeDir(), "git/diy/diy/build/home"))).toBe(
      "~/git/diy/diy/build/home",
    );
  });

  it("隔离实例的临时数据根保持绝对路径（不再缩成 `~`）", () => {
    const isolated = tempDir("diy-ui-home-");
    expect(homeDisplayOf(isolated)).toBe(isolated);
  });
});

describe("currentGitBranch —— 从给定目录上溯找 .git", () => {
  it("临时仓库里回分支名（worktree 的 .git 是文件，同一路径）", () => {
    const dir = tempDir("diy-branch-");
    initRepo(dir, "feat/tmp-branch");
    resetGitBranchCache();
    expect(currentGitBranch(dir)).toBe("feat/tmp-branch");
    // 从子目录上溯也能找到（main 的调用点是 out/main，也在仓库子目录里）
    mkdirSync(join(dir, "pkgs.ts/diy-app/out/main"), { recursive: true });
    resetGitBranchCache();
    expect(currentGitBranch(join(dir, "pkgs.ts/diy-app/out/main"))).toBe("feat/tmp-branch");
  });

  it("detached HEAD → `<短 sha>(detached)`（不显示无意义的字面量 HEAD）", () => {
    const dir = tempDir("diy-branch-detached-");
    initRepo(dir, "main");
    execFileSync("git", ["-C", dir, "checkout", "-q", "--detach"], { stdio: "ignore" });
    resetGitBranchCache();
    const branch = currentGitBranch(dir);
    expect(branch).not.toBe("HEAD");
    expect(branch).toMatch(/^[0-9a-f]+\(detached\)$/);
  });

  it("非仓库目录 → null（打包后的 app / serve 部署目录就是这种）", () => {
    const dir = tempDir("diy-branch-nogit-");
    resetGitBranchCache();
    expect(currentGitBranch(dir)).toBeNull();
  });
});

/** 造一个带一次提交的临时仓库（关掉 GPG 签名：本机全局开了 commit.gpgsign） */
function initRepo(dir: string, branch: string): void {
  execFileSync("git", ["-C", dir, "init", "-q", "-b", branch], { stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "tmp\n");
  execFileSync("git", ["-C", dir, "add", "."], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "init",
    ],
    { stdio: "ignore" },
  );
  if (!existsSync(join(dir, ".git"))) throw new Error("临时仓库初始化失败");
}
