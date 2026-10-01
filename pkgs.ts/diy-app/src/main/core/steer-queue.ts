// src/main/core/steer-queue.ts
// 🎯 插话队列（steer）— 用户「插嘴」提交的待投递消息，FIFO，落任务目录 .diy/drafts.yaml
//
// 投递的两种时机（SteerMode，见 core/drafts.ts）—— 差别只在**投递点**，不在条数：
//   next-step —— 下一个模型步边界前注入（本轮内就生效）
//   next-turn —— 本轮收尾后的下一轮开场
// 两者都是**整批投**：一次把队列里符合时机的全部取出（多条合并成同一批），
// 排队 3 条的心愿就是"这三句一起告诉它"；拆成 3 轮只会多 3 次请求、3 个轮次边界。
// 取用都按 FIFO —— 顺序即投递顺序（用户拖过序就按拖过的来）。
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

  /** 切换一条插话的投递时机：next-turn ⇄ next-step。 */
  toggleMode(uri: string, id: string): SteerItem[] {
    const items = this.list(uri).map((it) =>
      it.id === id ? { ...it, mode: it.mode === "next-turn" ? ("next-step" as const) : ("next-turn" as const) } : it,
    );
    this.port.write(uri, items);
    return items;
  }

  /**
   * 重排队列（界面上的拖拽排序）。
   *
   * 入参是**期望的完整顺序**（id 列表），而不是"把 X 移到第 N 位"这类相对指令：
   * 顺序本身就是投递顺序，界面上拖完时它已经算出了目标排列，直接提交这份排列最直白，
   * 也让服务端不必猜"移到第 N 位"在移除源项后该落在哪（这类 ±1 语义是 off-by-one 的温床）。
   *
   * 以**盘上队列为权威**收敛（并发安全）：orderedIds 里不存在的 id 忽略（那条可能刚被投递掉），
   * 盘上有而 orderedIds 没提到的项按原相对顺序**追加到尾部**（可能是刚被别处 add 进来的）——
   * 两条都保证"不因为一次拖拽丢掉用户的话"。
   */
  reorder(uri: string, orderedIds: readonly string[]): SteerItem[] {
    const current = this.list(uri);
    const byId = new Map(current.map((it) => [it.id, it]));
    const next: SteerItem[] = [];
    for (const id of orderedIds) {
      const it = byId.get(id);
      if (it) {
        next.push(it);
        byId.delete(id);
      }
    }
    for (const it of current) if (byId.has(it.id)) next.push(it);
    this.port.write(uri, next);
    return next;
  }

  /** 只读某一模式的全部插话，不动队列（next-step 的批量认领阶段用）。 */
  peekMode(uri: string, mode: SteerMode): SteerItem[] {
    return this.list(uri).filter((it) => it.mode === mode);
  }

  /** 清空队列（清空会话时用：会话都没了，排队中的插话无处可投） */
  clear(uri: string): void {
    this.port.write(uri, []);
  }
}
