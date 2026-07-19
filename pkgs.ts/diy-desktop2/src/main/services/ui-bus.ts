// src/main/services/ui-bus.ts
// 🎯 UI 事件总线 — 主进程推送命令到渲染进程
//    命令定义层通过此模块通知 UI 变化（导航/选中/Toast）

export type UiCommand =
  | { type: "navigate"; page: string }
  | { type: "focus"; uri: string }
  | { type: "toast"; message: string; level: "info" | "success" | "error" };

let push: ((cmd: UiCommand) => void) | null = null;

/** 注册推送函数（由 main/index.ts 在窗口创建后注入） */
export function setNotifyRenderer(fn: (cmd: UiCommand) => void): void {
  push = fn;
}

/** 命令定义层调用此函数推送 UI 事件 */
export function notifyRenderer(cmd: UiCommand): boolean {
  if (push) {
    push(cmd);
    return true;
  }
  return false;
}
