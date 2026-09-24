/**
 * async-queue.ts — 可取消的异步队列，桥接 push 和 AsyncIterator
 *
 * 替换之前手写3次的 queue + resolveWait + ended + cancelled 模式。
 * error() 会 reject 正在挂起的 next()，让消费方（for-await）抛错而非干净结束。
 */

/** @internal */
export class _AsyncQueue<T> {
  private _queue: T[] = [];
  private _resolveWait: ((item: IteratorResult<T>) => void) | null = null;
  private _rejectWait: ((err: Error) => void) | null = null;
  private _ended = false;
  private _err: Error | null = null;
  private _onReturn: (() => void) | null = null;

  /**
   * 注册「消费端提前终止」回调，用于把取消传播回上游。
   *
   * 唯一触发时机是迭代器的 `return()` —— 即 for-await 因 break / 循环体抛错 /
   * 外层 return 而退出时，语言规范强制调用的清理路径（正常消费到 end() 不触发）。
   * 队列本身不认识传输层，只负责在这一个时点回调，由调用方决定发什么帧。
   */
  onReturn(cb: () => void): void {
    if (this._ended) return; // 已结束：取消了也没人再消费，避免调用方误发取消帧
    this._onReturn = cb;
  }

  push(value: T): void {
    if (this._ended) return;
    if (this._resolveWait) {
      const r = this._resolveWait;
      this._resolveWait = null;
      this._rejectWait = null;
      r({ value, done: false });
    } else {
      this._queue.push(value);
    }
  }

  end(): void {
    if (this._ended) return;
    this._ended = true;
    if (this._resolveWait) {
      const r = this._resolveWait;
      this._resolveWait = null;
      this._rejectWait = null;
      r({ value: undefined, done: true });
    }
  }

  error(err: Error): void {
    if (this._ended) return;
    this._err = err;
    this._ended = true;
    if (this._resolveWait) {
      const rej = this._rejectWait;
      this._resolveWait = null;
      this._rejectWait = null;
      if (rej) rej(err); // 让挂起的 next() 抛错，而非干净结束
    }
  }

  get ended(): boolean { return this._ended; }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> =>
        new Promise<IteratorResult<T>>((resolve, reject) => {
          if (this._err) { reject(this._err); return; }
          if (this._queue.length > 0) {
            resolve({ value: this._queue.shift()!, done: false });
            return;
          }
          if (this._ended) { resolve({ value: undefined, done: true }); return; }
          this._resolveWait = resolve;
          this._rejectWait = reject;
        }),

      /**
       * 消费端提前退出时，for-await 会调用并 await 它。
       *
       * 此前这里只实现了 next，return 为 undefined ⇒ 消费端离开对上游**零信号**：
       * 生产者继续产出、继续占用资源（实测任务 149：renderer 被销毁后服务端多跑
       * 1 分 45 秒 / 16 步工具调用，且会话互斥锁直到那轮自然结束才释放）。
       * 补上它，取消才有确定性的传播起点。
       */
      return: (value?: unknown): Promise<IteratorResult<T>> => {
        this._ended = true;
        if (this._resolveWait) {
          const r = this._resolveWait;
          this._resolveWait = null;
          this._rejectWait = null;
          r({ value: undefined, done: true });
        }
        try {
          this._onReturn?.();
        } catch {
          // 取消传播失败不应让 return() 本身抛错 —— 它只负责干净地告知「我不再消费了」
        }
        return Promise.resolve({ value: value as T, done: true });
      },
    };
  }
}
