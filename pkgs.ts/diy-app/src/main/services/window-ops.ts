// src/main/services/window-ops.ts
// 🎯 主进程**窗口能力**的注入点 —— 让 RPC 层能「看到/请出本实例的窗口」，而不 import Electron。
//
// 为什么需要注入：`instances.reveal`（跨实例唤起）要 `show()+focus()+setFullScreen(true)`，
// 那是 Electron 的能力，只有 main/index.ts 里有 `BrowserWindow` / `ensureWindow`。
// 而 api-impl（handler 层）必须能在 **serve 模式**（无 Electron）下被加载 —— 直接 import
// electron 会让 serve 直接炸。故：main/index.ts 注入实现，serve 不注入。
//
// 这不只是解耦：它把「无窗口实例」这一真实存在（serve / 窗口关了但进程常驻）显式化 ——
// 唤起失败给的是**明确原因**，而不是静默什么都不做。

import type { InstanceSelf, RevealResult } from "../../shared/instance-row";

export interface WindowOps {
  /** 请出窗口：不存在就重建（窗口关了但进程常驻是常态），然后前置 + 全屏 */
  reveal(): RevealResult;
  /** 当前窗口状态；无窗口 → null（serve 模式 / 窗口已关） */
  state(): InstanceSelf["window"];
}

let ops: WindowOps | null = null;

/** main/index.ts 在窗口逻辑就绪后注入；传 null 撤销（测试用） */
export function setWindowOps(next: WindowOps | null): void {
  ops = next;
}

/** 请出本实例窗口。未注入（serve 模式）→ 明确失败原因，绝不静默返回成功 */
export function revealSelf(): RevealResult {
  if (!ops) return { ok: false, reason: "本实例没有窗口（serve 模式 / 未运行 GUI）", fullScreen: false };
  try {
    return ops.reveal();
  } catch (e) {
    return { ok: false, reason: `唤起失败：${e instanceof Error ? e.message : String(e)}`, fullScreen: false };
  }
}

/** 当前窗口状态；未注入 / 无窗口 → null */
export function windowState(): InstanceSelf["window"] {
  if (!ops) return null;
  try {
    return ops.state();
  } catch {
    return null;
  }
}
