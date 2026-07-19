// src/main/core/fs-lock.ts
// 🎯 文件锁：pid 文件 + 原子 mkdir，防止多实例冲突

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { diyHome } from "./state";

/**
 * 尝试获取文件锁（基于 pid 文件）。
 * 获取成功返回 release 函数，失败返回 null。
 */
export function tryLock(lockPath: string, timeout = 3000): { release(): void } | null {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      // 原子创建：mkdir 在已存在时会抛异常
      mkdirSync(lockPath, { recursive: false });
      // 写入 pid
      writeFileSync(join(lockPath, "pid"), String(process.pid), "utf-8");
      return {
        release: () => {
          try {
            rmSync(lockPath, { recursive: true, force: true });
          } catch {
            /* 其他进程可能已清理 */
          }
        },
      };
    } catch {
      // 目录已存在（被其他进程锁定）
      // 检查 pid 文件是否过期
      const pidFile = join(lockPath, "pid");
      if (existsSync(pidFile)) {
        try {
          const pid = parseInt(readFileSync(pidFile, "utf-8"), 10);
          // macOS: kill -0 检查进程是否存在
          try {
            process.kill(pid, 0);
            // 进程还活着，继续等待
          } catch {
            // 进程已死，释放锁
            try {
              rmSync(lockPath, { recursive: true, force: true });
            } catch {}
            continue;
          }
        } catch {
          /* pid 文件损坏 */
        }
      }
      // 等待重试
      const wait = Math.min(100, timeout - (Date.now() - start));
      if (wait > 0) {
        // 忙等待（桌面工具场景，微秒级争抢）
      }
    }
  }
  return null;
}

/** 获取 app.lock 路径（与旧版兼容） */
export function appLockPath(): string {
  return join(diyHome(), "app.lock");
}
