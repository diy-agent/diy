/**
 * scope.ts — **挂载点（prefix）与模块（api）分离**（2026-11）
 *
 * ## 为什么把 name 从模块里拿出来
 *
 * `defineService({ name: 'diy.task', api })` 把「模块」和「部署位置」焊死：
 * 想把同一个 task 模块挂到 `diyvideo.task` 下，只能改模块源码 —— 相当于一个库把
 * URL 前缀写死成 `/diy/task`。前缀是**使用方**的事，不是模块的事。
 *
 * 现在：
 *
 * ```ts
 * // 模块只提供 api（没有名字）
 * export const taskApi = RpcSchema.group({ children: { list, create } });
 *
 * // 服务端：挂载点由宿主给（可以挂多次、挂到不同前缀）
 * server.use({ prefix: 'diy.task', api: taskApi, handlers: { list, create } });
 *
 * // 客户端：同一个前缀由使用方给，拿到的只有这一段
 * const task = createScopedClient({ api: taskApi, client, prefix: 'diy.task', cmd: 'task' });
 * await task.list({});
 * ```
 *
 * 两端拼出来的线上名都是 `diy.task.list` —— 但**没有任何一处把名字写进模块**。
 *
 * ## 与 `defineService` 的关系
 *
 * `defineService` 保留（存量代码太多），它等价于 `name` + `mountService` + `createScopedClient`。
 * 新代码直接用本文件这两个函数。
 */

import type { ClientBinding, ServerBinding } from './server-binding.js';
import type { _AnyProcedureMeta, _Router } from './meta.js';
import type { TypedClient } from './typed-client.js';
import { createTypedClient } from './typed-client.js';
import { _flattenRouter } from './_tree.js';
import type { HandlersOf } from './service.js';

/** 一个「挂载在某前缀下的 api」的客户端：强类型调用端 + 它自己的部署信息 */
export type ScopedClient<T> = TypedClient<T> & {
  /** 原样的 api 树（CLI 要据此合并命令树） */
  readonly api: T;
  /** 线上前缀（`diy.task`）：调用名 = prefix + '.' + 树内 path */
  readonly prefix: string;
  /** 底层连接（CLI 路由器用它发调用；业务代码用上面的强类型方法即可） */
  readonly transport: ClientBinding;
};

/**
 * 取回**只有这个模块**的强类型调用端，并把挂载点记在返回值上。
 *
 * 参数全具名（位置参一多就没人记得住顺序）：
 * `{ api, client, prefix, cmd?, desc? }`
 */
export function createScopedClient<T extends _Router | _AnyProcedureMeta>(opts: {
  readonly api: T;
  readonly client: ClientBinding;
  readonly prefix: string;
}): ScopedClient<T> {
  const { api, client, prefix } = opts;
  if (!prefix) throw new Error('createScopedClient: prefix 不能为空');
  const typed = createTypedClient(client, api, { prefix });
  // 部署信息**不能** `Object.assign` 到 `typed` 上：那是个 Proxy，任何键都会被拼成方法名
  // （`prefix.<key>`）再读回来 —— `Object.assign` 看起来成功，`scoped.prefix` 拿到的却是子路径
  // Proxy（##87 实测：测试一读就抛 `Cannot convert a Symbol value to a string`）。
  // 正确做法是在外层再包一层：自有键（api/prefix/transport/cmd/desc）先命中，其余原样落到 typed。
  const own: Record<string, unknown> = {
    api,
    prefix,
    transport: client,
  };
  return new Proxy({} as ScopedClient<T>, {
    get(_target, key) {
      if (typeof key === 'string' && key in own) return own[key];
      return (typed as unknown as Record<string | symbol, unknown>)[key];
    },
    has(_target, key) {
      return (typeof key === 'string' && key in own) || key in (typed as object);
    },
  });
}

/** 按 `a.b.c` 取嵌套对象里的 handler（与 service.ts 的同名实现一致） */
function _pickHandler(handlers: unknown, path: string): unknown {
  let cur: unknown = handlers;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * 把一棵 api 挂到 server 的指定前缀下。
 *
 * 与 `defineService.bind` 的唯一差别：**前缀是参数**，所以同一个 api 能挂到多个
 * 前缀（兼容别名、多租户），也能在不改模块源码的前提下换部署位置。
 *
 * 冲突（同前缀同名已注册）由 `server._on` 立即抛错 —— 启动期就炸，不是等第一条请求。
 */
export function mountService<T extends _Router | _AnyProcedureMeta>(
  server: ServerBinding,
  opts: {
    readonly prefix: string;
    readonly api: T;
    readonly handlers: HandlersOf<T>;
  },
): void {
  const { prefix, api, handlers } = opts;
  if (!prefix) throw new Error('mountService: prefix 不能为空');
  for (const [path, meta] of Object.entries(_flattenRouter(api))) {
    const handler = _pickHandler(handlers, path);
    if (typeof handler !== 'function') {
      // 类型上已拦，这是运行期兜底（`as never` 绕过 / api 与 handlers 版本不一致）
      throw new Error(`mountService(${prefix}): 缺少 handler —— ${path}`);
    }
    server._on(`${prefix}.${path}`, meta, handler as never);
  }
}
