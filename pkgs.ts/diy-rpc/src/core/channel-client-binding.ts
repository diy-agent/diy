import type { EnvelopeTransport, _ErrorPayload, StreamHandle } from './types';
import type { _Envelope, _CallMsg } from './types';
import { RpcError, _fromErrorPayload } from './error';
import type { CallOptions, ClientBinding } from './server-binding';
import { _AsyncQueue } from './_async-queue';

export type { CallOptions };

interface PendingEntry {
  onMessage: (msg: _CallMsg) => boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface StreamEntry {
  push: (value: unknown) => void;
  end: (error?: _ErrorPayload) => void;
}

export class ChannelClientBinding implements ClientBinding {
  private _reqId = 0;
  private unsub: () => void;
  private _onCloseUnsub: () => void;
  private pending = new Map<number, PendingEntry>();
  private streams = new Map<number, StreamEntry>();
  private disposed = false;

  constructor(
    private transport: EnvelopeTransport,
    private defaultTimeout?: number,
  ) {
    this.unsub = this.transport.on((msg: _Envelope) => {
      if (msg.type === 'call' && msg.id != null) {
        const entry = this.pending.get(msg.id);
        if (entry) {
          const done = entry.onMessage(msg);
          if (done) {
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
          }
        }
      } else if (msg.type === 'data' && msg.stream != null) {
        this.streams.get(msg.stream)?.push(msg.value);
      } else if (msg.type === 'end' && msg.stream != null) {
        const entry = this.streams.get(msg.stream);
        if (entry) {
          this.streams.delete(msg.stream);
          entry.end(msg.error);
        }
      }
    });
    // 传输层关闭（对端死亡）→ 自动 dispose，所有 pending 调用收到 DISPOSED 错误
    this._onCloseUnsub = this.transport.onClose(() => this.dispose());
  }

  dispose(): void {
    if (this.disposed) return; // 幂等：避免 onClose + 显式调用双重触发
    this._onCloseUnsub?.();
    this.disposed = true;
    this.unsub();
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.onMessage({ type: 'call', id, error: { code: 'DISPOSED', message: 'Client disposed' } });
    }
    this.pending.clear();
    for (const [sid, entry] of this.streams) {
      this.streams.delete(sid);
      entry.end({ code: 'DISPOSED', message: 'Client disposed' });
      // 本地收尾之外，还必须告知服务端「这条流我不要了」。
      // 此前只做 entry.end()（纯本地队列操作），服务端收不到任何信号 ⇒ 继续白跑。
      // 任务 149 现场：renderer 被 reload 销毁后，main 侧 agent 多跑了 1 分 45 秒
      // 才自然结束，期间会话互斥锁一直被占，用户发消息全被拒。
      this._sendCancel(sid);
    }
  }

  /** 通知服务端取消某条流（end 帧即取消信号，见 ChannelServerBinding._dispatch）。
   *  dispose 可能由 transport.onClose（对端已死）触发，此时发送注定失败 ——
   *  取消是尽力而为，不该让 dispose 抛错。 */
  private _sendCancel(streamId: number): void {
    try {
      this.transport.send({ type: 'end', stream: streamId });
    } catch {
      // 传输已断：对端 onClose 会自行清理，无需补救
    }
  }

  async invoke<TReq = unknown, TRes = unknown>(
    method: string,
    params?: TReq,
    options?: CallOptions,
  ): Promise<TRes> {
    const id = ++this._reqId;
    const { signal, timeout = this.defaultTimeout } = options ?? {};

    if (this.disposed) throw new RpcError('DISPOSED', 'Client disposed');
    if (signal?.aborted) throw new RpcError('ABORTED', 'Call aborted');

    return new Promise<TRes>((resolve, reject) => {
      const entry: PendingEntry = {
        onMessage: (msg) => {
          if (msg.error) reject(_fromErrorPayload(msg.error));
          else resolve(msg.result as TRes);
          return true;
        },
      };

      if (timeout != null && timeout > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError('TIMEOUT', `Invoke timed out after ${timeout}ms`));
        }, timeout);
      }

      this.pending.set(id, entry);
      this.transport.send({ type: 'call', id, method, params });

      if (signal) {
        signal.addEventListener('abort', () => {
          this.pending.delete(id);
          clearTimeout(entry.timer);
          reject(new RpcError('ABORTED', 'Call aborted'));
        }, { once: true });
      }
    });
  }

  async serverStream<TReq = unknown, TYield = unknown>(
    method: string,
    params?: TReq,
    options?: CallOptions,
  ): Promise<StreamHandle<TYield>> {
    const id = ++this._reqId;
    const { signal, timeout = this.defaultTimeout } = options ?? {};

    if (this.disposed) throw new RpcError('DISPOSED', 'Client disposed');
    if (signal?.aborted) throw new RpcError('ABORTED', 'Call aborted');

    const queue = new _AsyncQueue<TYield>();

    const streamId = await new Promise<number>((resolve, reject) => {
      const entry: PendingEntry = {
        onMessage: (msg) => {
          if (msg.stream != null) {
            resolve(msg.stream as number);
          } else if (msg.error) {
            reject(_fromErrorPayload(msg.error));
          } else {
            reject(new RpcError('INVALID_ACK', 'Expected stream ack'));
          }
          return true;
        },
      };

      if (timeout != null && timeout > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError('TIMEOUT', `Server stream init timed out after ${timeout}ms`));
        }, timeout);
      }

      this.pending.set(id, entry);
      this.transport.send({ type: 'call', id, method, params, stream: true });
    });

    this.streams.set(streamId, {
      push: (val) => queue.push(val as TYield),
      end: (err) => {
        if (err) queue.error(_fromErrorPayload(err));
        else queue.end();
      },
    });

    // 消费端提前退出（break / 组件卸载 / 外层 return）也要取消 —— 这条路径此前
    // 完全不发帧，是最常见的「悄悄白跑」来源（AbortSignal 只是其中一条通路）。
    // delete 的返回值兼作去重：服务端已 end 的流不在 map 里，不会重复发。
    queue.onReturn(() => {
      if (this.streams.delete(streamId)) this._sendCancel(streamId);
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        this.streams.delete(streamId);
        queue.end();
        this._sendCancel(streamId);
      }, { once: true });
    }

    return queue;
  }

  async clientStream<TReq = unknown, TChunk = unknown, TRes = unknown>(
    method: string,
    params: TReq,
    chunks: AsyncIterable<TChunk>,
    options?: CallOptions,
  ): Promise<TRes> {
    const id = ++this._reqId;
    const { signal, timeout = this.defaultTimeout } = options ?? {};

    if (this.disposed) throw new RpcError('DISPOSED', 'Client disposed');
    if (signal?.aborted) throw new RpcError('ABORTED', 'Call aborted');

    let streamId = 0;

    const streamIdPromise = new Promise<number>((resolve, reject) => {
      const entry: PendingEntry = {
        onMessage: (msg) => {
          if (msg.stream != null) {
            streamId = msg.stream as number;
            resolve(streamId);
            return false;
          }
          if (msg.error) {
            reject(_fromErrorPayload(msg.error));
            return true;
          }
          reject(new RpcError('INVALID_ACK', 'Expected stream ack'));
          return true;
        },
      };

      if (timeout != null && timeout > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError('TIMEOUT', `Client stream init timed out after ${timeout}ms`));
        }, timeout);
      }

      this.pending.set(id, entry);
      this.transport.send({ type: 'call', id, method, params, stream: true });
    });

    await streamIdPromise;

    if (signal) {
      signal.addEventListener('abort', () => {
        if (streamId) this.transport.send({ type: 'end', stream: streamId });
      }, { once: true });
    }

    // 先注册结果 pending，再发 chunk——避免服务端在循环期间提前回包时该 id 无
    // pending entry 而被丢（_dispatch 查不到直接忽略），导致 result promise 永不
    // 落定（并发负载下 setTimeout/setImmediate 时序错位会触发此竞态而挂起）。
    let resolveResult: (v: TRes) => void = () => {};
    let rejectResult: (e: unknown) => void = () => {};
    const resultPromise = new Promise<TRes>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.pending.set(id, {
      onMessage: (msg) => {
        if (msg.error) rejectResult(_fromErrorPayload(msg.error));
        else resolveResult(msg.result as TRes);
        return true;
      },
    });

    try {
      for await (const val of chunks) {
        if (signal?.aborted) break;
        this.transport.send({ type: 'data', stream: streamId, value: val });
      }
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.transport.send({ type: 'end', stream: streamId, error: { code: 'STREAM_ERROR', message: err.message } });
    }

    if (!signal?.aborted) {
      this.transport.send({ type: 'end', stream: streamId });
    }

    return resultPromise;
  }

  async bidiStream<TReq = unknown, TChunkIn = unknown, TChunkOut = unknown>(
    method: string,
    params: TReq,
    chunks: AsyncIterable<TChunkIn>,
    options?: CallOptions,
  ): Promise<StreamHandle<TChunkOut>> {
    const id = ++this._reqId;
    const { signal, timeout = this.defaultTimeout } = options ?? {};

    if (this.disposed) throw new RpcError('DISPOSED', 'Client disposed');
    if (signal?.aborted) throw new RpcError('ABORTED', 'Call aborted');

    const queue = new _AsyncQueue<TChunkOut>();

    const streamId = await new Promise<number>((resolve, reject) => {
      const entry: PendingEntry = {
        onMessage: (msg) => {
          if (msg.stream != null) {
            resolve(msg.stream as number);
          } else if (msg.error) {
            reject(_fromErrorPayload(msg.error));
          } else {
            reject(new RpcError('INVALID_ACK', 'Expected stream ack'));
          }
          return true;
        },
      };

      if (timeout != null && timeout > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError('TIMEOUT', `Bidi stream init timed out after ${timeout}ms`));
        }, timeout);
      }

      this.pending.set(id, entry);
      this.transport.send({ type: 'call', id, method, params, stream: true });
    });

    this.streams.set(streamId, {
      push: (val) => queue.push(val as TChunkOut),
      end: (err) => {
        if (err) queue.error(_fromErrorPayload(err));
        else queue.end();
      },
    });

    // 同 serverStream：消费端提前退出要通知服务端，否则下游停了、上游还在产出
    queue.onReturn(() => {
      if (this.streams.delete(streamId)) this._sendCancel(streamId);
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        this.streams.delete(streamId);
        queue.end();
        this._sendCancel(streamId);
      }, { once: true });
    }

    (async () => {
      try {
        for await (const val of chunks) {
          if (signal?.aborted) break;
          this.transport.send({ type: 'data', stream: streamId, value: val });
        }
      } catch {
        this.transport.send({ type: 'end', stream: streamId, error: { code: 'STREAM_ERROR', message: 'upstream error' } });
      }
      if (!signal?.aborted) this.transport.send({ type: 'end', stream: streamId });
    })();

    return queue;
  }
}
