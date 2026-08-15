/**
 * tree.ts — 第2层：router 树遍历/拍平工具
 *
 * 纯内部模块，只依赖 meta 类型（_AnyProcedureMeta / _Router），
 * 供第3层（rpc/index.ts、forward.ts、typed-client.ts）与 cli-rpc 使用。
 * 独立成模块而非塞进聚合器 index.ts，避免 forward/typed-client 反向 import
 * index.ts 造成分层倒置（环回依赖）。
 */

import type { _AnyProcedureMeta, _Router } from './meta';

/** @internal */
export function _isProcedure(v: unknown): v is _AnyProcedureMeta {
  return typeof v === 'object' && v !== null && (v as _AnyProcedureMeta)._type === 'procedure';
}

/** @internal */
export type _ProcNode = {
  kind: 'proc';
  name: string;
  path: string;
  def: _AnyProcedureMeta;
  parent: _RouterNode | null;
};

/** @internal */
export type _RouterNode = {
  kind: 'router';
  name: string;
  path: string;
  /** 父命令描述（来自父命令 meta 的 desc）。叶子命令描述在 ProcedureMeta.desc */
  desc?: string;
  children: _RouteNode[];
  parent: _RouterNode | null;
};

/** @internal */
export type _RouteNode = _ProcNode | _RouterNode;

const ROOT_NAME = '';

/** @internal */
export function _buildRouteTree(
  router: _Router,
  parent: _RouterNode | null = null,
  prefix = '',
  desc?: string,
): _RouterNode {
  const name = prefix ? (prefix.split('.').pop() ?? ROOT_NAME) : ROOT_NAME;
  const path = prefix;

  const children: _RouteNode[] = [];
  for (const [key, val] of Object.entries(router)) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (_isProcedure(val) && val._streamMode === 'group') {
      // 父命令（RpcSchema.group）：递归子命令，把父命令自身 desc 传给子 router 节点
      children.push(_buildRouteTree(val.children as _Router, null as any, childPath, val.desc));
    } else if (_isProcedure(val)) {
      // 叶子命令（unary/serverStream/...）
      children.push({ kind: 'proc', name: key, path: childPath, def: val, parent: null as any });
    } else {
      // 纯 router 节点（无 meta）：递归
      children.push(_buildRouteTree(val as _Router, null as any, childPath));
    }
  }

  const node: _RouterNode = { kind: 'router', name, path, desc, children, parent };
  for (const c of children) (c as { parent: _RouterNode }).parent = node;
  return node;
}

/** @internal */
export function _routeLeaves(root: _RouterNode): _ProcNode[] {
  const out: _ProcNode[] = [];
  for (const c of root.children) {
    if (c.kind === 'proc') out.push(c);
    else out.push(..._routeLeaves(c));
  }
  return out;
}

/** @internal */
export function _routeResolve(
  root: _RouterNode,
  args: string[],
): _ProcNode | _RouterNode | null {
  if (args.length === 0) return root;
  const key = args[0]!;
  const child = root.children.find((c) => c.name === key);
  if (!child) return null;
  if (child.kind === 'proc') return child;
  if (args.length === 1) return child;
  return _routeResolve(child, args.slice(1));
}

/** @internal */
export function _routeWalk(
  root: _RouterNode,
  visitor: (node: _RouteNode) => void,
): void {
  for (const c of root.children) {
    visitor(c);
    if (c.kind === 'router') _routeWalk(c, visitor);
  }
}

/** 拍平嵌套 router 为 method→_AnyProcedureMeta 映射 */
/** @internal */
export function _flattenRouter(r: _Router): Record<string, _AnyProcedureMeta> {
  const result: Record<string, _AnyProcedureMeta> = {};
  for (const { path, def } of _routeLeaves(_buildRouteTree(r))) {
    result[path] = def;
  }
  return result;
}
