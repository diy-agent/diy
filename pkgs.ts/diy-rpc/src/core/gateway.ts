/**
 * gateway.ts — RpcGateway：多后端合并注册进单一 ServerBinding 的编排层
 *
 * 核心：把多个后端（本地 RpcServer / 转发 RpcForward）的方法按 scope 前缀
 * 合并进同一个 ServerBinding，scope 冲突（方法前缀重名）即报错，保证
 * 每个方法由且仅由一个后端注册（零广播）。
 *
 * 职责：
 *   - 拥有绑定来源 transport 的 ServerBinding（生命周期归 gateway）
 *   - register(backend) 把后端的方法（全名）注册进内部 ServerBinding
 *   - 路由归属 = 各后端声明的 scope，集中可见；scope 冲突即报错
 */

import type { ServerBinding } from './server-binding';

/**
 * 一个能处理 RPC 方法的"后端"。
 *
 * RpcServer（本地，本进程直接处理）与 RpcForward（转发，经某 transport
 * 调远端进程）都实现此接口。网关不区分二者，统一 register。
 */
/** @internal */
export interface _RpcBackend {
  /** 本后端拥有的方法前缀（如 diy.app / diy.ui） */
  readonly scope: string;
  /** 把本后端所有方法（全名，含 scope 前缀）注册到给定 ServerBinding */
  registerInto(binding: ServerBinding): void;
}

/**
 * RpcGateway — 多后端合并注册进单一 ServerBinding 的编排层。
 *
 * 拥有一个 ServerBinding（具体绑定由调用方按协议选择：ChannelServerBinding
 * 或 HttpServerBinding）；每次 register 把后端的方法合并进它。请求分发由
 * ServerBinding 按全名 method 完成，本类不参与请求处理。
 */
export class RpcGateway {
  private _scopes = new Set<string>();

  constructor(private _binding: ServerBinding) {}

  /** 注册一个后端；scope 前缀冲突时抛错 */
  register(backend: _RpcBackend): this {
    if (this._scopes.has(backend.scope)) {
      throw new Error(
        `[RpcGateway] scope "${backend.scope}" 已注册 — 方法前缀冲突，每个前缀只能归属一个后端`,
      );
    }
    this._scopes.add(backend.scope);
    backend.registerInto(this._binding);
    return this;
  }

  destroy(): void {
    this._binding.destroy();
    this._scopes.clear();
  }
}
