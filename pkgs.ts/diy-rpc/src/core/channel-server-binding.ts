/**
 * channel-server-binding.ts — ChannelServerBinding：envelope 复用协议服务端（第2层绑定之一）
 *
 * 在一条双向通道（mem/WS/IPC 等 EnvelopeTransport）上跑信封协议（id/streamId 复用），
 * 实现 ServerBinding 端口。注册逻辑（meta 强类型注册 + zod 校验）继承自 ServerBindingCore，
 * 这里只写 envelope dispatch。只应在入口组装代码中使用，
 * 业务代码应使用第3层 RPC。
 *
 * 取消协议（任务 185）：
 *   - end 帧单义：server→client 完成 / client→server 输入半关，**不再兼职取消**。
 *   - cancel 帧显式取消：ack 前按 call.id（init 窗口/unary 全程）、ack 后按 streamId；
 *     服务端用 _callStreams（id→streamId）补齐「客户端还不知道 streamId」的窗口。
 *   - 每个在飞调用持 AbortController：cancel / 传输断开 / destroy 都会 abort，
 *     handler 经 opts.signal 协作取消（JS 规范下无法强占 await，取消 = 停止拉取 + 通知）。
 *
 * 传输层安全：
 *   构造时自动订阅 tx.onClose()：传输层检测到对端死亡（如渲染进程崩溃）时，
 *   自动 destroy — 取消所有流、abort 所有在飞调用、清理所有消费者。
 */

import type { _Envelope, _CancelMsg } from './types';
import { _AsyncQueue } from './_async-queue';
import { _toErrorPayload, _wireToReason, RpcError } from './error';
import type { ServerBinding } from './server-binding';
import type { EnvelopeTransport } from './types';
import { ServerBindingCore } from './server-binding-core';

let _streamId = 0;

export class ChannelServerBinding extends ServerBindingCore implements ServerBinding {
  /** server-stream 输出取消器，按 streamId（停产 + ctrl.abort + g.return） */
  private _serverStreamCancellers = new Map<number, (reason: RpcError) => void>();
  /** bidi 输出取消器，按 streamId（输入半关由 end 帧处理，整条取消走这里） */
  private _bidiCancellers = new Map<number, (reason: RpcError) => void>();
  /** client/bidi 流的输入队列，按 streamId */
  private _streamConsumers = new Map<number, _AsyncQueue<any>>();
  /** 在飞 unary：call.id → controller（cancel-by-id 寻址） */
  private _unaryAborts = new Map<number, AbortController>();
  /** 在飞流：streamId → controller（handler signal 源） */
  private _streamAborts = new Map<number, AbortController>();
  /** call.id → streamId：ack 前取消寻址（_start* 分配 streamId 后登记，流结束时清） */
  private _callStreams = new Map<number, number>();

  private _unsub: () => void;
  private _onCloseUnsub: () => void;

  constructor(private tx: EnvelopeTransport) {
    super();
    this._unsub = tx.on((msg) => this._dispatch(msg));
    // 传输层关闭（渲染进程崩溃 / 窗口关闭）→ 自动销毁，取消所有进行中的流
    this._onCloseUnsub = tx.onClose(() => this.destroy());
  }

  /**
   * 发帧（传输关闭后 send 会抛，如 ws「not open」）：销毁窗口内 handler 收尾补发的帧
   * 必须静默丢弃，否则变成 unhandledRejection（任务 185）。
   */
  private _send(msg: _Envelope): void {
    try {
      this.tx.send(msg);
    } catch {
      // 对端已死：cancel/dispose 已尽力，无需补救
    }
  }

  /** 销毁：解除消息监听，取消所有流，abort 所有在飞调用（传输断开 = 服务端取消上下文） */
  destroy(): void {
    this._onCloseUnsub?.();
    this._unsub();
    const reason = new RpcError('CANCELLED', 'Connection closed');
    for (const c of this._serverStreamCancellers.values()) c(reason);
    this._serverStreamCancellers.clear();
    for (const c of this._bidiCancellers.values()) c(reason);
    this._bidiCancellers.clear();
    // 与 http 的 RST→createBodyReader error 对齐：传输断开是错误终态，不是干净半关
    this._streamConsumers.forEach((q) => q.error(reason));
    this._streamConsumers.clear();
    this._unaryAborts.forEach((c) => c.abort(reason));
    this._unaryAborts.clear();
    this._streamAborts.forEach((c) => c.abort(reason));
    this._streamAborts.clear();
    this._callStreams.clear();
  }

  // ── 单一分发器 ──────────────────────────────────

  private _dispatch = async (msg: _Envelope) => {
    // 响应/ack 帧（无 method：unary result/error、client-stream 结果、init-ack）——
    // 双端在同一 transport 上各挂 server+client 时（main: bindApi + RendererForwarder，
    // renderer: bindRendererApi + diyService），对端 server 发的响应帧也会到达本端 server。
    // 这些帧归本端 ChannelClientBinding，server 必须忽略：误当请求回 UNIMPLEMENTED
    // 会与对端 server 形成错误帧风暴，且错误帧 id 与在飞调用撞号 → 假
    // 「Unknown method: undefined」（任务 205）。
    if (msg.type === 'call' && msg.method == null) return;
    if (msg.type === 'call' && !msg.stream) {
      await this._handleUnary(msg);
    } else if (msg.type === 'call' && msg.stream === true) {
      // Client 请求分配 streamId，从 msg.method 获取方法名
      const mode = this._modeOf(msg.method!);
      if (mode === 'server') this._startServerStream(msg);
      else if (mode === 'client') this._startClientStream(msg);
      else if (mode === 'bidi') this._startBidiStream(msg);
      else {
        // 未知方法/模式不匹配：必须回错误，否则未设 timeout 的客户端永久 pending
        // （对齐 http 侧的 UNIMPLEMENTED，review P2）
        this._send({ type: 'call', id: msg.id, error: { code: 'UNIMPLEMENTED', message: `Unknown method or mode mismatch: ${msg.method}` } });
      }
    } else if (msg.type === 'data') {
      const consumer = this._streamConsumers.get(msg.stream);
      if (consumer) consumer.push(msg.value);
    } else if (msg.type === 'end') {
      // end = 输入正常半关（client→server）或完成（server→client，服务端不收），
      // **不兼职取消**——bidi 输入结束后输出端继续产出是协议常态。
      const consumer = this._streamConsumers.get(msg.stream);
      if (consumer) {
        if (msg.error) consumer.error(new RpcError(msg.error.code, msg.error.message));
        else consumer.end();
        this._streamConsumers.delete(msg.stream);
      } else if (msg.stream != null && this._serverStreamCancellers.has(msg.stream)) {
        // 旧协议兼容（review P2）：server-stream 没有输入半关，旧 client 发 end 即取消；
        // 新 client 走 cancel 帧。不兼底则 CLI/app 版本错配时回到「白跑」回归。
        this._serverStreamCancellers.get(msg.stream)!(
          new RpcError('CANCELLED', 'Cancelled via legacy end frame'),
        );
      }
    } else if (msg.type === 'cancel') {
      this._handleCancel(msg);
    }
  };

  /** 显式取消：ack 前按 call.id（经 _callStreams 补寻址）、ack 后按 streamId */
  private _handleCancel(msg: _CancelMsg): void {
    const reason = _wireToReason(msg.reason);
    const sid = msg.stream ?? (msg.id != null ? this._callStreams.get(msg.id) : undefined);
    if (sid !== undefined) {
      this._serverStreamCancellers.get(sid)?.(reason);
      this._bidiCancellers.get(sid)?.(reason);
      const consumer = this._streamConsumers.get(sid); // client-stream 输入 / bidi 输入
      if (consumer) {
        consumer.error(reason);
        this._streamConsumers.delete(sid);
      }
      this._streamAborts.get(sid)?.abort(reason);
    } else if (msg.id != null) {
      // unary（或 init 尚未到达 _start* 的极端窗口——同通道内消息保序，实际不发生）
      this._unaryAborts.get(msg.id)?.abort(reason);
    }
  }

  // ── Unary ────────────────────────────────────────

  private async _handleUnary(msg: _Envelope & { type: 'call' }) {
    const fn = this._getUnary(msg.method!);
    if (!fn) {
      // 未知方法：回 UNIMPLEMENTED 而非静默 return（review P2，对齐 http 侧）
      this._send({ type: 'call', id: msg.id, error: { code: 'UNIMPLEMENTED', message: `Unknown method: ${msg.method}` } });
      return;
    }
    const ctrl = new AbortController();
    this._unaryAborts.set(msg.id, ctrl);
    try {
      this._send({ type: 'call', id: msg.id, result: await fn(msg.params, ctrl.signal) });
    } catch (err: unknown) {
      this._send({ type: 'call', id: msg.id, error: _toErrorPayload(err) });
    } finally {
      this._unaryAborts.delete(msg.id);
    }
  }

  // ── Server-Stream ────────────────────────────────

  private _startServerStream(msg: _Envelope & { type: 'call' }) {
    const fn = this._getServer(msg.method!);
    if (!fn) return;

    const streamId = ++_streamId;
    this._callStreams.set(msg.id, streamId);
    const ctrl = new AbortController();
    this._streamAborts.set(streamId, ctrl);
    let cancelled = false;
    let gen: AsyncGenerator<unknown> | undefined;

    this._serverStreamCancellers.set(streamId, (reason) => {
      cancelled = true;
      ctrl.abort(reason);
      // return() 不强占在途 await（JS 规范限制）：await 结束后生成器收尾，finally 必跑
      if (gen) void gen.return?.(undefined).catch(() => {});
    });
    this._send({ type: 'call', id: msg.id, stream: streamId });

    (async () => {
      try {
        gen = fn(msg.params, ctrl.signal);
        for await (const value of gen) {
          if (cancelled) return;
          this._send({ type: 'data', stream: streamId, value });
        }
        if (!cancelled) this._send({ type: 'end', stream: streamId });
      } catch (err: unknown) {
        if (!cancelled) this._send({ type: 'end', stream: streamId, error: _toErrorPayload(err) });
      } finally {
        this._serverStreamCancellers.delete(streamId);
        this._streamAborts.delete(streamId);
        this._callStreams.delete(msg.id);
      }
    })();
  }

  // ── Client-Stream ────────────────────────────────

  private async _startClientStream(msg: _Envelope & { type: 'call' }) {
    const fn = this._getClient(msg.method!);
    if (!fn) return;

    const streamId = ++_streamId;
    this._callStreams.set(msg.id, streamId);
    const ctrl = new AbortController();
    this._streamAborts.set(streamId, ctrl);
    const queue = new _AsyncQueue<any>();
    this._streamConsumers.set(streamId, queue);

    this._send({ type: 'call', id: msg.id, stream: streamId });

    try {
      const result = await fn(msg.params, queue, ctrl.signal);
      this._send({ type: 'call', id: msg.id, result });
    } catch (err: unknown) {
      this._send({ type: 'call', id: msg.id, error: _toErrorPayload(err) });
    } finally {
      this._streamConsumers.delete(streamId);
      this._streamAborts.delete(streamId);
      this._callStreams.delete(msg.id);
    }
  }

  // ── Bidi-Stream ───────────────────────────────────

  private async _startBidiStream(msg: _Envelope & { type: 'call' }) {
    const fn = this._getBidi(msg.method!);
    if (!fn) return;

    const streamId = ++_streamId;
    this._callStreams.set(msg.id, streamId);
    const ctrl = new AbortController();
    this._streamAborts.set(streamId, ctrl);
    const queue = new _AsyncQueue<any>();
    this._streamConsumers.set(streamId, queue);

    // bidi 不把输入 end 注册为取消：客户端 end 仅表示上游半关，
    // 输入结束后输出端继续产出是协议常态；整条取消走 cancel 帧（_handleCancel）。
    this._send({ type: 'call', id: msg.id, stream: streamId });

    let cancelled = false;
    let gen: AsyncGenerator<unknown> | undefined;
    this._bidiCancellers.set(streamId, (reason) => {
      cancelled = true;
      ctrl.abort(reason);
      if (gen) void gen.return?.(undefined).catch(() => {});
    });

    try {
      gen = fn(msg.params, queue, ctrl.signal);
      for await (const value of gen) {
        if (cancelled) return;
        this._send({ type: 'data', stream: streamId, value });
      }
      if (!cancelled) this._send({ type: 'end', stream: streamId });
    } catch (err: unknown) {
      if (!cancelled) this._send({ type: 'end', stream: streamId, error: _toErrorPayload(err) });
    } finally {
      this._bidiCancellers.delete(streamId);
      this._streamConsumers.delete(streamId);
      this._streamAborts.delete(streamId);
      this._callStreams.delete(msg.id);
    }
  }
}
