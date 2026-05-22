/**
 * CellHost — rerun block 管理
 *
 * .cell(fn) 标记 ScopeNode 为 rerun 块：
 *   - 定义时立即执行首次挂载
 *   - signal 变化通过 scheduler 触发 rerun
 *   - staging rerun：清空 children → 执行 fn → 失败恢复旧 children
 *
 * 参考: design doc §5
 */

import type { ScopeNode } from "./scope.js";
import type { ContextManager } from "./scope.js";
import type { Scheduler, CellRef } from "./scheduler.js";

export class CellHost<T extends ScopeNode = ScopeNode> implements CellRef {
  private ctxMgr: ContextManager;
  private cellNode: T;
  private fn: (node: T) => void;

  constructor(ctxMgr: ContextManager, cellNode: T, fn: (node: T) => void) {
    this.ctxMgr = ctxMgr;
    this.cellNode = cellNode;
    this.fn = fn;
  }

  /**
   * 执行 rerun：
   * 1. 备份旧 children
   * 2. 推入 context 栈
   * 3. 清空 children + 执行 fn
   * 4. 失败恢复旧 children
   * 5. 弹出 context
   */
  rerun(): void {
    const oldChildren = [...this.cellNode.children];

    this.ctxMgr.pushContext(this.cellNode);
    try {
      this.cellNode.clearChildren();
      this.fn(this.cellNode);
    } catch (e) {
      // 失败恢复旧 children
      this.cellNode.replaceChildren(oldChildren);
      throw e;
    } finally {
      this.ctxMgr.popContext();
    }
  }

  /** 获取 cellNode 的深度 */
  getDepth(): number {
    return this.cellNode.depth;
  }

  /** 获取 cellNode */
  get node(): T {
    return this.cellNode;
  }
}

/**
 * CellCapable — 可标记 cell 的 ScopeNode 混入接口
 *
 * 用于 .cell() 链式调用（app.column().cell(fn)）
 */
export interface CellCapable<T extends ScopeNode> {
  cell(fn: (node: T) => void): T;
}
