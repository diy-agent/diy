/**
 * Scheduler — rerun 调度策略
 *
 * 每个 ScopeNode 可有独立的 Scheduler。
 * signal 写入 → scheduler.schedule(cell) → cell.rerun()
 *
 * 参考: design doc §9
 */

// ── Scheduler 接口 ────────────────────────────────────────

/**
 * Scheduler 接口 — 定义 rerun 调度策略
 */
export interface Scheduler {
  /** 标记 cell 为脏，等待 rerun */
  schedule(cell: CellRef): void;
  /** 立即处理所有挂起的 rerun */
  flush(): void;
}

/**
 * CellRef — Scheduler 操作的轻量引用
 */
export interface CellRef {
  /** 执行 rerun */
  rerun(): void;
  /** 树的深度（用于排序） */
  getDepth(): number;
}

// ── ImmediateScheduler ────────────────────────────────────

/**
 * ImmediateScheduler — dev 默认，signal 写入立即触发 rerun
 */
export class ImmediateScheduler implements Scheduler {
  schedule(cell: CellRef): void {
    cell.rerun();
  }

  flush(): void {
    // 不需要，schedule 时已立即执行
  }
}

// ── PeriodicScheduler ─────────────────────────────────────

/**
 * PeriodicScheduler — 定时批量执行，去重 + 深度排序
 */
export class PeriodicScheduler implements Scheduler {
  private dirty = new Set<CellRef>();
  private timer?: ReturnType<typeof setInterval>;
  private periodMs: number;

  constructor(periodMs: number = 16) {
    this.periodMs = periodMs;
    this.timer = setInterval(() => this.flush(), periodMs);
  }

  schedule(cell: CellRef): void {
    this.dirty.add(cell);
  }

  flush(): void {
    if (this.dirty.size === 0) return;

    const cells = [...this.dirty];
    this.dirty.clear();

    // 按树深度排序：浅层先执行
    cells.sort((a, b) => a.getDepth() - b.getDepth());

    for (const cell of cells) {
      cell.rerun();
    }
  }

  /** 释放定时器资源 */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
