/**
 * 会话/轮次注册表的帧形状（`agent.local.sessions` 的 yield 形状，别名 `sessionsWatch`）。
 *
 * 设计（##240，用户 2026-10-15 定稿 · rule.core-log）：
 *   · **状态 ⊥ 内容** —— 这里只搬注册表状态；对话内容走 `opsWatch`（每会话、带 seq/epoch，
 *     见 shared/ops-frame.ts）。两条流不混。
 *   · **无水位** —— 注册表是「快照 + delta」，订阅首帧即全量，此后只推有变的条目
 *     （与 ops 的水位/补发语义**不同**：状态可随时重放整份，没有"漏了一段"的概念）。
 *   · 判别联合 = `{kind, …}`（对齐 ops-frame 风格），新增帧型只需加一个 kind（留 ##108 缝）。
 */

import type { TurnEndReason } from "../main/services/local-blocks";

/**
 * 会话的横向引用（R4：会话 id 不绑 taskUri，关系进 refs）。
 *
 * 本任务只落数据形状：`kind:"task"` 的 resolver（显示名 / 导航）必备；`plugin` 等**只留形状**，
 * resolver 注册机制不做（用户 2026-10-15：避免过度设计）。
 */
export interface SessionRef {
  /** 引用实体类型（`task` 已落地；`plugin` / `agent` / `workflow` 等只保留数据形状） */
  kind: string;
  /** 实体标识：`task` = 任务 URI（如 `projects/4/tasks/240`）；
   *  `plugin` = 复合 id，三段另见 `plugin` / `entity`（`uri` 仍是"这一次引用的唯一定位串"） */
  uri: string;
  /** 显示名（resolver 给出；缺省 = 渲染端退回 uri） */
  label?: string;
  /**
   * 插件类引用的三段（用户 2026-10-15 设想：`{kind:"plugin", plugin:"x", entity:"someEntityId", id:"xxx"}`）。
   *
   * 本任务只落**数据形状**（resolver 注册机制不做，见 body §5）：留出位置，插件会话接入时不必
   * 破坏性改形状。`plugin` = 插件名，`entity` = 插件内实体类别；最末的实体 id 仍在 `uri` 里
   * （于是 `{kind:"plugin", plugin, entity, uri}` 就是完整三段，读侧只认 `uri` 也不会瞎）。
   */
  plugin?: string;
  entity?: string;
}

/** 在途轮次（`turn:null` = 此刻没有轮次在跑，即 idle —— R5：条目仍在，只清 turn） */
export interface SessionTurn {
  turnId: string;
  /** 已跑步数 */
  steps: number;
  /** 本轮累计 tokens（接 ##227 账本口径） */
  tokens: number;
  /** 心跳：最后一次活动时刻（卡死判据的输入之一） */
  lastOpAt: string;
  /** 轮次起始时刻（`agent.local.running` 的 `since` 同源；与 lastOpAt 不同：它不随步进变） */
  startedAt: string;
  /** 本轮用的模型（与 `agent.local.running` 字段对齐 —— 总览页要显示"哪个模型在跑"） */
  model?: string;
  /** 本轮的工作目录（同上，回答"哪个项目在跑"） */
  cwd?: string;
  /** `detached` = 有轮次在跑但此刻无观察者（viewers=0）；它**不是**回收判据（##305） */
  state: "active" | "detached";
}

/** 注册表条目（一条会话 = 一个条目；键是会话 id，不是 taskUri） */
export interface SessionEntry {
  /** 会话 id（独立于 taskUri，见 R4；当前 = `local-<keyOf(taskUri)>`） */
  id: string;
  /** 横向引用（谁与这个会话有关） */
  refs: SessionRef[];
  /** 在途轮次；null = idle */
  turn: SessionTurn | null;
  /** 待投递留言条数（##306 steer 队列）—— 活态属性，不进状态轴 */
  queue: number;
  /** 此刻的观察者数（chat 流 + op 流订阅者；**注册表自身订阅者不计入**，R3） */
  viewers: number;
  /** 本进程内首次见到该会话的时刻（= "本次启动活跃过"的边界，R5：不落盘） */
  firstSeenAt: string;
  /** 最后一次活动时刻 */
  lastActivity: string;
  /** 本进程内已完成的轮次数 */
  turnCount: number;
  /** 最后一轮的结束原因（`--watch` 里「working → idle」那一步的可读证据） */
  lastEndReason: TurnEndReason | null;
  /** 本进程内累计步数 / tokens（跨轮累计；三续要求） */
  totalSteps: number;
  totalTokens: number;
}

/**
 * 注册表订阅帧：
 *   · `snapshot` 建流首帧：此刻全部条目（= 「本次启动后活跃过」的全量）
 *   · `upsert`   一条条目新增 / 字段变更（推**完整条目**，订阅方按 id 覆盖）
 *   · `remove`   条目消失（留缝：当前实现只在进程退出时整体消失，不产此帧）
 */
export type RegistryFrame =
  | { kind: "snapshot"; entries: SessionEntry[] }
  | { kind: "upsert"; entry: SessionEntry }
  | { kind: "remove"; id: string };
