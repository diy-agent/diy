// src/main/core/steer-queue.ts
// 🎯 插话队列（steer）— 用户「插嘴」提交的待投递消息，FIFO，落任务目录 .diy/drafts.yaml
//
// 两种投递时机（SteerMode，见 core/drafts.ts）：
//   step —— 当前轮的下一个模型步之前注入（模型还在跑工具时最贴近"下一步"）
//   turn —— 当前轮结束后的下一轮（模型已给出答复，只能等下一次对话）
//
// 为什么单独一层而不是直接在 local-agent 里读文件：
//   ① 队列语义（FIFO / 按模式取 / 取消）是纯逻辑，可单测，不该埋在 1000 行的 agent 里；
//   ② 存储端口可替换：单测用内存端口，生产用文件端口（同一个 .diy/drafts.yaml）。
//
// 与草稿字段的关系：同一个文件、同一份「丢了 = 用户白打」的数据，但队列是**整表替换**
// 语义（顺序即投递顺序，合并会打乱它），所以只共用存储，不共用合并逻辑。

import { randomBytes } from "node:crypto";
import { STEER_MODES, readDrafts, writeSteers, type SteerItem, type SteerMode } from "./drafts";

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

/** 队列项 id：时间前缀便于人读（排查时能看出先后），随机后缀保证同毫秒多次提交不撞 */
export function newSteerId(now: number = Date.now()): string {
  return `s${now.toString(36)}${randomBytes(3).toString("hex")}`;
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
    const item: SteerItem = { id: newSteerId(now.getTime()), mode, text: body, created: now.toISOString() };
    const items = [...this.port.read(uri), item];
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
