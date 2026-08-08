/**
 * tree.ts — 第2层：router 树遍历/拍平工具
 *
 * 纯内部模块，只依赖 meta 类型（AnyProcedureMeta / Router），
 * 供第3层（rpc/index.ts、forward.ts、typed-client.ts）与 cli-rpc 使用。
 * 独立成模块而非塞进聚合器 index.ts，避免 forward/typed-client 反向 import
 * index.ts 造成分层倒置（环回依赖）。
 */

import type { AnyProcedureMeta, Router } from './meta';

export function isProcedure(v: unknown): v is AnyProcedureMeta {
  return typeof v === 'object' && v !== null && (v as AnyProcedureMeta)._type === 'procedure';
}

export type ProcNode = {
  kind: 'proc';
  name: string;
  path: string;
  def: AnyProcedureMeta;
  parent: RouterNode | null;
};

export type RouterNode = {
  kind: 'router';
  name: string;
  path: string;
  children: RouteNode[];
  parent: RouterNode | null;
};

export type RouteNode = ProcNode | RouterNode;

const ROOT_NAME = '';

export function buildRouteTree(
  router: Router,
  parent: RouterNode | null = null,
  prefix = '',
): RouterNode {
  const name = prefix ? (prefix.split('.').pop() ?? ROOT_NAME) : ROOT_NAME;
  const path = prefix;

  const children: RouteNode[] = [];
  for (const [key, val] of Object.entries(router)) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (isProcedure(val)) {
      children.push({ kind: 'proc', name: key, path: childPath, def: val, parent: null as any });
    } else {
      children.push(buildRouteTree(val as Router, null as any, childPath));
    }
  }

  const node: RouterNode = { kind: 'router', name, path, children, parent };
  for (const c of children) (c as { parent: RouterNode }).parent = node;
  return node;
}

export function routeLeaves(root: RouterNode): ProcNode[] {
  const out: ProcNode[] = [];
  for (const c of root.children) {
    if (c.kind === 'proc') out.push(c);
    else out.push(...routeLeaves(c));
  }
  return out;
}

export function routeResolve(
  root: RouterNode,
  args: string[],
): ProcNode | RouterNode | null {
  if (args.length === 0) return root;
  const key = args[0]!;
  const child = root.children.find((c) => c.name === key);
  if (!child) return null;
  if (child.kind === 'proc') return child;
  if (args.length === 1) return child;
  return routeResolve(child, args.slice(1));
}

export function routeWalk(
  root: RouterNode,
  visitor: (node: RouteNode) => void,
): void {
  for (const c of root.children) {
    visitor(c);
    if (c.kind === 'router') routeWalk(c, visitor);
  }
}

/** 拍平嵌套 router 为 method→AnyProcedureMeta 映射 */
export function flattenRouter(r: Router): Record<string, AnyProcedureMeta> {
  const result: Record<string, AnyProcedureMeta> = {};
  for (const { path, def } of routeLeaves(buildRouteTree(r))) {
    result[path] = def;
  }
  return result;
}
