// src/main/services/file-watcher.ts
// 🎯 文件系统监控：监听 state.yaml / task/ / star/ / agents/ 变化，通过回调通知

import { watch, FSWatcher } from "chokidar";
import { join } from "node:path";
import { diyHome } from "../core/state";

export type WatchChangeEvent = "state-change" | "task-change" | "agent-change";

/** 文件系统监控服务。一个进程一个实例。 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;

  /**
   * 启动文件监控，变化时通过 emit 回调通知。
   * 500ms 防抖合并，避免频繁重绘。
   */
  start(emit: (event: WatchChangeEvent) => void): void {
    const home = diyHome();
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    this.watcher = watch(
      [join(home, "state.yaml"), join(home, "task/"), join(home, "star/"), join(home, "agents/")],
      {
        ignoreInitial: true,
        depth: 4,
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      },
    );

    const debouncedEmit = (event: WatchChangeEvent) => {
      if (debounceTimers.has(event)) clearTimeout(debounceTimers.get(event)!);
      debounceTimers.set(
        event,
        setTimeout(() => {
          debounceTimers.delete(event);
          emit(event);
        }, 500),
      );
    };

    this.watcher
      .on("change", (p: string) => {
        if (p.endsWith("state.yaml")) debouncedEmit("state-change");
        else if (p.includes("/task/") || p.includes("/star/")) debouncedEmit("task-change");
        else if (p.includes("/agents/")) debouncedEmit("agent-change");
      })
      .on("addDir", (p: string) => {
        if (p.includes("/task/") || p.includes("/star/")) debouncedEmit("task-change");
      });
  }

  /** 停止监控 */
  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}
