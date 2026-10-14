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

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { opsFile } from "../core/local-paths";
import type { Op } from "./local-blocks";
import { AsyncQueue, withCleanup } from "./async-queue";

/** 订阅帧（`agent.local.opsWatch` 的 yield 形状） */
export type OpsFrame =
  /** 建流首帧：此刻水位。订阅方据此校准 appliedSeq（此后批次从 seq+1 起） */
  | { kind: "hello"; epoch: number; seq: number }
  /** 一段连续 op（`fromSeq` = 首行的行号） */
  | { kind: "batch"; epoch: number; fromSeq: number; ops: Op[] }
  /** 会话被清空（epoch 已换发）→ 订阅方必须重建块树 */
  | { kind: "reset"; epoch: number };

interface TaskFeed {
  epoch: number;
  /** 已写行数（水位）。持有它 = 不必每次 stat 文件 */
  seq: number;
  subs: Set<AsyncQueue<OpsFrame>>;
}

/** 数文件的 `\n` 个数 = 已写行数（sink 每条 op 一行且以 `\n` 结尾） */
function countLines(fp: string): number {
  if (!existsSync(fp)) return 0;
  const fd = openSync(fp, "r");
  try {
    const CHUNK = 256 * 1024;
    const buf = Buffer.allocUnsafe(CHUNK);
    let n = 0;
    let bytes: number;
    // 分块数换行：不整文件读进内存（ops.jsonl 可达几十 MB）
    while ((bytes = readSync(fd, buf, 0, CHUNK, null)) > 0) {
      for (let i = 0; i < bytes; i++) if (buf[i] === 0x0a) n++;
    }
    return n;
  } finally {
    closeSync(fd);
  }
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

  private st(taskUri: string): TaskFeed {
    let s = this.feeds.get(taskUri);
    if (!s) {
      // 水位从**盘上现有内容**起步：本进程可能是在会话已写了一段之后才首次被问水位
      // （例如 UI 打开一个由 CLI 早先写过的会话）。
      s = { epoch: 0, seq: countLines(opsFile(taskUri)), subs: new Set() };
      this.feeds.set(taskUri, s);
    }
    return s;
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
  subscribe(taskUri: string, since: number, epoch?: number): AsyncIterable<OpsFrame> {
    const s = this.st(taskUri);
    const q = new AsyncQueue<OpsFrame>();
    q.push({ kind: "hello", epoch: s.epoch, seq: s.seq });
    if (epoch !== undefined && epoch !== s.epoch) {
      q.push({ kind: "reset", epoch: s.epoch });
    } else if (since < s.seq) {
      const ops = readOpLines(opsFile(taskUri), since + 1, s.seq);
      if (ops.length > 0) q.push({ kind: "batch", epoch: s.epoch, fromSeq: since + 1, ops });
    }
    s.subs.add(q);
    return withCleanup(q, () => {
      s.subs.delete(q);
    });
  }
}

export const opsFeed = new OpsFeed();

// 测试用：读某行区间（导出便于单测边界：UTF-8 跨块、脏行跳过、越界）
export const __test = { readOpLines, countLines };
