// src/shared/hub-approval.ts
// 🎯 全局审批弹窗（##500 续）的**可判定语义** —— 纯函数，组件与单测共用一份。
//
// 为什么单独成模块（同 remote-nav 的教训）：这些是能判定的语义——
//   轮询该不该发（`decideApprovalPoll`）/ 队列怎么合并（`mergeApprovalQueue`）/
//   一行怎么显示（`approvalView`）。埋在组件里就只能起 Electron 看，回归不了。
//
// 弹窗是**跨页面**的：任何页面收到配对申请都要看得见并当场处理（判据 25）。
// 数据源只有 `hub.pending`（读 peers.json，不需要起服务），所以轮询很便宜。

/** 一条待审批申请（与 `diy.hub.pending` 的 data.requests 同形） */
export interface HubPendingRow {
  requestId: string;
  nodeId: string;
  displayName: string;
  requestedAt: string;
}

/** 轮询间隔：3s。审批是低频事件，但人要"立刻"看到 —— 再长会让主控以为没请求。 */
export const APPROVAL_POLL_MS = 3000;

/** 一行的两级文案（一级一句话 + 二级机器信息），与 HubPage 列表同源同形 */
export interface ApprovalView {
  /** 一级：`c-vn7 请求加入` */
  title: string;
  /** 二级：`diy-766dc858 · 14:22:59` */
  subtitle: string;
}

export function approvalView(row: Pick<HubPendingRow, "displayName" | "nodeId" | "requestedAt">): ApprovalView {
  const name = row.displayName.trim() === "" ? row.nodeId : row.displayName.trim();
  return {
    title: `${name} 请求加入`,
    // requestedAt 是本地 ISO（带偏移）；只取时分秒，人跟日志对表时够用
    subtitle: `${row.nodeId} · ${clockOf(row.requestedAt)}`,
  };
}

function clockOf(iso: string): string {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? m[1]! : iso;
}

/**
 * 合并队列：**已在队的保持原顺序**（不让弹窗内容每轮跳动），新请求追加到末尾，
 * 消失的（已批准 / 拒绝 / 被别人处理）移除。纯函数，按 requestId 认身份。
 */
export function mergeApprovalQueue(prev: readonly HubPendingRow[], incoming: readonly HubPendingRow[]): HubPendingRow[] {
  const byId = new Map(incoming.map((r) => [r.requestId, r]));
  const out: HubPendingRow[] = [];
  const seen = new Set<string>();
  for (const r of prev) {
    const next = byId.get(r.requestId);
    if (next) {
      out.push(next);
      seen.add(r.requestId);
    }
  }
  for (const r of incoming) {
    if (!seen.has(r.requestId)) out.push(r);
  }
  return out;
}

export interface PollDecisionInput {
  /** 窗口可见吗（不可见就停 —— 人不在，弹窗也看不见，别消耗 RPC） */
  visible: boolean;
  /** 上一轮还没回来（避免排队堆积） */
  inFlight: boolean;
  /** 上一次开始轮询的时刻（`null` = 还没轮询过） */
  lastPollAt: number | null;
  now: number;
  intervalMs?: number;
}

/** 这一刻该不该发一次 `hub.pending`（判据 26：可见才轮询、串行不重叠） */
export function decideApprovalPoll(input: PollDecisionInput): boolean {
  if (!input.visible) return false;
  if (input.inFlight) return false;
  if (input.lastPollAt === null) return true;
  return input.now - input.lastPollAt >= (input.intervalMs ?? APPROVAL_POLL_MS);
}

/** 一级汇总：`1 个设备请求加入` / `3 个设备请求加入`（弹窗标题用） */
export function approvalHeadline(count: number): string {
  return `${count} 个设备请求加入`;
}
