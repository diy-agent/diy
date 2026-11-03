// src/main/services/ops-feed.ts
// 🎯 会话 op 流的**写侧发布 / 读侧广播**总线（##307：会话可见性读侧）。
//
// 【为什么不需要尾随文件】`ops.jsonl` 的**唯一写入者就是本进程** ——
// LocalAgentManager 的 sink（chat / 排队回执 / 加载自愈）是全部落盘点；CLI 的
// `diy agent local chat` 也是 RPC 客户端，落进的是**同一个 main**。既然「写」这件事
// 就发生在我们手上，增量、行号都是现成的：零时延、零轮询、无需 chokidar 尾随
// （chokidar 对高频 append 有 debounce + awaitWriteFinish 时延，还会漏掉写中途的快照）。
//
// 【契约】
//   · seq = `ops.jsonl` 的**物理行号**（1-based）。该文件 append-only（每 op 一行），
//     故「已写行数」就是水位，`seq+1` 即下一行 —— 与 UI 侧按 seq 去重/补洞同一口径。
//   · epoch = 会话代次。`clear()` 会删掉 ops 文件（行号归零），此时必须换发 epoch，
//     否则订阅方拿着旧 since 撞上新文件（把新会话当旧会话的续写）。
//   · 广播的是**原始 op**（未 compactOps 折叠）：增量无法折叠（折叠需要全量块树），
//     而折叠流与原始流 fold 出的块树等价（见 local-blocks 的 compactOps），混用安全。
//
// 【与 history() 的关系】`history()` 返回折叠流（-98% op 数，大会话快路径），
// 订阅方首载用 history，随后从 watermark() 的水位起订阅增量 —— 两者 fold 同一棵树。

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { streamPath } from "../core/local-paths";
import type { Op } from "./local-blocks";
import { AsyncQueue, withCleanup } from "./async-queue";
import { type OpsFrame } from "../../shared/ops-frame";

export type { OpsFrame };

interface TaskFeed {
  epoch: number;
  /** 已写行数（水位）。持有它 = 不必每次 stat 文件 */
  seq: number;
  subs: Set<AsyncQueue<OpsFrame>>;
}

/**
 * 数文件的 `\n` 个数 = 已写行数（sink 每条 op 一行且以 `\n` 结尾）。
 *
 * ##420：**带缓存**（size + mtime 双判据）。ops.jsonl 可以大到几十万行 / 百 MB ——
 * 每次订阅 / 首次问水位都全文件数一遍是纯浪费（同一次 append 之后 size 必变，故缓存不会陈旧）。
 */
const lineCountCache = new Map<string, { size: number; mtimeMs: number; lines: number }>();
/** 缓存上限（按会话数）：超过就丢最早的一条 —— 它只是个加速器，丢了重数就行 */
const LINE_COUNT_CACHE_MAX = 64;

function countLines(fp: string): number {
  let st: { size: number; mtimeMs: number };
  try {
    st = statSync(fp);
  } catch {
    lineCountCache.delete(fp);
    return 0;
  }
  const hit = lineCountCache.get(fp);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.lines;
  const fd = openSync(fp, "r");
  let n = 0;
  try {
    const CHUNK = 256 * 1024;
    const buf = Buffer.allocUnsafe(CHUNK);
    let bytes: number;
    // 分块数换行：不整文件读进内存（ops.jsonl 可达几十 MB）
    while ((bytes = readSync(fd, buf, 0, CHUNK, null)) > 0) {
      for (let i = 0; i < bytes; i++) if (buf[i] === 0x0a) n++;
    }
  } finally {
    closeSync(fd);
  }
  lineCountCache.delete(fp);
  lineCountCache.set(fp, { size: st.size, mtimeMs: st.mtimeMs, lines: n });
  if (lineCountCache.size > LINE_COUNT_CACHE_MAX) {
    const oldest = lineCountCache.keys().next().value;
    if (oldest !== undefined) lineCountCache.delete(oldest);
  }
  return n;
}

/**
 * 读 `[fromLine, toLine]`（1-based 闭区间）的 op 行。
 *
 * 分块 + `StringDecoder`：块边界会切断多字节 UTF-8 字符，裸 `toString` 会造出替换字符
 * 从而毁掉该行 JSON（中文 tool 输出必然踩到）。`StringDecoder` 把残字节留到下一块。
 */
function readOpLines(fp: string, fromLine: number, toLine: number): Op[] {
  if (toLine < fromLine || !existsSync(fp)) return [];
  const fd = openSync(fp, "r");
  try {
    const CHUNK = 256 * 1024;
    const buf = Buffer.allocUnsafe(CHUNK);
    const dec = new StringDecoder("utf-8");
    const out: Op[] = [];
    let line = 0;
    let carry = "";
    let bytes: number;
    while ((bytes = readSync(fd, buf, 0, CHUNK, null)) > 0) {
      const parts = (carry + dec.write(buf.subarray(0, bytes))).split("\n");
      carry = parts.pop()!; // 末段可能不完整，留到下一块（或收尾）
      for (const p of parts) {
        line++;
        if (line > toLine) return out;
        if (line >= fromLine) {
          const t = p.trim();
          if (t) {
            try {
              out.push(JSON.parse(t) as Op);
            } catch {
              // 半行 / 脏行：跳过（与 readJsonl 同策略，不因一行坏掉整段追加）
            }
          }
        }
      }
    }
    const tail = carry + dec.end();
    if (tail.trim() && line + 1 >= fromLine && line + 1 <= toLine) {
      try {
        out.push(JSON.parse(tail.trim()) as Op);
      } catch {
        /* 同上 */
      }
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

/**
 * 会话 op 流订阅总线（单例）。写侧 `publish` / 读侧 `subscribe`。
 */
class OpsFeed {
  private feeds = new Map<string, TaskFeed>();
  /**
   * 订阅者集合变化回调（**只一个**：会话注册表 ##240）。
   *
   * 为什么需要它：某个会话"此刻有没有人在看"（`viewers`）是注册表的**活态属性**，而它的一半
   * 来源就是本总线的订阅者数。没有这个回调时，窗口开关只改订阅集合、不产生任何事件 ⇒
   * 注册表订阅方（`agent.local.sessions --watch` / 总览页）永远看到陈旧的 viewers，
   * 且「只被打开、从未跑过轮次」的会话**压根不入册**（review1 P2-1 缺口 A/B）。
   *
   * 语义边界：回调**不参与** op 的分发（帧形状 / 水位 / epoch 一概不动，##307 契约不变），
   * 也不改变订阅者本身 —— 它只是"有人变了"的一声通知。
   */
  private onSubsChanged: ((taskUri: string) => void) | null = null;

  /** 登记订阅者变化观察者（传 null 摘除） */
  setSubsChangedListener(cb: ((taskUri: string) => void) | null): void {
    this.onSubsChanged = cb;
  }

  private st(taskUri: string): TaskFeed {
    let s = this.feeds.get(taskUri);
    if (!s) {
      // 水位从**盘上现有内容**起步：本进程可能是在会话已写了一段之后才首次被问水位
      // （例如 UI 打开一个由 CLI 早先写过的会话）。
      // ⚠️ **只读路径**（`streamPath`，不建目录）：本模块的三个出口（`watermark` / `subscribe` /
      // 补发读文）都是**读**，而 `opsFile` 是写侧（`sessionFileForWrite` = 解析 + mkdir）。
      // 用错一次的后果（##444 实测）：UI 一开会话页就问一次水位 ⇒ 每个「看过」的任务
      // 都被建出一个**空会话目录**（本机 256 个新目录里 188 个是空壳，其中 78 个还靠旧平铺回落在读）。
      // 建目录只该发生在真正要写的时候（`opSink` → `createOpsAppender`）。
      s = { epoch: 0, seq: countLines(streamPath(taskUri)), subs: new Set() };
      this.feeds.set(taskUri, s);
    }
    return s;
  }

  /**
   * 当前订阅者数（**不建状态**：该会话没被订阅过就直接 0）。
   *
   * 用途：`agent.local.running` 的可见性标注（##305 / [5] ##308）—— "这个会话此刻有没有人在看"
   * 必须问订阅总线，而不能只看 chat 流的消费端（UI 走的是 op 流，不消费 chat 流）。
   * **不用于任何回收**：##305 定案不做"无人即停"。
   */
  subscriberCount(taskUri: string): number {
    return this.feeds.get(taskUri)?.subs.size ?? 0;
  }

  /** 仅测试用：清空 per-会话缓存（见 `__test.resetFeeds` 的注释）。 */
  resetForTest(): void {
    this.feeds.clear();
  }

  /** 此刻水位（订阅前校准起点用） */
  watermark(taskUri: string): { epoch: number; seq: number } {
    const s = this.st(taskUri);
    return { epoch: s.epoch, seq: s.seq };
  }

  /**
   * 写侧调用：`ops` 已被 `appendFileSync` 落到文件尾 —— 本批占行 `seq+1 .. seq+n`。
   *
   * ⚠️ 必须在**落盘成功之后**调用：落盘失败仍 publish 会让水位与文件错位
   * （此后所有补发/去重都按错位的行号算）。调用方（sink）已保证这一点。
   */
  publish(taskUri: string, ops: readonly Op[]): void {
    if (ops.length === 0) return;
    const existed = this.feeds.has(taskUri);
    const s = this.st(taskUri);
    if (!existed) {
      // ⚠️ 首次建 feed 恰好走 **publish 路径** 时，st() 的 countLines **已含本批** ——
      // sink 的时序是「先 appendFileSync 再 publish」（见 local-agent.opsSink）。基线必须
      // 扣掉本批行数，否则水位全体 +1：实时帧内容无碍，但**断线补发**走的是真实行号，
      // 坐标错位 1 → 重连时丢掉断线期间的第一条 op（review2 R1）。
      // publish 的调用契约就是「本批已落盘」，故此扣减是确定的、非猜测。
      s.seq -= ops.length;
    }
    const fromSeq = s.seq + 1;
    s.seq += ops.length;
    if (s.subs.size === 0) return; // 没人订阅：只推水位，不构造帧
    const frame: OpsFrame = { kind: "batch", epoch: s.epoch, fromSeq, ops: [...ops] };
    for (const q of s.subs) q.push(frame);
  }

  /** 会话被清空（ops 文件已删）→ 换发 epoch、水位归零，并通知订阅方重建 */
  reset(taskUri: string): void {
    const s = this.st(taskUri);
    s.epoch += 1;
    s.seq = 0;
    for (const q of s.subs) q.push({ kind: "reset", epoch: s.epoch });
  }

  /**
   * 订阅某会话的 op 增量。
   *
   * 建流时序（同步、无 await，故无竞态）：
   *   ① hello{epoch, seq} —— 校准帧，永远是首帧；
   *   ② 若订阅方 epoch 与当前不符（会话期间被清空过）→ reset 帧；
   *      否则若 since < seq → 补发 `(since, seq]` 这批（**幂等**：与 history 首载重叠也不怕，
   *      `BlockStore.apply` 对重复 start/patch/stop 都是幂等的）；
   *   ③ 注册订阅，此后 publish 实时推。
   */
  subscribe(
    taskUri: string,
    since: number,
    epoch?: number,
    signal?: AbortSignal,
  ): AsyncIterable<OpsFrame> {
    const s = this.st(taskUri);
    const q = new AsyncQueue<OpsFrame>();
    q.push({ kind: "hello", epoch: s.epoch, seq: s.seq });
    if (epoch !== undefined && epoch !== s.epoch) {
      q.push({ kind: "reset", epoch: s.epoch });
    } else if (since < s.seq) {
      const ops = readOpLines(streamPath(taskUri), since + 1, s.seq);
      if (ops.length > 0) q.push({ kind: "batch", epoch: s.epoch, fromSeq: since + 1, ops });
    }
    s.subs.add(q);
    this.onSubsChanged?.(taskUri); // 订阅集合变了 → 通知观察者（注册表重算 viewers）
    // signal：传输断开时（RPC 层 abort）即时退订 —— 否则悬挂的 next() 会让
    // subs 滞留到**下一条 op**，`subscriberCount`（[5] ##308 的「有没有人在看」）随之虚高。
    return withCleanup(
      q,
      () => {
        s.subs.delete(q);
        this.onSubsChanged?.(taskUri); // 退订同样是一次"谁在看"的变化
      },
      signal,
    );
  }
}

export const opsFeed = new OpsFeed();

// 测试用：读某行区间（导出便于单测边界：UTF-8 跨块、脏行跳过、越界）
/**
 * 仅测试用：清空内存里的 per-会话 feed 缓存（水位/epoch/订阅者集合）。
 *
 * 为什么需要：`--no-isolate`（##402）下模块每个 worker 只求值一次，而各测试文件**自建数据根**
 * （setup 每文件换 DIY_HOME）—— uri 字符串（`projects/1/tasks/1`）会跨文件重复，但盘上文件
 * 已随数据根换了一份。不清缓存，水位就带着上一个文件的记忆。生产里 uri → 文件是一一对应
 * 且进程内不变的，**不存在**这种场景，故这是纯测试钩子。
 */
function resetFeeds(): void {
  opsFeed.resetForTest();
  lineCountCache.clear();
}

export const __test = { readOpLines, countLines, resetFeeds };
