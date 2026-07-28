/**
 * async-queue.ts — 可取消的异步队列，桥接 push 和 AsyncIterator
 *
 * 替换之前手写3次的 queue + resolveWait + ended + cancelled 模式。
 */

export class AsyncQueue<T> {
  private _queue: T[] = [];
  private _resolveWait: ((item: IteratorResult<T>) => void) | null = null;
  private _ended = false;
  private _err: Error | null = null;

  push(value: T): void {
    if (this._ended) return;
    if (this._resolveWait) {
      const r = this._resolveWait;
      this._resolveWait = null;
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
      r({ value: undefined, done: true });
    }
  }

  error(err: Error): void {
    if (this._ended) return;
    this._err = err;
    this._ended = true;
    if (this._resolveWait) {
      const r = this._resolveWait;
      this._resolveWait = null;
      r({ value: undefined, done: true });
    }
  }

  get ended(): boolean { return this._ended; }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this._err) throw this._err;
        if (this._queue.length > 0) {
          return { value: this._queue.shift()!, done: false };
        }
        if (this._ended) return { value: undefined, done: true };
        return new Promise(r => { this._resolveWait = r; });
      },
    };
  }
}
