/**
 * 会话 op 增量订阅的帧形状（`agent.local.opsWatch` 的 yield 形状）。
 *
 * ##307：main（`services/ops-feed.ts`）与 renderer（`store/localChatStore.ts`）此前**各定义一份**，
 * 易漂移；上移 shared 使两端共用同一判别联合（review3 备记）。
 */
import type { Op } from "../main/services/local-blocks";

export type OpsFrame =
  /** 建流首帧：此刻水位。订阅方据此校准 appliedSeq（此后批次从 seq+1 起） */
  | { kind: "hello"; epoch: number; seq: number }
  /** 一段连续 op（`fromSeq` = 首行的行号） */
  | { kind: "batch"; epoch: number; fromSeq: number; ops: Op[] }
  /** 会话被清空（epoch 已换发）→ 订阅方必须重建块树 */
  | { kind: "reset"; epoch: number };
