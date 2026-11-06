/**
 * service.ts — **模块化的 API 单元**（2026-11-05）
 *
 * 问题：以前所有 procedure 共用一棵全局扁平命名空间（`page.list` / `task.get`）。
 * 两个模块都有 `list` 就冲突；客户端也只有 `createTypedClient(client, 整棵树)` 一条路
 * —— 想用 workbench 的三个方法，得先持有全仓的 api 定义。
 *
 * 现在：一个模块 = 一个 service
 *
 * ```ts
 * // 模块内（pkgs.ts/ui/workbench/src/api.ts）
 * export const workbenchService = defineService({
 *     name: 'diy.ui.workbench',
 *     api: RpcSchema.router({ page: RpcSchema.router({ list, invoke }) }),
 * });
 *
 * // 服务端
 * workbenchService.bind(server, { page: { list: listHandler, invoke: invokeHandler } });
 *
 * // 客户端 —— 拿到的只有这个模块的方法，名字/类型都不用在调用方写
 * const wb = workbenchService.use(client);
 * await wb.page.list();
 * ```
 *
 * 两端用的是**同一个值**（`workbenchService`），所以模块名与路由不可能漂移。
 */

import type { ClientBinding } from './server-binding.js';
import type { ServerBinding } from './server-binding.js';
import type { _AnyProcedureMeta, _HandlerForProc, _Router } from './meta.js';
import type { TypedClient } from './typed-client.js';
import { _flattenRouter } from './_tree.js';
import { createTypedClient } from './typed-client.js';

// ═══════════════════════════════════════════════════
//  类型：从 _Router 推导两端的 handler 形状
// ═══════════════════════════════════════════════════

/**
 * 服务端 handlers 的形状 = api 树同构，叶子换成 handler。
 *
 * 为什么不做「方法名数组」：同构形状让「少写一个方法」变成**编译期错误**
 * （`bind` 的第二个参数缺 key 就报错），而不是启动时才发现某个 rpc 没人接。
 */
export type HandlersOf<R> = {
  [K in keyof R]: R[K] extends _Router ? HandlersOf<R[K]> : R[K] extends _AnyProcedureMeta ? _HandlerForProc<R[K]> : never;
};

/** `defineService` 的入参 */
export interface ServiceDef<TRoutes extends _Router> {
  /**
   * 模块名 —— **跨进程的协议标识**，不是包名。
   *
   * 为什么手写而不是从 package.json 读：包可能改名，而已经发出去的协议路径不能跟着变
   * （老客户端会立刻全挂）。名字一旦写进 service 就是契约的一部分。
   */
  readonly name: string;
  /** 路由树（`RpcSchema.router(...)` 的返回值，形状不变） */
  readonly api: TRoutes;
}

/** `defineService` 的返回：两端入口 + 原样的 name / api */
export interface Service<TRoutes extends _Router> {
  readonly name: string;
  readonly api: TRoutes;
  /** 服务端：把 handlers 挂到 `name.*` 前缀下 */
  bind(server: ServerBinding, handlers: HandlersOf<TRoutes>): void;
  /** 客户端：取回**只有这个模块**的强类型调用端 */
  use(client: ClientBinding): TypedClient<TRoutes>;
}

// ═══════════════════════════════════════════════════
//  实现
// ═══════════════════════════════════════════════════

/** 按 `a.b.c` 取嵌套对象里的 handler（`handlers.page.list`） */
function pickHandler(handlers: unknown, path: string): unknown {
  let cur: unknown = handlers;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function defineService<const TRoutes extends _Router>(def: ServiceDef<TRoutes>): Service<TRoutes> {
  const { name, api } = def;
  if (name === '') {
    // 空名字会让所有路径变成 `.page.list`，比报错更难查 —— 定义时就拒
    throw new Error('defineService: name 不能为空');
  }

  return {
    name,
    api,

    bind(server, handlers) {
      for (const [path, meta] of Object.entries(_flattenRouter(api))) {
        const handler = pickHandler(handlers, path);
        if (typeof handler !== 'function') {
          // 类型上已经拦了，这里是运行期兜底（`as never` 绕过、或 api 与 handlers 来自不同版本）
          throw new Error(`defineService(${name}): 缺少 handler —— ${path}`);
        }
        // 复制一份 meta 再改 name：**不能原地改** —— 同一个 api 可能被多个 service 复用
        // （比如一个模块同时挂在自己的名字下和某个兼容别名下），原地改会互相覆盖。
        server.on({ ...meta, name: `${name}.${path}` }, handler as never);
      }
    },

    use(client) {
      return createTypedClient(client, api, { prefix: name });
    },
  };
}
