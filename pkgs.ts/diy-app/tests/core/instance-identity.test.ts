// tests/core/instance-identity.test.ts
// main 侧的实例身份取值：真实家目录缩写 + git 分支探测（见 src/main/core/instance-identity.ts）。
//
// 为什么单测而不是只靠意图测试：这两条都要「$HOME 被隔离」或「一个仓库 / 一个非仓库目录」这类
// 前提，纯函数 + 临时目录能直接摆出来；意图测试（cli.intent.ui-title）只锁最终标题形态。
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  cliEntryForRepo,
  currentGitBranch,
  homeDisplayOf,
  isProdDataHome,
  prodDataHome,
  realHomeDir,
  resetGitBranchCache,
  sameDataHome,
} from "../../src/main/core/instance-identity";

const tempDirs: string[] = [];
function tempDir(prefix: string, base = tmpdir()): string {
  const d = mkdtempSync(join(base, prefix));
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
    mkdirSync(join(dir, "pkgs.ts/diy-app/build/lab/main"), { recursive: true });
    resetGitBranchCache();
    expect(currentGitBranch(join(dir, "pkgs.ts/diy-app/build/lab/main"))).toBe("feat/tmp-branch");
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

// ── 开发态入口自证的共享判据（##255）──
describe("isProdDataHome / cliEntryForRepo —— 入口须与数据根匹配", () => {
  it("isProdDataHome：只认真实家目录下的 .diy", () => {
    expect(isProdDataHome(prodDataHome())).toBe(true);
    expect(isProdDataHome(realHomeDir())).toBe(false); // 家目录本身不是
    expect(isProdDataHome("/tmp/some-isolated-home")).toBe(false);
    // 相对/尾斜杠都归一后再比
    expect(isProdDataHome(prodDataHome() + "/")).toBe(true);
  });

  it("数据根 = 生产根 → 入口回落 PATH 上的 diy", () => {
    expect(cliEntryForRepo("/repo", prodDataHome())).toBe("diy");
  });

  it("数据根 = 隔离/开发/测试 → 入口是本 checkout 的 diy.sh", () => {
    expect(cliEntryForRepo("/repo", "/tmp/diy-test-xyz")).toBe(join("/repo", "diy.sh"));
    expect(cliEntryForRepo("/repo", "/repo/build/home")).toBe(join("/repo", "diy.sh"));
  });
});

// ── 实例身份同一性（##328：CLI 复用实例前必须回答「端口上那个是不是我」）──
describe("sameDataHome —— 同一数据根的写法归一", () => {
  it("尾斜杠 / `.` / `..` 归一后相等", () => {
    expect(sameDataHome("/tmp/diy-a", "/tmp/diy-a/")).toBe(true);
    expect(sameDataHome("/tmp/diy-a/b", "/tmp/diy-a/./b")).toBe(true);
    expect(sameDataHome("/tmp/diy-a/b/..", "/tmp/diy-a")).toBe(true);
  });

  it("不同的数据根不相等（哪怕都是 app.port 里记过的端口）", () => {
    expect(sameDataHome("/tmp/diy-a", "/tmp/diy-b")).toBe(false);
    expect(sameDataHome(prodDataHome(), join(prodDataHome(), "build", "home"))).toBe(false);
  });

  it("符号链接解到同一处才算相等", () => {
    const base = tempDir("diy-samehome-");
    const real = join(base, "real");
    mkdirSync(real);
    const link = join(base, "link");
    symlinkSync(real, link);
    expect(sameDataHome(link, real)).toBe(true);
  });

  it("路径不存在时退回写法归一，且不误判相等", () => {
    const missing = join(tmpdir(), "diy-missing-xyz-328");
    expect(sameDataHome(missing + "/", missing)).toBe(true); // 写法归一生效
    expect(sameDataHome(missing, missing + "-other")).toBe(false); // 不猜
  });

  // ── macOS 边界（源自 ##266 review 的探针 R4，并入此处）──────────────
  // `/tmp` 与 `/private/tmp` 在 macOS 上是同一处，但**只有路径存在时** realpath 才揭穿这一点
  // （不存在 → 两边都失败 → 退回字面比较 → 判不等）。用字面 `/tmp` 而非 tmpdir()：macOS 的
  // TMPDIR 通常指向 /var/folders（另有 /private/var 符号链接侧），要触这条边界必须点名 /tmp。

  it("已存在的 /tmp 与 /private/tmp 写法 → 判等（正常路径不受影响）", () => {
    const a = tempDir("diy-samehome-tmp-", "/tmp");
    expect(a.startsWith("/tmp/")).toBe(true);
    const privateSide = a.replace(/^\/tmp\//, "/private/tmp/");
    if (privateSide === a) return; // 非 macOS：/tmp 不是符号链接，本边界不存在
    expect(sameDataHome(a, privateSide)).toBe(true);
  });

  it("⚠️ 边界：路径**不存在**时 /tmp 与 /private/tmp 判不等（方向安全）", () => {
    const missing = `/tmp/diy-samehome-missing-${Date.now()}`;
    const privateSide = missing.replace(/^\/tmp\//, "/private/tmp/");
    if (privateSide === missing) return;
    // 同一处被判成两处 —— 安全方向：宁可不复用、也不串台（判等错向才危险）。
    // 现实不可达：实例跑起来后数据根必然已存在。
    expect(sameDataHome(missing, privateSide)).toBe(false);
    mkdirSync(missing, { recursive: true }); // 一旦创建，同一比较就正确了
    tempDirs.push(missing);
    expect(sameDataHome(missing, privateSide)).toBe(true);
  });
});
