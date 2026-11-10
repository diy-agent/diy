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
 *     api: RpcSchema.group({ children: { page: RpcSchema.group({ children: { list, invoke } }) } }),
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
  // 跳过**元字段**：group 摊平后 `desc` / `title` / `inputSchema` / `children` 都在 meta 上，
  // 不跳的话它们会被要求提供 handler（`desc: string` ⇒ `never`，bind 直接类型报错）。
  [K in keyof R as K extends MetaField ? never : K]: IsGroup<R[K]> extends true
    ? HandlersOf<R[K]>                      // ← group：继续下钻，**不要求 handler**
    : R[K] extends _Router
      ? HandlersOf<R[K]>
      : R[K] extends _AnyProcedureMeta
        ? _HandlerForProc<R[K]>
        : never;
};

/** `ProcedureMeta` / `group` 上的非子节点字段名（不该出现在 handlers 形状里） */
type MetaField =
  | '_type' | '_input' | '_output' | '_chunkIn' | '_chunkOut' | '_streamMode'
  | 'inputSchema' | 'outputSchema' | 'chunkInSchema' | 'chunkOutSchema'
  | 'desc' | 'title' | 'children';

/**
 * 是不是 `RpcSchema.group` 的返回值。
 *
 * 为什么需要单独判：group 的类型是 `ProcedureMeta<..., 'group'> & TChildren`（交叉类型），
 * 它**既是 meta 又是容器**：
 *   · 不匹配 `_Router`（带 `desc: string` / `_streamMode` 这些非 meta 字段）
 *   · 但匹配 `_AnyProcedureMeta` ⇒ 会被推成 `_HandlerForProc<group meta>`
 *   · 而 `'group'` 模式在 `HandlerFor` 里没有分支 ⇒ **`never`**
 *
 * 实测后果（##518 重构）：dev-fs 用 group 做命令组时 `bind()` 直接类型报错。
 */
type IsGroup<T> = T extends { _streamMode: 'group' } ? true : false;

/** `defineService` 的入参 */
export interface ServiceDef<TRoutes extends _Router | _AnyProcedureMeta> {
  /**
   * 模块名 —— **跨进程的协议标识**，不是包名。
   *
   * 为什么手写而不是从 package.json 读：包可能改名，而已经发出去的协议路径不能跟着变
   * （老客户端会立刻全挂）。名字一旦写进 service 就是契约的一部分。
   */
  readonly name: string;
  /** 路由树（`RpcSchema.group({ children: ... })` 的返回值，形状不变） */
  readonly api: TRoutes;
}

/** `defineService` 的返回：两端入口 + 原样的 name / api */
export interface Service<TRoutes extends _Router | _AnyProcedureMeta> {
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

export function defineService<const TRoutes extends _Router | _AnyProcedureMeta>(
  def: ServiceDef<TRoutes>,
): Service<TRoutes> {
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
        // 三参形式：路径与 meta **分开给**，不改原 meta —— 同一个 api 可能被多个
        // service 复用（比如一个模块同时挂在自己的名字下和某个兼容别名下）
        server.on(`${name}.${path}`, meta, handler as never);
      }
    },

    use(client) {
      return createTypedClient(client, api, { prefix: name });
    },
  };
}

/**
 * 装配完整性对账 —— **双向**：
 *
 * · apiDef 里声明了、binding 上没绑 ⇒ 运行期才回 `Unknown method: diy.xxx`
 *   （2026-11-09 就栽过：`app.info` 的 meta 在、handler 漏了，CLI 探活因此失败、
 *   报「启动超时」还杀掉自己）
 * · binding 上绑了、apiDef 里没有 ⇒ 客户端永远调不到，属死代码（多半是改名漏改）
 *
 * **必须在启动时跑**，不能等第一条请求 —— 那时已经分不清是「没实现」还是
 * 「实现里抛了」。
 *
 * @param binding 已装配的 ServerBinding
 * @param root    期望被绑的总树（通常是 `apiDef.diy`）；路径前缀从它的 key 开始算
 * @param label   报错时的场签名（如 `diy-app`）
 * @throws 任一方向不一致时报错，列出全部分歧（不是只报第一条 —— 一次修完）
 */
export function assertFullyBound(
  binding: { listRegistered(): string[] },
  root: object,
  label: string,
  excludePrefixes: readonly string[] = [],
): void {
  const expected = new Set<string>();
  (function walk(node: unknown, prefix: string): void {
    if (!node || typeof node !== 'object') return;
    const meta = node as { _streamMode?: string };
    if (meta._streamMode && meta._streamMode !== 'group') {
      expected.add(prefix);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      // `children` 是 **group 的内部字段**（内容已摊平到 meta 本身）——
      // 再走一遍会把同一批 procedure 用 `xxx.children.yyy` 的假路径重复登记
      if (k.startsWith('_') || k === 'children') continue;
      walk(v, prefix ? `${prefix}.${k}` : k);
    }
  })(root as unknown as Record<string, unknown>, 'diy');

  for (const p of excludePrefixes) {
    for (const k of [...expected]) if (k.startsWith(p)) expected.delete(k);
  }
  for (const p of excludePrefixes) {
    for (const k of [...expected]) if (k.startsWith(p)) expected.delete(k);
  }
  const registered = new Set(binding.listRegistered());
  const missing = [...expected].filter((p) => !registered.has(p)).sort();
  const extra = [...registered].filter((p) => !expected.has(p)).sort();
  if (missing.length === 0 && extra.length === 0) return;

  const lines: string[] = [`[${label}] 装配不完整（apidef vs binding）：`];
  if (missing.length > 0) {
    lines.push(`  声明了但没 bind（${String(missing.length)} 个）：`);
    for (const p of missing) lines.push(`    · ${p}`);
  }
  if (extra.length > 0) {
    lines.push(`  绑了但 apiDef 里没有（${String(extra.length)} 个）：`);
    for (const p of extra) lines.push(`    · ${p}`);
  }
  lines.push('  修法：前者补 `bindXxx(binding)`；后者多半是改名漏改（api-def 与 handler 不一致）。');
  throw new Error(lines.join('\n'));
}
