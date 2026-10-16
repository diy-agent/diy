// src/main/services/file-watcher.ts
// 🎯 文件系统监控：监听 projects/ 等路径变化，通过 subscribe() 返回 AsyncIterable
//    fan-out：多个 RPC serverStream 消费者各自拿到独立的事件流（AsyncQueue 桥接）。
//    首个订阅者到达时启动 chokidar，最后一个取消后自动关闭（省资源）。

import { watch, FSWatcher } from "chokidar";
import { join } from "node:path";
import { diyHome } from "../core/state";
import { AsyncQueue, withCleanup } from "./async-queue";

export type WatchChangeEvent = "state-change" | "task-change" | "agent-change";

export interface FileChangeEvent {
  event: WatchChangeEvent;
  ts: number;
}

/** chokidar 会发给我们的事件名（本模块只关心这 5 个） */
export type WatchFsEvent = "add" | "addDir" | "change" | "unlink" | "unlinkDir";

/** 项目元数据：projects/<pid>/meta.yaml（改名 / 换路径 / 标签 → 树上的项目节点要跟着变） */
const PROJECT_META_RE = /\/projects\/[^/]+\/meta\.yaml$/;

/** 任务树真正依赖的路径：任务文档本身，或 tasks/ 下任何东西（任务目录 = tasks/<tid>） */
const isTaskDoc = (p: string): boolean => p.endsWith("AGENTS.md") || p.includes("/tasks/");

/**
 * 把 chokidar 的一次文件系统事件分类成本应用关心的三种变更（纯函数；闸门只此一处）。
 *
 * 为什么必须收成一函数（真实故障，见 ##361）：目录**整棵**被删（`task delete` 的
 * rmSync / 手工 `rm -rf`）时，chokidar 报的是 `unlinkDir` —— 原先只挂了 `unlink`
 * 且判据只认 AGENTS.md，于是这类删除一条事件都不认 → 不发 task-change → 树不重载
 * → nav 上那一行留着（点进去永远「加载中…」）。
 * 更早还有一处**判据不对称**：`change` 分支用 isTaskDoc（认 /tasks/ 下任意路径），
 * `unlink` 却只认 AGENTS.md。同一件事在两处判据不同 → 迟早只修好一半。
 *
 * 故：写 / 删 / 建 全部走同一判据；目录增删（addDir / unlinkDir）只要落在 projects/
 * 下就重载树（新建任务目录、删除任务或项目目录都是树形变化）。
 * 非任务路径（如 projects/<pid>/template/*.md 的保存）一律不触发 —— 曾经的 catch-all
 * 会让「保存一次提示词模版」也重载任务树（名不副实 + 日志噪音）。
 */
export function classifyWatchEvent(ev: WatchFsEvent, p: string): WatchChangeEvent | null {
  if (p.endsWith("state.yaml")) return ev === "change" ? "state-change" : null;
  if (p.includes("/projects/")) {
    if (ev === "addDir" || ev === "unlinkDir") return "task-change";
    if (ev === "change") return PROJECT_META_RE.test(p) || isTaskDoc(p) ? "task-change" : null;
    return isTaskDoc(p) ? "task-change" : null; // add / unlink：与 change 判据对齐
  }
  if (p.includes("/agents/")) return ev === "change" ? "agent-change" : null;
  return null;
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
  private queues = new Set<AsyncQueue<FileChangeEvent>>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * 订阅文件变更事件流（RPC serverStream 直接 yield 此 async iterable）。
   *
   * `signal`（RPC 传输断开）必传：无变更事件期间断连时，消费端的 `return()` 会悬挂在
   * 未决的 `next()` 后，订阅要等下一条文件事件才释放（末订阅者的 chokidar 也跟着多活）。
   */
  subscribe(signal?: AbortSignal): AsyncIterable<FileChangeEvent> {
    const q = new AsyncQueue<FileChangeEvent>();
    this.queues.add(q);
    if (this.queues.size === 1) this._start();
    // 消费端 return()（close/abort）→ 移除订阅；末订阅者走后关掉 chokidar
    return withCleanup(
      q,
      () => {
        this.queues.delete(q);
        if (this.queues.size === 0) this._stop();
      },
      signal,
    );
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
    // 事件分类只经 classifyWatchEvent（判据单源，见其注释）：五个事件一视同仁地过它，
    // 避免「change 认 /tasks/、unlink 只认 AGENTS.md」这类不对称再次出现。
    const FS_EVENTS: WatchFsEvent[] = ["add", "addDir", "change", "unlink", "unlinkDir"];
    for (const ev of FS_EVENTS) {
      this.watcher.on(ev, (p: string) => {
        const cls = classifyWatchEvent(ev, p);
        if (cls) this._emit(cls);
      });
    }
  }

  private _stop(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }
}

export const fileWatcher = new FileWatcher();
