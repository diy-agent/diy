// src/renderer_solid/lib/ui-watch.ts
// 🎯 UI 状态变化流的事件源（renderer 侧）—— diy.ui.watch.uiState 的推送端。
//
// 关键设计（为什么不用 store setter / 不用轮询 / 不用时间 settle）：
//   · 边界选「渲染提交后」：Solid 的写入是"通知 + 延迟刷新"，setter 返回时 DOM 还没更新，
//     且同一同步块连续写会合并成一次刷新。挂在 setter 上必然过早（实测见 t223 报告）。
//   · 用 createEffect（用户效应）读 store：Solid 保证同一轮刷 new 里 renderEffect（JSX 的 DOM
//     更新）先跑、createEffect 后跑 —— 所以本效应运行时 DOM 已经反映该快照，无需 sleep/settle。
//   · 快照是**全量**且带单调 rev：消费者按谓词读，不必猜"第几次变化才稳定"。
//
// 语义：订阅那刻先补一帧当前快照（防丢唤醒），之后每次渲染提交推一帧。
// fan-out：每个订阅者独立队列（多个 CLI/测试可同时订阅）。

import { createEffect, createRoot } from "solid-js";
import { tabStore } from "../store/tabStore";
import { taskStore } from "../store/taskStore";

export interface UiSnapshot {
  /** UI 快照序号：每次渲染提交（DOM 已更新）递增。用于「等 rev 变化」的通用屏障。 */
  rev: number;
  /** UI 状态版本：本地 UI 写入（tab/页面/布局…）后递增。 */
  uiRev: number;
  /** 数据版本：任务树/选中任务等**来自 main 的数据**变化后递增（含跨进程链的终点）。
   *  外部「CLI 建任务 → 等界面反映」只需看它，不必建模中间链条。 */
  dataRev: number;
  active: string;
  tabs: { key: string; pageId: string; ctx: string | null; indent: number }[];
  selectedUri: string | null;
  /** 任务树摘要（数据面可见性证据）：节点数与 uri 排序签名 */
  tree: { count: number; sig: string; loading: boolean };
}

/** 极简异步队列：emit → async iterable（对齐 main 侧 file-watcher 的 _AsyncQueue 用法） */
class AsyncQueue<T> {
  private q: T[] = [];
  private resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  push(v: T): void {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) r({ value: v, done: false });
    else this.q.push(v);
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
        if (this.q.length > 0) return Promise.resolve({ value: this.q.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as unknown as T, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

const queues = new Set<AsyncQueue<UiSnapshot>>();
let rev = 0;
let uiRev = 0;
let dataRev = 0;
let prevUiSig = "";
let prevDataSig = "";
let started = false;
let lastSnap: UiSnapshot | null = null;

/** 读一次当前状态并构造快照；**不改**任何计数（纯函数，可安全在 handler 里调用） */
function readState() {
  const nodes = taskStore.nodes;
  // 任务树是 project 节点 + 嵌套 task 节点；签名的粒度要落到**任务**（含状态/标题），
  // 否则只建任务不改项目时签名不变（实测踩过：tree.count 是项目数，恒为 1）。
  const flat: string[] = [];
  const walk = (ns: typeof nodes) => {
    for (const n of ns) {
      if (n.kind === "task" && n.uri) flat.push(`${n.uri}:${n.state ?? ""}:${n.title ?? ""}`);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  const sig = flat.sort().join("|");
  const taskCount = flat.length;
  return {
    active: tabStore.active,
    tabs: tabStore.opened.map((t) => ({
      key: t.key,
      pageId: t.pageId,
      ctx: t.ctx,
      indent: t.taskAncestors?.length ?? 0,
    })),
    selectedUri: taskStore.selectedUri,
    tree: { count: taskCount, sig, loading: taskStore.loading },
  };
}

/** 当前快照（供 handler 做「写后回读」的后置校验；不递增计数） */
export function currentSnapshot(): UiSnapshot {
  if (lastSnap) return lastSnap;
  const st = readState();
  return { rev, uiRev, dataRev, ...st };
}

/** 构造并「提交」一帧：比较 ui/data 签名决定版本是否前进，然后递增 rev */
function commitSnapshot(): UiSnapshot {
  const st = readState();
  const uiSig = st.active + "|" + JSON.stringify(st.tabs) + "|" + st.selectedUri;
  if (uiSig !== prevUiSig) { prevUiSig = uiSig; uiRev++; }
  if (st.tree.sig !== prevDataSig) { prevDataSig = st.tree.sig; dataRev++; }
  lastSnap = { rev: ++rev, uiRev, dataRev, ...st };
  return lastSnap;
}

/**
 * 启动事件源。须在 renderer 初始化时调用一次（createRoot 提供 owner，否则 createEffect 警告）。
 * 幂等。
 */
export function startUiWatch(): void {
  if (started) return;
  started = true;
  createRoot(() => {
    createEffect(() => {
      // 读哪些 signal 决定"何时算变了"：tab 列表/激活 + 任务选中 + 任务树。
      // tabStore.opened 内部会读 taskStore 的任务树（祖先链），故任务树变化也会触发。
      const snap = commitSnapshot();
      for (const q of queues) q.push(snap);
    });
  });
}

export function uiWatchStream(): AsyncIterable<UiSnapshot> {
  const q = new AsyncQueue<UiSnapshot>();
  q.push(currentSnapshot()); // 订阅即得当前态（防丢唤醒）
  queues.add(q);
  return {
    [Symbol.asyncIterator]() {
      const it = q[Symbol.asyncIterator]();
      return {
        next: () => it.next(),
        return: () => {
          queues.delete(q);
          q.close();
          return Promise.resolve({ value: undefined as unknown as UiSnapshot, done: true });
        },
      };
    },
  };
}
