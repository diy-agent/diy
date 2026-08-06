/**
 * gateway.ts — RpcGateway：绑定来源 transport 的路由边界层
 *
 * 核心：handle/call 函数脱离 transport（纯 handler 注册表），
 * 路由决策从 RpcServer 上收到这里。RpcGateway 是唯一绑定来源
 * transport 的层，通过 register(backend) 把多个后端（本地 RpcServer
 * / 转发 RpcClient）的方法按前缀注册进同一个 RawServer。
 *
 * 职责：
 *   - 绑定来源 transport（cliTx / ipcTransport），只此一处
 *   - register(backend) 把后端的方法（全名）注册进内部 RawServer
 *   - 路由归属 = 各后端声明的 scope，集中可见；scope 冲突即报错
 *   - 零广播：每个方法由且仅由一个后端注册
 */

import type { RawServer } from './raw';

/**
 * 一个能处理 RPC 方法的"后端"。
 *
 * RpcServer（本地，本进程直接处理）与 RpcForward（转发，经某 transport
 * 调远端进程）都实现此接口。网关不区分二者，统一 register。
 */
export interface RpcBackend {
  /** 本后端拥有的方法前缀（如 diy.app / diy.ui） */
  readonly scope: string;
  /** 把本后端所有方法（全名，含 scope 前缀）注册到给定 RawServer */
  registerInto(raw: RawServer): void;
}

/**
 * RpcGateway — 绑定来源 RawServer 的路由边界层。
 *
 * 拥有一个绑定到来源连接（channel / http2）的 RawServer；每次 register 把后端的方法
 * 合并进它。收到来源请求时由 RawServer 按全名 method 分发给对应后端，响应回写到来源。
 * 构造只接受 RawServer 端口（具体绑定由调用方按协议选择：ChannelRaw 或 HttpRaw）。
 */
export class RpcGateway {
  private _scopes = new Set<string>();

  constructor(private _raw: RawServer) {}

  /** 注册一个后端；scope 前缀冲突时抛错 */
  register(backend: RpcBackend): this {
    if (this._scopes.has(backend.scope)) {
      throw new Error(
        `[RpcGateway] scope "${backend.scope}" 已注册 — 方法前缀冲突，每个前缀只能归属一个后端`,
      );
    }
    this._scopes.add(backend.scope);
    backend.registerInto(this._raw);
    return this;
  }

  destroy(): void {
    this._raw.destroy();
    this._scopes.clear();
  }
}
