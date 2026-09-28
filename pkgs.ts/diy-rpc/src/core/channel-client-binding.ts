import type { EnvelopeTransport, _ErrorPayload, StreamHandle } from './types';
import type { _Envelope, _CallMsg } from './types';
import { RpcError, _fromErrorPayload, _reasonToRpcError } from './error';
import type { CallOptions, ClientBinding } from './server-binding';
import { _AsyncQueue } from './_async-queue';

export type { CallOptions };

interface PendingEntry {
  onMessage: (msg: _CallMsg) => boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** 终态清理（移除 signal listener 等），由 dispatch 在 done 时调用；幂等 */
  cleanup?: () => void;
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
  /** 在飞调用的 signal listener 清理：所有终态（响应/超时/abort/消费完/dispose）都必须跑，
   *  共享长生命周期 signal 才不会累积已完成调用的闭包（任务 185）。 */
  private _cleanups = new Set<() => void>();

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
            entry.cleanup?.();
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
      // 'cancel' 是 client→server 单向帧，客户端不收
    });
    // 传输层关闭（对端死亡）→ 自动 dispose，所有 pending 调用收到 DISPOSED 错误
    this._onCloseUnsub = this.transport.onClose(() => this.dispose());
  }

  /** 发信封帧（传输关闭后 send 会抛）：dispose 后上传协程补发的帧静默丢弃，避免裸抛 */
  private _send(msg: _Envelope): void {
    try {
      this.transport.send(msg);
    } catch {
      // 对端已死
    }
  }

  /** 登记一次终态清理：settle 路径与 dispose 都会调用（幂等，跑完自动出集） */
  private _track(cleanup: () => void): () => void {
    let ran = false;
    const run = () => {
      if (ran) return;
      ran = true;
      this._cleanups.delete(run);
      cleanup();
    };
    this._cleanups.add(run);
    return run;
  }

  dispose(): void {
    if (this.disposed) return; // 幂等：避免 onClose + 显式调用双重触发
    this._onCloseUnsub?.();
    this.disposed = true;
    this.unsub();
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.onMessage({ type: 'call', id, error: { code: 'DISPOSED', message: 'Client disposed' } });
      // 未 ack 的 init / 在飞 unary：按 call.id 告知服务端放弃（否则服务端白跑）
      this._sendCancel({ id });
    }
    this.pending.clear();
    for (const [sid, entry] of this.streams) {
      this.streams.delete(sid);
      entry.end({ code: 'DISPOSED', message: 'Client disposed' });
      // 本地收尾之外，还必须告知服务端「这条流我不要了」。
      // 任务 149 现场：renderer 被 reload 销毁后，main 侧 agent 多跑了 1 分 45 秒
      // 才自然结束，期间会话互斥锁一直被占。
      this._sendCancel({ stream: sid });
    }
    // 所有仍在飞的调用：移除 abort listener（幂等；cleanup 不会向 _cleanups 注册新项，直接迭代安全）
    for (const c of this._cleanups) c();
    this._cleanups.clear();
  }

  /** 发显式取消帧（任务 185：end 不再兼职取消）。
   *  dispose 可能由 transport.onClose（对端已死）触发，此时发送注定失败 ——
   *  取消是尽力而为，不该让 dispose 抛错。 */
  private _sendCancel(addr: { id?: number; stream?: number }, reason?: RpcError): void {
    try {
      this._send({
        type: 'cancel',
        ...(addr.stream != null ? { stream: addr.stream } : { id: addr.id }),
        ...(reason ? { reason: { code: reason.code, message: reason.message } } : {}),
      });
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
    if (signal?.aborted) throw _reasonToRpcError(signal.reason);

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
          cleanup();
          reject(new RpcError('TIMEOUT', `Invoke timed out after ${timeout}ms`));
        }, timeout);
      }

      const onAbort = () => {
        const err = _reasonToRpcError(signal!.reason);
        if (this.pending.delete(id)) {
          clearTimeout(entry.timer);
          this._sendCancel({ id }, err); // unary 远端取消：按 call.id（服务端 _unaryAborts）
          cleanup();
          reject(err);
        }
      };
      const cleanup = signal ? this._track(() => signal.removeEventListener('abort', onAbort)) : () => {};
      entry.cleanup = cleanup;

      this.pending.set(id, entry);
      this._send({ type: 'call', id, method, params });
      signal?.addEventListener('abort', onAbort, { once: true });
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
    if (signal?.aborted) throw _reasonToRpcError(signal.reason);

    const queue = new _AsyncQueue<TYield>();
    let streamId = 0;

    const onAbort = () => {
      const err = _reasonToRpcError(signal!.reason);
      if (streamId && this.streams.delete(streamId)) {
        this._sendCancel({ stream: streamId }, err);
        queue.error(err); // abort 本地终态 = CANCELLED（与 http 对齐，不再干净 end）
      }
      if (this.pending.delete(id)) {
        // init 窗口（ack 前）：按 call.id 取消，服务端经 _callStreams 补寻址
        clearTimeout(entry.timer);
        this._sendCancel({ id }, err);
        rejectInit(err);
      }
      cleanup();
    };
    const cleanup = signal ? this._track(() => signal.removeEventListener('abort', onAbort)) : () => {};

    let rejectInit: (e: unknown) => void = () => {};
    let entry: PendingEntry = { onMessage: () => false };

    await new Promise<number>((resolve, reject) => {
      rejectInit = reject;
      entry = {
        onMessage: (msg) => {
          if (msg.stream != null) {
            // 登记必须发生在**收到 ack 的同一个 macrotask 内**：ack 与首个 data 帧可能
            // 同时到达（ws 上同包多帧 → 'message' 同步派发多次），而 data 帧排在本次
            // await 的微任务续体之前。等 await 之后再登记，首个值就会被
            // `streams.get(...)?.push()` 静默丢弃（实测：ws 下 count(3) 偶发只收到 [2,3]）。
            streamId = msg.stream as number;
            this.streams.set(streamId, {
              push: (val) => queue.push(val as TYield),
              end: (err) => {
                cleanup(); // 服务端终态（完成/错误）：移除 abort listener
                if (err) queue.error(_fromErrorPayload(err));
                else queue.end();
              },
            });
            resolve(streamId);
          } else if (msg.error) {
            cleanup();
            reject(_fromErrorPayload(msg.error));
          } else {
            cleanup();
            reject(new RpcError('INVALID_ACK', 'Expected stream ack'));
          }
          return true;
        },
      };

      if (timeout != null && timeout > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          cleanup();
          reject(new RpcError('TIMEOUT', `Server stream init timed out after ${timeout}ms`));
        }, timeout);
      }

      this.pending.set(id, entry);
      this._send({ type: 'call', id, method, params, stream: true });
      // 先注册再发帧之后（同步区）监听 abort：覆盖 init 窗口 + 已建立两个阶段，无竞态缝
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    // 消费端提前退出（break / 组件卸载 / 外层 return）也要取消 —— 这条路径此前
    // 完全不发帧，是最常见的「悄悄白跑」来源（AbortSignal 只是其中一条通路）。
    // delete 的返回值兼作去重：服务端已 end 的流不在 map 里，不会重复发。
    queue.onReturn(() => {
      cleanup();
      if (this.streams.delete(streamId)) this._sendCancel({ stream: streamId });
    });

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
    if (signal?.aborted) throw _reasonToRpcError(signal.reason);

    let streamId = 0;
    let rejectResult: (e: unknown) => void = () => {};
    let resultCreated = false;
    // 上游迭代器的尽力清理（review P1）：abort 时对挂起的 next() 发 return() 通知；
    // 声明提前于 onAbort，避免 await ack 期间 abort 触发 TDZ
    let notifyUpstream: () => void = () => {};

    const onAbort = () => {
      const err = _reasonToRpcError(signal!.reason);
      if (this.pending.delete(id)) {
        clearTimeout(entry.timer);
        this._sendCancel(streamId ? { stream: streamId } : { id }, err);
        // init 未完成 → rejectInit 生效；结果阶段 → rejectResult 生效；两者都在则都落定
        rejectInit(err);
        if (resultCreated) rejectResult(err);
      }
      notifyUpstream();
      cleanup();
    };
    const cleanup = signal ? this._track(() => signal.removeEventListener('abort', onAbort)) : () => {};

    let rejectInit: (e: unknown) => void = () => {};
    let entry: PendingEntry = { onMessage: () => false };

    const streamIdPromise = new Promise<number>((resolve, reject) => {
      rejectInit = reject;
      entry = {
        onMessage: (msg) => {
          if (msg.stream != null) {
            streamId = msg.stream as number;
            // init timeout 只约束 init：ack 后必须清掉旧 timer，否则它到点会
            // `pending.delete(id)` 误删结果 entry（此 id 已指向结果）→ 服务端结果
            // 被丢、resultPromise 悬死（review P1，probe3 实测挂起）
            if (entry.timer != null) clearTimeout(entry.timer);
            resolve(streamId);
            return false; // 留在 pending：结果 entry 随后覆盖 set
          }
          if (msg.error) {
            cleanup();
            reject(_fromErrorPayload(msg.error));
            return true;
          }
          cleanup();
          reject(new RpcError('INVALID_ACK', 'Expected stream ack'));
          return true;
        },
      };

      if (timeout != null && timeout > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          cleanup();
          reject(new RpcError('TIMEOUT', `Client stream init timed out after ${timeout}ms`));
        }, timeout);
      }

      this.pending.set(id, entry);
      this._send({ type: 'call', id, method, params, stream: true });
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    await streamIdPromise;

    // 先注册结果 pending，再发 chunk——避免服务端在循环期间提前回包时该 id 无
    // pending entry 而被丢（_dispatch 查不到直接忽略），导致 result promise 永不
    // 落定（并发负载下 setTimeout/setImmediate 时序错位会触发此竞态而挂起）。
    let resolveResult: (v: TRes) => void = () => {};
    const resultPromise = new Promise<TRes>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // onAbort 可能在 upload 循环期间触发 rejectResult，而本函数尚未执行到
    // `return resultPromise`（upload break 还要等下一次迭代）—— rejection 早于消费方
    // attach 会被判 unhandled。no-op 吸收：真正的消费方仍经 return 收到同一 rejection。
    resultPromise.catch(() => {});
    resultCreated = true;
    this.pending.set(id, {
      onMessage: (msg) => {
        cleanup();
        if (msg.error) rejectResult(_fromErrorPayload(msg.error));
        else resolveResult(msg.result as TRes);
        return true;
      },
    });

    // 复检：ack 已 resolve、abort 恰落在续体之前时，once 监听已被消费，没人再落定
    // result —— 这里补一刀（任务 185：await 后必须复检 signal.aborted）
    if (signal?.aborted) {
      const err = _reasonToRpcError(signal.reason);
      this.pending.delete(id);
      this._sendCancel({ stream: streamId }, err);
      rejectResult(err);
    }

    // 上传后台化（review P1）：上游 next() 不可取消地挂起时，调用落定不得被它拖住
    // —— 结果由 pending 的结果 entry 落定，与上传循环解耦。abort 时对上游发
    // return() 通知（尽力而为，不强占在途 next）。
    const upstream = chunks[Symbol.asyncIterator]();
    notifyUpstream = () => {
      try {
        void upstream.return?.(undefined)?.catch(() => {});
      } catch { /* ignore */ }
    };
    void (async () => {
      try {
        for (;;) {
          const n = await upstream.next();
          if (n.done) break;
          if (signal?.aborted) break;
          this._send({ type: 'data', stream: streamId, value: n.value as TChunk });
        }
      } catch {
        this._send({ type: 'end', stream: streamId, error: { code: 'STREAM_ERROR', message: 'upstream error' } });
        return;
      }
      if (!signal?.aborted) this._send({ type: 'end', stream: streamId }); // 正常输入半关
      // abort 路径已在 onAbort 发过 cancel 帧，这里不再补 end（end = 半关，不是取消）
    })();

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
    if (signal?.aborted) throw _reasonToRpcError(signal.reason);

    const queue = new _AsyncQueue<TChunkOut>();
    let streamId = 0;
    // 同 clientStream：上游尽力清理通知，声明提前避免 await 期间 abort 的 TDZ
    let notifyUpstream: () => void = () => {};

    const onAbort = () => {
      const err = _reasonToRpcError(signal!.reason);
      if (streamId && this.streams.delete(streamId)) {
        // 整条 bidi 取消：输出队列 CANCELLED + cancel 帧（服务端停产 + 输入队列收尾）
        this._sendCancel({ stream: streamId }, err);
        queue.error(err);
      }
      if (this.pending.delete(id)) {
        clearTimeout(entry.timer);
        this._sendCancel({ id }, err);
        rejectInit(err);
      }
      notifyUpstream();
      cleanup();
    };
    const cleanup = signal ? this._track(() => signal.removeEventListener('abort', onAbort)) : () => {};

    let rejectInit: (e: unknown) => void = () => {};
    let entry: PendingEntry = { onMessage: () => false };

    await new Promise<number>((resolve, reject) => {
      rejectInit = reject;
      entry = {
        onMessage: (msg) => {
          if (msg.stream != null) {
            // 同 serverStream：必须在 ack 的同一 macrotask 内登记，否则同包到达的首个
            // data 帧会先于 await 续体、被 `streams.get(...)?.push()` 静默丢弃。
            streamId = msg.stream as number;
            this.streams.set(streamId, {
              push: (val) => queue.push(val as TChunkOut),
              end: (err) => {
                cleanup();
                if (err) queue.error(_fromErrorPayload(err));
                else queue.end();
              },
            });
            resolve(streamId);
          } else if (msg.error) {
            cleanup();
            reject(_fromErrorPayload(msg.error));
          } else {
            cleanup();
            reject(new RpcError('INVALID_ACK', 'Expected stream ack'));
          }
          return true;
        },
      };

      if (timeout != null && timeout > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          cleanup();
          reject(new RpcError('TIMEOUT', `Bidi stream init timed out after ${timeout}ms`));
        }, timeout);
      }

      this.pending.set(id, entry);
      this._send({ type: 'call', id, method, params, stream: true });
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    // 同 serverStream：消费端提前退出要通知服务端，否则下游停了、上游还在产出
    queue.onReturn(() => {
      cleanup();
      notifyUpstream();
      if (this.streams.delete(streamId)) this._sendCancel({ stream: streamId });
    });

    // 上传后台化（review P1）：调用落定不等不可取消的上游 next()
    const upstream = chunks[Symbol.asyncIterator]();
    notifyUpstream = () => {
      try {
        void upstream.return?.(undefined)?.catch(() => {});
      } catch { /* ignore */ }
    };
    void (async () => {
      try {
        for (;;) {
          const n = await upstream.next();
          if (n.done) break;
          if (signal?.aborted) break;
          this._send({ type: 'data', stream: streamId, value: n.value as TChunkIn });
        }
      } catch {
        this._send({ type: 'end', stream: streamId, error: { code: 'STREAM_ERROR', message: 'upstream error' } });
        return;
      }
      if (!signal?.aborted) this._send({ type: 'end', stream: streamId }); // 正常输入半关
    })();

    return queue;
  }
}
