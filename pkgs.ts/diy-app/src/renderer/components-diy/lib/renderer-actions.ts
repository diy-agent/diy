/**
 * renderer-actions.ts — Renderer 侧 UI 动作注册器
 *
 * RPC handler（非 React 环境）需要触发 React 状态变更时，
 * 通过此模块注册/注销回调。React 组件在 mount 时注册，unmount 时注销。
 */

export interface RendererActions {
  navigate?: (page: string) => void;
  focus?: (uri: string) => void;
  toast?: (message: string, level: string) => void;
}

let _actions: RendererActions = {};

export function setRendererActions(actions: RendererActions): void {
  _actions = actions;
}

export function resetRendererActions(): void {
  _actions = {};
}

export function getRendererActions(): RendererActions {
  return _actions;
}
