// src/main/services/async-queue.ts
// 🎯 `AsyncQueue`：把「命令式 push」的回调式事件源，桥接成 `AsyncIterable`（供 RPC serverStream yield）。
//
// 为什么单独一个模块：文件变更（file-watcher）与会话 op 增量（ops-feed）两处事件源
// 的桥接语义**完全相同**（首订阅者启动源、末订阅者关闭源、多订阅者各拿独立全量副本）。
// 复制第二份的必要性为零，而两份实现漂移会让「订阅泄漏 / 事件丢失」这类 bug 只在一处复现。

/**
 * 单订阅者的无界 FIFO 队列（`push` 进、`next` 出）。
 *
 * 「无界」是刻意的：这里承载的是事件流（op 增量 / 文件变更），丢弃即丢数据；
 * 消费端慢时的正确行为是背压到上游（`push` 端是本地内存数组，不是网络），而不是悄悄丢帧。
 */
export class AsyncQueue<T> {
  private q: T[] = [];
  private resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  push(v: T): void {
    if (this.closed) return;
    if (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: v, done: false });
    } else {
      this.q.push(v);
    }
  }

  close(): void {
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.q.length > 0) {
          return Promise.resolve({ value: this.q.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

/**
 * 包一个 `AsyncIterable`：消费端 `return()`（含 break / abort）时执行 `cleanup`，
 * 且**只执行一次**（正常读完 done 与主动 return 不会双重清理）。
 *
 * 这是订阅生命周期的唯一出口：注册表按它做「末订阅者关闭上游」——漏调即泄漏 chokidar/注册项。
 *
 * `signal`（RPC serverStream 的取消上下文，由 binding 注入）是**第二条出口**，且不可省：
 * 传输断开时 RPC 层调的是 `ctrl.abort()` + `void g.return()`，而 `return()` **排在悬挂的
 * `next()` 之后**（生成器卡在 `await inner.next()`，JS 规范下 return 请求只能排队）——
 * 于是「无事件期间断开」根本走不到上面那条出口：队列没人唤醒 → `cleanup` 不跑 → 订阅不释放
 * （症状：`subscriberCount` 虚高，直到下一条事件才归零）。监听 abort 把队列关掉即可让悬挂的
 * `next()` 立刻以 done 恢复，两条出口等价、都只跑一次。
 */
export function withCleanup<T>(
  q: AsyncQueue<T>,
  cleanup: () => void,
  signal?: AbortSignal,
): AsyncIterable<T> {
  let done = false;
  const onAbort = () => {
    q.close(); // 唤醒悬挂的 next()（此后有缓冲帧仍可读，close 只是不再阻塞）
    once();
  };
  const once = () => {
    if (done) return;
    done = true;
    signal?.removeEventListener("abort", onAbort);
    cleanup();
  };
  // 断连早于订阅（signal 已 abort）：立即收尾，不留悬挂
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    [Symbol.asyncIterator]: () => {
      const inner = q[Symbol.asyncIterator]();
      return {
        next: () =>
          inner.next().then((r) => {
            if (r.done) once();
            return r;
          }),
        return: () => {
          q.close();
          once();
          return Promise.resolve({ value: undefined, done: true as const });
        },
      };
    },
  };
}
