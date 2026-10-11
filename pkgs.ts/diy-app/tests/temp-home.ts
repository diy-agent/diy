// tests/temp-home.ts
// 🎯 测试隔离 HOME 的**生命周期**：创建约定、删除、历史残留清扫。
//
// 为什么单独成模块（不放在 electron-test.ts）：setup.ts 需要在**每个**测试文件开跑时清扫一次，
// 而 electron-test.ts import 了 `electron`（会触发二进制下载/加载）。若 setup 直接 import 它，
// 连纯单测（prompt-registry 等）都会被迫拉 electron。这里只用 node:fs/os，零副作用。

import { rmSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

/** electron-test 隔离 HOME 的目录名前缀（与 makeIsolatedHome 的 mkdtemp 模板一致） */
export const TEST_HOME_PREFIX = "diy-app-test-";

/**
 * setup.ts 为**每个测试文件**分配的隔离 HOME 前缀（`mkdtempSync` 模板见 setup.ts）。
 *
 * 为什么两套前缀都要管：两处都往 `$TMPDIR` 里造目录，漏一处就是「测试越跑磁盘越涨」——
 * 实测 `diy-desktop-test-*` 一天积 1500 个 / 25MB（setupFiles 每个文件跑一次，从不删）。
 */
export const SETUP_HOME_PREFIX = "diy-desktop-test-";

/** 本套件在系统临时目录下造的全部隔离 HOME 前缀（remove / sweep 一律按它判归属） */
export const TEST_HOME_PREFIXES = [TEST_HOME_PREFIX, SETUP_HOME_PREFIX] as const;

/** 目录名是否本套件所造（两道校验之一，见 removeIsolatedHome） */
function isOursName(name: string): boolean {
  return TEST_HOME_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * 删除一个隔离 HOME —— 只删「我们自己造的、位于系统临时目录下」的那种。
 *
 * 两道校验缺一不可（历史注释「测试目录不删除」正是怕 rm -rf 打偏到生产数据）：
 *   ① 路径必须在 os.tmpdir() 之下；② basename 必须是我们的前缀。
 * 都满足时删错对象的概率为零。
 *
 * 为什么必须删：不删的代价实测很大 —— 单目录 ~1.8MB（几乎全是 electron_user_data），
 * 累积到 1583 个 / 2.9GB（4 天）。磁盘无限涨，每次跑测试都在给系统临时区加压。
 */
export function removeIsolatedHome(home: string): void {
  const tmp = tmpdir();
  if (!home.startsWith(tmp + "/") || !isOursName(basename(home))) return;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* 删不掉就留着（下次 sweep 再试），绝不影响测试结论 */
  }
}

/**
 * 清扫历史残留：删掉系统临时目录下**超过 ageMs 未改动**的本套件 HOME。
 * 按 mtime 判龄 → 并发跑的其它 worktree 的活跃目录不会被误删。
 * 返回删除数量；任何 IO 异常都吞掉（清理是加分项，不是测试前提）。
 */
export function sweepStaleTestHomes(ageMs = 24 * 60 * 60 * 1000): number {
  const tmp = tmpdir();
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(tmp);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - ageMs;
  for (const name of names) {
    if (!isOursName(name)) continue;
    const p = join(tmp, name);
    try {
      if (statSync(p).mtimeMs < cutoff) {
        rmSync(p, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* 竞态（正好被别人删了）→ 忽略 */
    }
  }
  return removed;
}
