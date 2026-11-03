// tests/core/temp-home.test.ts — 隔离 HOME 的生命周期护栏
//
// 这是 rm -rf 代码：删错对象代价是灾难性的。故把「两道校验」当契约测死：
//   ① 只删系统临时目录之下的；② 只删带本套件前缀的。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SETUP_HOME_PREFIX, TEST_HOME_PREFIX, removeIsolatedHome, sweepStaleTestHomes } from "../temp-home";

let made: string[] = [];

function makeHome(prefix = TEST_HOME_PREFIX, root = tmpdir()): string {
  const p = mkdtempSync(join(root, prefix));
  writeFileSync(join(p, "app.port"), "12345");
  made.push(p);
  return p;
}

beforeEach(() => {
  made = [];
});

afterEach(() => {
  // 测试自己造的目录：直接删（守卫只认前缀 + tmpdir，走 removeIsolatedHome 亦可）
  for (const p of made) { try { rmSync(p, { recursive: true, force: true }); } catch {} }
});

describe("removeIsolatedHome —— 只删该删的", () => {
  it("临时目录下带前缀的目录：删", () => {
    const p = makeHome();
    expect(existsSync(p)).toBe(true);
    removeIsolatedHome(p);
    expect(existsSync(p)).toBe(false);
  });

  it("setup.ts 的前缀（diy-desktop-test-）也认：删", () => {
    const p = makeHome(SETUP_HOME_PREFIX);
    removeIsolatedHome(p);
    expect(existsSync(p)).toBe(false);
  });

  it("前缀不匹配：绝不删（防 rm -rf 打偏）", () => {
    const p = makeHome("not-ours-");
    removeIsolatedHome(p);
    expect(existsSync(p)).toBe(true);
  });

  it("不在系统临时目录下：绝不删", () => {
    // 造一个「看起来像」但不在 tmpdir 下的路径：直接拿一个真实存在的非临时目录
    removeIsolatedHome(join(process.cwd(), "package.json"));
    expect(existsSync(join(process.cwd(), "package.json"))).toBe(true);
    removeIsolatedHome("/tmp"); // 是 tmpdir 但前缀不匹配
    expect(existsSync("/tmp")).toBe(true);
  });

  it("不存在的路径：静默（不抛）", () => {
    expect(() => removeIsolatedHome(join(tmpdir(), TEST_HOME_PREFIX + "nope-xyz"))).not.toThrow();
  });
});

describe("sweepStaleTestHomes —— 按龄清扫", () => {
  // ⚠️ 每条用例自带沙箱根（sweep 的 root 参数），**不扫全局 tmpdir**：
  // 并行跑（`test-unit` 已开 --fileParallelism）时 setup.ts 在**每个** worker 里都会扫一遍
  // 全局临时目录，别的 worker 会把本用例刚拨老的目录先删掉 → `removed` 恒为 0，用例必红。
  // 沙箱根名不带本套件前缀 → 任何 sweep 都不会把它当目标（只有本用例显式传它）。
  let sandbox = "";
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "diy-sweep-sandbox-"));
  });
  afterEach(() => {
    try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
  });

  it("超龄目录被删、新鲜目录保留", () => {
    const old = makeHome(TEST_HOME_PREFIX, sandbox);
    const fresh = makeHome(TEST_HOME_PREFIX, sandbox);
    // 把 old 的 mtime 拨到 48h 前
    const past = (Date.now() - 48 * 3600 * 1000) / 1000;
    utimesSync(old, past, past);

    const removed = sweepStaleTestHomes(24 * 3600 * 1000, sandbox);
    expect(removed).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("setup.ts 前缀的超龄目录也被清（##255 R2-2 的回归点）", () => {
    const old = makeHome(SETUP_HOME_PREFIX, sandbox);
    const past = (Date.now() - 48 * 3600 * 1000) / 1000;
    utimesSync(old, past, past);
    sweepStaleTestHomes(24 * 3600 * 1000, sandbox);
    expect(existsSync(old)).toBe(false);
  });

  it("前缀不匹配的目录不归它管", () => {
    const foreign = makeHome("foreign-test-", sandbox);
    const past = (Date.now() - 48 * 3600 * 1000) / 1000;
    utimesSync(foreign, past, past);
    sweepStaleTestHomes(24 * 3600 * 1000, sandbox);
    expect(existsSync(foreign)).toBe(true);
    removeIsolatedHome(foreign); // 前缀不匹配 → 删不掉，靠 rmSync 兜底
  });
});
