/**
 * channel-server-binding.ts — ChannelServerBinding：envelope 复用协议服务端（第2层绑定之一）
 *
 * 在一条双向通道（mem/WS/IPC 等 EnvelopeTransport）上跑信封协议（id/streamId 复用），
 * 实现 ServerBinding 端口。注册逻辑（meta 强类型注册 + zod 校验）继承自 ServerBindingCore，
 * 这里只写 envelope dispatch。只应在入口组装代码中使用（传给 RpcServer），
 * 业务代码应使用第3层 RPC。
 */

import type { _Envelope } from './types';
import { _AsyncQueue } from './_async-queue';
import { _toErrorPayload, RpcError } from './error';
import type { ServerBinding } from './server-binding';
import type { EnvelopeTransport } from './types';
import { ServerBindingCore } from './server-binding-core';

let _streamId = 0;

export class ChannelServerBinding extends ServerBindingCore implements ServerBinding {
  /** server-stream 取消器，按 streamId */
  private _serverStreamCancellers = new Map<number, () => void>();
  /** client/bidi 流的消费队列，按 streamId */
  private _streamConsumers = new Map<number, _AsyncQueue<any>>();

  private _unsub: () => void;

  constructor(private tx: EnvelopeTransport) {
    super();
    this._unsub = tx.on((msg) => this._dispatch(msg));
  }

  /** 销毁：解除消息监听，清理所有流 */
  destroy(): void {
    super._clear();
    this._unsub();
    this._serverStreamCancellers.forEach(c => c());
    this._serverStreamCancellers.clear();
    this._streamConsumers.forEach(q => q.end());
    this._streamConsumers.clear();
  }

  // ── 单一分发器 ──────────────────────────────────

  private _dispatch = async (msg: _Envelope) => {
    if (msg.type === 'call' && !msg.stream) {
      await this._handleUnary(msg);
    } else if (msg.type === 'call' && msg.stream === true) {
      // Client 请求分配 streamId，从 msg.method 获取方法名
      const mode = this._modeOf(msg.method!);
      if (mode === 'server') this._startServerStream(msg);
      else if (mode === 'client') this._startClientStream(msg);
      else if (mode === 'bidi') this._startBidiStream(msg);
    } else if (msg.type === 'data') {
      const consumer = this._streamConsumers.get(msg.stream);
      if (consumer) consumer.push(msg.value);
    } else if (msg.type === 'end') {
      const consumer = this._streamConsumers.get(msg.stream);
      if (consumer) {
        if (msg.error) consumer.error(new RpcError(msg.error.code, msg.error.message));
        else consumer.end();
        this._streamConsumers.delete(msg.stream);
      }
      // end 也作为 server-stream 的取消信号
      const cancel = this._serverStreamCancellers.get(msg.stream);
      if (cancel) cancel();
    }
  };

  // ── Unary ────────────────────────────────────────

  private async _handleUnary(msg: _Envelope & { type: 'call' }) {
    const fn = this._getUnary(msg.method!);
    if (!fn) return;
    try {
      this.tx.send({ type: 'call', id: msg.id, result: await fn(msg.params) });
    } catch (err: unknown) {
      this.tx.send({ type: 'call', id: msg.id, error: _toErrorPayload(err) });
    }
  }

  // ── Server-Stream ────────────────────────────────

  private _startServerStream(msg: _Envelope & { type: 'call' }) {
    const fn = this._getServer(msg.method!);
    if (!fn) return;

    const streamId = ++_streamId;
    let cancelled = false;

    this._serverStreamCancellers.set(streamId, () => { cancelled = true; });
    this.tx.send({ type: 'call', id: msg.id, stream: streamId });

    (async () => {
      try {
        for await (const value of fn(msg.params)) {
          if (cancelled) return;
          this.tx.send({ type: 'data', stream: streamId, value });
        }
        if (!cancelled) this.tx.send({ type: 'end', stream: streamId });
      } catch (err: unknown) {
        if (!cancelled) this.tx.send({ type: 'end', stream: streamId, error: _toErrorPayload(err) });
      } finally {
        this._serverStreamCancellers.delete(streamId);
      }
    })();
  }

  // ── Client-Stream ────────────────────────────────

  private async _startClientStream(msg: _Envelope & { type: 'call' }) {
    const fn = this._getClient(msg.method!);
    if (!fn) return;

    const streamId = ++_streamId;
    const queue = new _AsyncQueue<any>();
    this._streamConsumers.set(streamId, queue);

    this.tx.send({ type: 'call', id: msg.id, stream: streamId });

    try {
      const result = await fn(msg.params, queue);
      this.tx.send({ type: 'call', id: msg.id, result });
    } catch (err: unknown) {
      this.tx.send({ type: 'call', id: msg.id, error: _toErrorPayload(err) });
    } finally {
      this._streamConsumers.delete(streamId);
    }
  }

  // ── Bidi-Stream ───────────────────────────────────

  private async _startBidiStream(msg: _Envelope & { type: 'call' }) {
    const fn = this._getBidi(msg.method!);
    if (!fn) return;

    const streamId = ++_streamId;
    const queue = new _AsyncQueue<any>();
    this._streamConsumers.set(streamId, queue);

    // bidi 不注册 cancellation：客户端 end 仅表示上游已完成，
    // 不应取消服务端向下游发送数据。
    this.tx.send({ type: 'call', id: msg.id, stream: streamId });

    try {
      for await (const value of fn(msg.params, queue)) {
        this.tx.send({ type: 'data', stream: streamId, value });
      }
      this.tx.send({ type: 'end', stream: streamId });
    } catch (err: unknown) {
      this.tx.send({ type: 'end', stream: streamId, error: _toErrorPayload(err) });
    } finally {
      this._streamConsumers.delete(streamId);
    }
  }
}
