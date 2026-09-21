// src/main/services/file-watcher.ts
// 🎯 文件系统监控：监听 projects/ 等路径变化，通过 subscribe() 返回 AsyncIterable
//    fan-out：多个 RPC serverStream 消费者各自拿到独立的事件流（AsyncQueue 桥接）。
//    首个订阅者到达时启动 chokidar，最后一个取消后自动关闭（省资源）。

import { watch, FSWatcher } from "chokidar";
import { join } from "node:path";
import { diyHome } from "../core/state";

export type WatchChangeEvent = "state-change" | "task-change" | "agent-change";

export interface FileChangeEvent {
  event: WatchChangeEvent;
  ts: number;
}

// ── AsyncQueue：桥接 emit 回调 → async iterable（供 RPC serverStream yield） ──

class _AsyncQueue<T> {
  private q: T[] = [];
  private resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  push(v: T): void {
    if (this.closed) return;
    if (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: v, done: false });
    } else {
      this.q.push(v);
    }
  }

  close(): void {
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.q.length > 0) {
          return Promise.resolve({ value: this.q.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

// ── FileWatcher：单例，按需启停 chokidar ──

/**
 * 文件系统监控服务（单例模式）。
 *
 * 监听 $DIY_HOME 下的三大区域：
 *   - state.yaml  → state-change（项目注册变更）
 *   - projects/   → task-change（任务文件增删改）
 *   - agents/     → agent-change（agent 配置变更）
 *
 * 不监听旧路径 task/（已废弃布局残留，数据早已在 projects/<pid>/tasks/<tid>/）。
 * depth=5 足够覆盖 projects/<pid>/tasks/<tid>/AGENTS.md + .diy/ 两层。
 *
 * 用法：`for await (const change of fileWatcher.subscribe()) { ... }`，
 * 消费者 close/abort 后自动移除订阅，最后一个取消后 chokidar 关闭。
 */
class FileWatcher {
  private watcher: FSWatcher | null = null;
  private queues = new Set<_AsyncQueue<FileChangeEvent>>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** 订阅文件变更事件流（RPC serverStream 直接 yield 此 async iterable）。 */
  subscribe(): AsyncIterable<FileChangeEvent> {
    const q = new _AsyncQueue<FileChangeEvent>();
    this.queues.add(q);
    if (this.queues.size === 1) this._start();

    return {
      [Symbol.asyncIterator]: () => {
        // 异步移除订阅（消费者 close 后 q.next() → done:true，消费者退出，再执行此 finally）
        const cleanup = () => {
          this.queues.delete(q);
          if (this.queues.size === 0) this._stop();
        };
        const inner = q[Symbol.asyncIterator]();
        return {
          next: () => inner.next().then((r) => { if (r.done) cleanup(); return r; }),
          return: () => { cleanup(); return Promise.resolve({ value: undefined, done: true as const }); },
        };
      },
    };
  }

  private _emit(event: WatchChangeEvent): void {
    if (this.debounceTimers.has(event)) clearTimeout(this.debounceTimers.get(event)!);
    this.debounceTimers.set(
      event,
      setTimeout(() => {
        this.debounceTimers.delete(event);
        for (const q of this.queues) q.push({ event, ts: Date.now() });
      }, 500),
    );
  }

  private _start(): void {
    const home = diyHome();
    this.watcher = watch(
      [join(home, "state.yaml"), join(home, "projects/"), join(home, "agents/")],
      { ignoreInitial: true, depth: 5, persistent: true, awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 } },
    );
    this.watcher
      .on("change", (p: string) => {
        if (p.endsWith("state.yaml")) this._emit("state-change");
        else if (p.includes("/projects/")) {
          // 只有任务树真正依赖的路径才重载：项目元数据 / tasks/ 下的任务数据。
          // 曾经的 catch-all（projects/ 下任何 change）会让「保存一次提示词模版」
          // （projects/<id>/template/*.md）也触发任务树重载 —— 名不副实 + 日志噪音。
          const isProjectMeta = /\/projects\/[^/]+\/meta\.yaml$/.test(p);
          const isTaskDoc = p.endsWith("AGENTS.md") || p.includes("/tasks/");
          if (isProjectMeta || isTaskDoc) this._emit("task-change");
        } else if (p.includes("/agents/")) this._emit("agent-change");
      })
      .on("addDir", (p: string) => { if (p.includes("/projects/")) this._emit("task-change"); })
      .on("add",    (p: string) => { if (p.endsWith("AGENTS.md")) this._emit("task-change"); })
      .on("unlink", (p: string) => { if (p.endsWith("AGENTS.md")) this._emit("task-change"); });
  }

  private _stop(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }
}

export const fileWatcher = new FileWatcher();
