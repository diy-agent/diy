// src/main/core/steer-queue.ts
// 🎯 插话队列（steer）— 用户「插嘴」提交的待投递消息，FIFO，落任务目录 .diy/drafts.yaml
//
// 投递的两种时机（SteerMode，见 core/drafts.ts）：
//   step —— 当前轮的下一个**模型步**之前注入（模型还在跑工具时最贴近"下一步"）；
//           本轮已收尾（模型不再请求工具 / 步数用尽）则**降级**为下一轮的开场白
//   turn —— 当前轮结束后的下一轮（模型已给出答复，只能等下一次对话）
// 两者在"轮末"合流：都按提交顺序（FIFO）一条一条开新一轮 —— 顺序即投递顺序。
//
// 为什么单独一层而不是直接在 local-agent 里读文件：
//   ① 队列语义（FIFO / 按模式取 / 取消）是纯逻辑，可单测，不该埋在 1000 行的 agent 里；
//   ② 存储端口可替换：单测用内存端口，生产用文件端口（同一个 .diy/drafts.yaml）。
//
// 与草稿字段的关系：同一个文件、同一份「丢了 = 用户白打」的数据，但队列是**整表替换**
// 语义（顺序即投递顺序，合并会打乱它），所以只共用存储，不共用合并逻辑。

import { STEER_MODES, readDrafts, writeSteers, type SteerItem, type SteerMode } from "./drafts";

/** 插话 id 的前缀：形如 `steer/1`、`steer/2`（"实体/序号"，见仓库约定的 id 风格） */
export const STEER_ID_PREFIX = "steer/";

/** 队列里最大序号（无匹配 / 空队列 = 0） */
function maxSeq(items: readonly SteerItem[]): number {
  let max = 0;
  for (const it of items) {
    // 只认完整形式 `steer/<十进制>`：手工写进文件的怪 id（如 "steer/1x"、"s1"）不参与计数，
    // 否则一次误写会让后续序号跳到奇怪的值
    const m = /^steer\/(\d+)$/.exec(it.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** 队列存储端口（单测注入内存实现；生产就是任务目录里的 drafts.yaml） */
export interface SteerQueuePort {
  read(uri: string): SteerItem[];
  write(uri: string, items: SteerItem[]): void;
}

/** 生产端口：与草稿同文件（readDrafts 已解析 steers） */
export const fileSteerPort: SteerQueuePort = {
  read: (uri) => readDrafts(uri)?.steers ?? [],
  write: (uri, items) => {
    writeSteers(uri, items);
  },
};

/**
 * 队列项 id：`steer/<序号>`，序号 = 当前队列最大序号 + 1。
 *
 * 为什么用递增序号而不是随机串：id 要**给人看**（CLI 里 `steer cancel steer/2`、
 * 横条与日志里对号入座），也要给 agent 看（`steer list` 的输出就是它要操作的目标）。
 * 随机串在这两处都只能靠复制粘贴。
 *
 * 编号只保证**队列内唯一**（同一时刻可用于定位即可）；取消/投递后序号不回退，
 * 队列清空后再来又是 `steer/1` —— 历史日志里的旧 `steer/1` 与它不同时存在，不构成歧义。
 */
export function newSteerId(items: readonly SteerItem[]): string {
  return `${STEER_ID_PREFIX}${maxSeq(items) + 1}`;
}

export class SteerQueue {
  constructor(private readonly port: SteerQueuePort = fileSteerPort) {}

  /** 队列快照（顺序 = 投递顺序） */
  list(uri: string): SteerItem[] {
    return this.port.read(uri);
  }

  has(uri: string, mode?: SteerMode): boolean {
    return this.list(uri).some((it) => mode === undefined || it.mode === mode);
  }

  /** 入队（FIFO 尾部）。空内容直接拒绝：空插话投进去只会污染提示词 */
  add(uri: string, mode: SteerMode, text: string, now: Date = new Date()): SteerItem[] {
    const body = text.trim();
    if (!body) throw new Error("插话内容为空");
    if (!(STEER_MODES as readonly string[]).includes(mode)) {
      throw new Error(`未知插话模式 ${String(mode)}（合法值：${STEER_MODES.join("/")}）`);
    }
    // 先读队列再算 id（读→写之间没有 await，JS 单线程下不会被别的 add 插进来）
    const existing = this.port.read(uri);
    const item: SteerItem = { id: newSteerId(existing), mode, text: body, created: now.toISOString() };
    const items = [...existing, item];
    this.port.write(uri, items);
    return items;
  }

  /** 取消一条（不存在时幂等返回原队列：重复点✕不该报错） */
  remove(uri: string, id: string): SteerItem[] {
    const items = this.list(uri).filter((it) => it.id !== id);
    this.port.write(uri, items);
    return items;
  }

  /**
   * 只看队首，**不动队列**（"认领"用）。
   *
   * 与 takeFirst 的区别就是"删不删"：step 模式的插话要经两步 ——
   * ① `prepareStep`（SDK 回调）认领并注入请求 messages；
   * ② 流里出现 `start-step` 时才真正落位（写进 ops + 出队）。
   * 两步之间**不能**提前出队：那一刻它还没进对话流，出队后就只剩"内存里的一份"，
   * 进程在这中间挂掉就是真丢（用户白打）。留在队列里最坏是"下次再投一遍"（可恢复）。
   */
  peekFirst(uri: string, mode?: SteerMode): SteerItem | undefined {
    const items = this.list(uri);
    return mode === undefined ? items[0] : items.find((it) => it.mode === mode);
  }

  /**
   * 取出队首（并落盘删除）—— 投递的唯一入口。
   *
   * 取出的同时就写盘：投递是「一次性的」，不能出现「模型看见了、文件里还留着」
   * （那会让下一次投递把同一句插话再发一遍）。写入失败会抛错，调用方不得静默忽略。
   */
  takeFirst(uri: string, mode?: SteerMode): SteerItem | undefined {
    const items = this.list(uri);
    const idx = mode === undefined ? (items.length > 0 ? 0 : -1) : items.findIndex((it) => it.mode === mode);
    if (idx < 0) return undefined;
    const [item] = items.splice(idx, 1);
    this.port.write(uri, items);
    return item;
  }

  /** 清空队列（清空会话时用：会话都没了，排队中的插话无处可投） */
  clear(uri: string): void {
    this.port.write(uri, []);
  }
}
