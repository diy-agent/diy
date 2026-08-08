/**
 * forward.ts — RpcForward：转发型后端（把某 scope 的方法转发到远端 transport）
 *
 * 与本地 RpcServer 相对：RpcServer 在本进程直接处理 handler；
 * RpcForward 把 scope 下的每个方法注册为"转发 handler"——收到调用后经
 * 一个 RawClient 发到远端 transport（如 ipcTransport → renderer），
 * 拿回结果返回。网关的 RawServer 负责 id 映射与回写来源，转发方完全透明。
 *
 * 用途：CLI → Main（gateway）→ Renderer 的 diy.ui.* 转发。
 * 加 remote server 同理：register(new RpcForward(remoteTransport, { router, scope }))。
 */

import type { Transport } from './types';
import { ChannelRawClient } from './raw-client';
import type { RawServer, RawClient } from './raw';
import { flattenRouter } from './tree';
import type { Router } from './meta';
import type { RpcBackend } from './gateway';

export interface RpcForwardOptions {
  /** 本转发后端拥有的方法前缀（如 diy.ui） */
  scope: string;
  /** scope 下的路由子树（如 apiDef.diy.ui） */
  router: Router;
}

/** RpcForward 转发 handler 需要的参数（无需 stream，当前只转发 unary/server） */
type FwdOpts = { input: unknown; meta: unknown };

/**
 * 转发后端：把 scope 下每个方法注册为转发 handler。
 *
 * registerInto 遍历 scope 子树，对每个 procedure 以 meta 注册（def.name = 完整全名）：
 *   - unary       → 调远端 rawClient.invoke，返回结果
 *   - serverStream → 返回 AsyncGenerator，远端逐块产出
 * client/bidi 暂不支持转发（当前无此类远端方法）。
 */
export class RpcForward implements RpcBackend {
  readonly scope: string;
  private _router: Router;
  private _client: RawClient;

  constructor(transport: Transport, opts: RpcForwardOptions) {
    this.scope = opts.scope;
    this._router = opts.router;
    this._client = new ChannelRawClient(transport);
  }

  registerInto(raw: RawServer): void {
    const flat = flattenRouter(this._router);
    for (const [name, def] of Object.entries(flat)) {
      const full = `${this.scope}.${name}`;
      (def as { name?: string }).name = full; // 完整全名回写进 meta.name
      const mode = def._streamMode;

      if (mode === 'unary') {
        raw.onUnary(def, ((opts: FwdOpts) =>
          this._client.invoke(full, { input: opts.input, meta: opts.meta })) as any);
      } else if (mode === 'server') {
        raw.onServerStream(def, ((opts: FwdOpts) =>
          this._forwardServerStream(full, opts)) as any);
      } else if (mode === 'client' || mode === 'bidi') {
        throw new Error(`[RpcForward] ${full}: client/bidi 转发暂不支持`);
      } else {
        throw new Error(`[RpcForward] ${full}: 未知 stream mode ${mode}`);
      }
    }
  }

  private async *_forwardServerStream(full: string, opts: { input: unknown; meta: unknown }): AsyncGenerator<unknown> {
    const handle = await this._client.serverStream(full, { input: opts.input, meta: opts.meta });
    for await (const chunk of handle) yield chunk;
  }
}
