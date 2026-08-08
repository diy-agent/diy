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
    };
  }
}
