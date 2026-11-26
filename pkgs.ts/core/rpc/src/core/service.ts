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
    ? HandlersOf<R[K]> // ← group：继续下钻，**不要求 handler**
    : R[K] extends _Router
      ? HandlersOf<R[K]>
      : R[K] extends _AnyProcedureMeta
        ? _HandlerForProc<R[K]>
        : never;
};

/** `ProcedureMeta` / `group` 上的非子节点字段名（不该出现在 handlers 形状里） */
type MetaField =
  | '_type'
  | '_input'
  | '_output'
  | '_chunkIn'
  | '_chunkOut'
  | '_streamMode'
  | 'inputSchema'
  | 'outputSchema'
  | 'chunkInSchema'
  | 'chunkOutSchema'
  | 'desc'
  | 'title'
  | 'children';

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
/**
 * 一个「模块 + 它的部署名字」。
 *
 * @deprecated 新代码用 `server.use({ prefix, api, handlers })` +
 * `createScopedClient({ api, client, prefix })`（见 `scope.ts`）：前缀归使用方，
 * 同一个 api 能挂到多个前缀。
 */
export interface Service<T extends _Router | _AnyProcedureMeta> {
  readonly name: string;
  readonly api: T;
  bind(binding: ServerBinding, handlers: HandlersOf<T>): void;
  use(client: ClientBinding): TypedClient<T>;
}

/** 按 `a.b.c` 取嵌套对象里的 handler */
function pickHandler(handlers: unknown, path: string): unknown {
  let current: unknown = handlers;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * @deprecated 2026-11 起**新代码不要用** —— 它把「模块」与「部署位置」焊死
 * （`name` 写死在模块里）。等价写法：`server.use({ prefix, api, handlers })` +
 * `createScopedClient({ api, client, prefix })`。
 *
 * 保留原因：`scope.ts` 的契约写的就是「保留」；存量消费方（dev 仓的 dev-ref / dev-fs）
 * 仍在用。删它是一次跨仓破坏性变更，得单独协调 —— 不能顺手删。
 */
export function defineService<T extends _Router | _AnyProcedureMeta>(opts: {
  name: string;
  api: T;
}): Service<T> {
  const { name, api } = opts;
  if (!name) throw new Error('defineService: name 不能为空');
  return {
    name,
    api,
    bind(binding, handlers) {
      // 与 scope.ts 的 mountService 同一条路径：`<name>.<树内 path>`
      for (const [path, meta] of Object.entries(_flattenRouter(api))) {
        const handler = pickHandler(handlers, path);
        if (typeof handler !== 'function') {
          throw new Error(`defineService(${name}): 缺少 handler —— ${path}`);
        }
        binding._on(`${name}.${path}`, meta, handler as never);
      }
    },
    use(client) {
      return createTypedClient(client, api, { prefix: name });
    },
  };
}

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
    // 快照必须：循环体里面在 `expected` 上删元素（边遍历边改会跳过元素）
    // oxlint-disable-next-line no-useless-spread
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
  lines.push(
    '  修法：前者补 `bindXxx(binding)`；后者多半是改名漏改（api-def 与 handler 不一致）。',
  );
  throw new Error(lines.join('\n'));
}
