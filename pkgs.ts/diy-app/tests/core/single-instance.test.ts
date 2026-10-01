// tests/core/single-instance.test.ts
// 单实例锁诊断（shared 逻辑；main/dev/CLI 三处共用，见 src/main/core/single-instance.ts）。
// 这条诊断链是「关窗常驻」的配套：锁被看不见的实例占着时，dev 与 CLI 都会沉默失败，
// 必须能回答「锁在哪 / 谁占着 / 是死是活 / 下一步」。
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  SINGLETON_LOCK,
  classifyLock,
  holderAlive,
  lockAdvice,
  lockIsLocal,
  readLock,
} from "../../src/main/core/single-instance";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "diy-lock-"));
  dirs.push(d);
  return d;
}

/** 造一个指向 `host-pid` 的锁 symlink（模拟 Chromium 留下的形态） */
function fakeLock(target: string): string {
  const dir = tmp();
  const lock = join(dir, SINGLETON_LOCK);
  symlinkSync(target, lock);
  return lock;
}

describe("readLock —— 读锁文件（异常折叠，不抛错）", () => {
  it("不存在 → free（无锁）", () => {
    const info = readLock(join(tmp(), SINGLETON_LOCK));
    expect(info.raw).toBeNull();
    expect(info.holderPid).toBeNull();
    expect(info.unreadable).toBe(false);
  });

  it("symlink → 解析出本机 hostname 与持有者 pid", () => {
    const lock = fakeLock(`${hostname()}-4242`);
    const info = readLock(lock);
    expect(info.raw).toBe(`${hostname()}-4242`);
    expect(info.holderPid).toBe(4242);
    expect(info.host).toBe(hostname());
  });

  it("主机名带 - 也能按尾部 -数字 切出 pid（hostname 可含连字符）", () => {
    const lock = fakeLock("my-host-2-999");
    expect(readLock(lock).holderPid).toBe(999);
  });

  it("普通文件（不是 symlink）→ unreadable", () => {
    const dir = tmp();
    const lock = join(dir, SINGLETON_LOCK);
    writeFileSync(lock, "not-a-symlink");
    expect(readLock(lock).unreadable).toBe(true);
  });
});

describe("classifyLock —— 三种处境", () => {
  it("本机 + 活进程 → held（关窗常驻实例的形态）", () => {
    // holderAlive 用 ps 查真实存在性：这里拿**自己**的 pid 当持有者，必然活
    const lock = fakeLock(`${hostname()}-${process.pid}`);
    expect(classifyLock(readLock(lock))).toEqual({ kind: "held", holderPid: process.pid });
  });

  it("本机 + 进程已不在 → stale（陈旧锁）", () => {
    const lock = fakeLock(`${hostname()}-999999`);
    const s = classifyLock(readLock(lock));
    expect(s.kind).toBe("stale");
  });

  it("别处的 hostname → alien（跨机共享文件系统）", () => {
    const lock = fakeLock("other-host-4242");
    expect(classifyLock(readLock(lock)).kind).toBe("alien");
    expect(lockIsLocal(readLock(lock))).toBe(false);
  });

  it("无锁 → free", () => {
    expect(classifyLock(readLock(join(tmp(), SINGLETON_LOCK))).kind).toBe("free");
  });

  it("非 symlink → unreadable", () => {
    const dir = tmp();
    const lock = join(dir, SINGLETON_LOCK);
    writeFileSync(lock, "x");
    expect(classifyLock(readLock(lock)).kind).toBe("unreadable");
  });
});

describe("holderAlive —— 探活（ps，不递送信号）", () => {
  it("自己 → 活", () => expect(holderAlive(process.pid)).toBe(true));
  it("非法值 → 不活（不误查）", () => {
    expect(holderAlive(0)).toBe(false);
    expect(holderAlive(-1)).toBe(false);
    expect(holderAlive(1.5)).toBe(false);
  });
});

describe("lockAdvice —— 按处境给下一步，不是「失败了」", () => {
  const lockPath = "/tmp/SingletonLock";
  it("held → 教用户「用它 或 退出它」", () => {
    const a = lockAdvice({ kind: "held", holderPid: 7 }, lockPath);
    expect(a).toContain("./diy.sh"); // 直接用它
    expect(a).toContain(lockPath); // 锁文件路径要能定位
    expect(a).toContain("常驻");
  });

  it("stale → 教用户「重试/删锁」", () => {
    const a = lockAdvice({ kind: "stale", holderPid: 7 }, lockPath);
    expect(a).toContain("陈旧");
    expect(a).toContain(lockPath);
  });

  it("free → 指向日志（不是锁的问题）", () => {
    expect(lockAdvice({ kind: "free" }, lockPath)).toContain("main.log");
  });
});
