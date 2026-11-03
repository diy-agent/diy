// tests/core/fs-lock.test.ts
// 🎯 意图测试：文件锁获取与释放

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "../../src/main/core/state";
import { tryLock } from "../../src/main/core/fs-lock";

describe("tryLock", () => {
  it("获取成功返回 release 函数", async () => {
    const lockPath = join(diyHome(), "test-lock");
    const lock = await tryLock(lockPath, 1000);
    expect(lock).not.toBeNull();
    expect(lock!.release).toBeTypeOf("function");
    await lock!.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("释放后可以重新获取", async () => {
    const lockPath = join(diyHome(), "test-lock-2");
    const lock1 = await tryLock(lockPath, 1000);
    expect(lock1).not.toBeNull();
    await lock1!.release();

    const lock2 = await tryLock(lockPath, 1000);
    expect(lock2).not.toBeNull();
    await lock2!.release();
  });
});
