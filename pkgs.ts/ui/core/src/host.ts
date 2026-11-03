/**
 * HostAdapter — provider 与「原生 UI 树」之间的子节点同步钩子。
 *
 * 对标 py 版 `_scope.py` 里的 `_HostCtrl`：core（signal/scope/cell）只认
 * ScopeNode 树，真正的原生子节点增删由各 provider 通过 HostAdapter 实现。
 * 默认 no-op，非容器节点无需处理。
 */

export interface HostAdapter {
  /** 把 child 的原生节点挂到 parent 的原生节点下 */
  addChild(parentHost: unknown, childHost: unknown): void;
  /** 用 childHosts 全量替换 host 的原生子节点 */
  replaceChildren(host: unknown, childHosts: unknown[]): void;
  /** 清空 host 的原生子节点 */
  clearChildren(host: unknown): void;
}

export const NOOP_HOST: HostAdapter = {
  addChild() {},
  replaceChildren() {},
  clearChildren() {},
};
