import type { Transport, ErrorPayload, StreamHandle } from '../transport/types';
import type { Envelope, CallMsg } from '../transport/types';
import { RpcError, fromErrorPayload } from './error';
import type { CallOptions, RawClient } from './raw';
import { AsyncQueue } from './async-queue';

export type { CallOptions };

interface PendingEntry {
  onMessage: (msg: CallMsg) => boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface StreamEntry {
  push: (value: unknown) => void;
  end: (error?: ErrorPayload) => void;
}

export class ChannelRawClient implements RawClient {
  private _reqId = 0;
  private unsub: () => void;
  private pending = new Map<number, PendingEntry>();
  private streams = new Map<number, StreamEntry>();
  private disposed = false;

  constructor(
    private transport: Transport,
    private defaultTimeout?: number,
  ) {
    this.unsub = this.transport.on((msg: Envelope) => {
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
  }

  dispose(): void {
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
          if (msg.error) reject(fromErrorPayload(msg.error));
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

  send<TReq = unknown>(method: string, params?: TReq): void {
    if (this.disposed) return;
    this.transport.send({ type: 'notify', method, params });
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

    const queue = new AsyncQueue<TYield>();

    const streamId = await new Promise<number>((resolve, reject) => {
      const entry: PendingEntry = {
        onMessage: (msg) => {
          if (msg.stream != null) {
            resolve(msg.stream as number);
          } else if (msg.error) {
            reject(fromErrorPayload(msg.error));
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
        if (err) queue.error(fromErrorPayload(err));
        else queue.end();
      },
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        this.streams.delete(streamId);
        queue.end();
        this.transport.send({ type: 'end', stream: streamId });
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
            reject(fromErrorPayload(msg.error));
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

    return new Promise<TRes>((resolve, reject) => {
      const entry: PendingEntry = {
        onMessage: (msg) => {
          if (msg.error) reject(fromErrorPayload(msg.error));
          else resolve(msg.result as TRes);
          return true;
        },
      };
      this.pending.set(id, entry);
    });
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

    const queue = new AsyncQueue<TChunkOut>();

    const streamId = await new Promise<number>((resolve, reject) => {
      const entry: PendingEntry = {
        onMessage: (msg) => {
          if (msg.stream != null) {
            resolve(msg.stream as number);
          } else if (msg.error) {
            reject(fromErrorPayload(msg.error));
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
        if (err) queue.error(fromErrorPayload(err));
        else queue.end();
      },
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        this.streams.delete(streamId);
        queue.end();
        this.transport.send({ type: 'end', stream: streamId });
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
