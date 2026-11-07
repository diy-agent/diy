/**
 * raw-bindings.ts — 用**显式路径字符串**注册 handler（不依赖 `meta.name`）
 *
 * ## 为什么需要它
 *
 * `binding.on(meta, handler)` 从 `meta.name` 读路径，所以调用前必须
 * `RpcSchema.bindNames(整棵树)` 把路径写进每个 meta。这带来两个问题：
 *   · 必须先知道**整棵树**，不能逐域装配
 *   · 路径是**隐式**的 —— 想找「`diy.task.create` 的 handler 在哪」grep 不到
 *
 * ## 用法
 *
 * ```ts
 * const api = new RawBindings(binding);
 * api.on("diy.task.create", app.task.create, async ({ input }) => {...});
 * api.on("diy.task.list",   app.task.list,   async ({ input }) => {...});
 * ```
 *
 * **仍然要传 meta**：handler 的参数类型从它推（`{ input, signal }` 的形状），
 * 运行时还要用它做 zod 校验（`inputSchema`）。路径和 meta **分开给**，各司其职。
 *
 * ## 什么时候不用它
 *
 * `defineService.bind(server, handlers)` 更强：它连路径都不用写（从 `name` + 树结构推），
 * 且形状检查是编译期的（少一个 handler 就报错）。**业务代码优先用它**。
 *
 * 本类适合：
 *   · 大型树逐域搬迁（一次搬一个域，路径显式）
 *   · handler 与 meta **不在同一棵树**里的场合（比如按条件装配）
 */

import type { ServerBinding } from './server-binding.js';
import type { _AnyProcedureMeta, _HandlerForProc } from './meta.js';

export class RawBindings {
  constructor(private readonly binding: ServerBinding) {}

  /**
   * 注册一个 handler。
   *
   * @param path 完整路径（如 `diy.task.create`）—— **不读 `meta.name`**
   * @param meta 契约（提供 handler 的参数类型 + 运行时 zod 校验）
   * @param handler 实现
   */
  on<M extends _AnyProcedureMeta>(path: string, meta: M, handler: _HandlerForProc<M>): void {
    if (path === '') {
      // 空路径会让 key 变成空串，比报错更难查
      throw new Error('RawBindings.on: path 不能为空');
    }
    // 复制一份再写 name —— **不改原 meta**（同一棵树可能同时被 defineService 用）
    this.binding.on({ ...(meta as object), name: path } as M, handler);
  }
}
